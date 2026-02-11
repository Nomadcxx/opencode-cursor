// cmd/installer/tasks.go
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
)

func parseCursorModelsOutput(clean string) (map[string]interface{}, error) {
	// More permissive regex: allows uppercase, underscores, and various separators
	// Pattern: model-id followed by separator and display name
	lineRegex := regexp.MustCompile(`^([a-zA-Z0-9._-]+)\s+[-–—:]\s+(.+?)(?:\s+\((current|default)\))*\s*$`)
	models := make(map[string]interface{})

	lines := strings.Split(clean, "\n")
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "Available") || strings.HasPrefix(line, "Tip:") {
			continue
		}
		matches := lineRegex.FindStringSubmatch(line)
		if len(matches) >= 3 {
			id := matches[1]
			name := strings.TrimSpace(matches[2])
			models[id] = map[string]interface{}{"name": name}
		}
	}

	if len(models) == 0 {
		return nil, fmt.Errorf("regex matched 0 of %d lines", len(lines))
	}

	return models, nil
}

// fetchCursorModels calls cursor-agent models and parses the output
func fetchCursorModels() (map[string]interface{}, error) {
	variants := [][]string{
		{"models"},
		{"--list", "models"},
	}

	ansiRegex := regexp.MustCompile(`\x1b\[[0-9;]*[a-zA-Z]`)
	var lastErr error
	var lastClean string

	for _, args := range variants {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		cmd := exec.CommandContext(ctx, "cursor-agent", args...)
		output, err := cmd.CombinedOutput()
		cancel()

		if err != nil {
			lastErr = NewExecError(
				fmt.Sprintf("cursor-agent %s failed", strings.Join(args, " ")),
				string(output),
				err,
			)
			continue
		}

		clean := ansiRegex.ReplaceAllString(string(output), "")
		lastClean = clean

		models, parseErr := parseCursorModelsOutput(clean)
		if parseErr == nil {
			return models, nil
		}

		lastErr = NewParseError(
			"no models found in cursor-agent output",
			clean,
			parseErr,
		)
	}

	if lastErr != nil {
		return nil, lastErr
	}

	return nil, NewParseError("failed to fetch models from cursor-agent", lastClean, fmt.Errorf("all command variants failed"))
}

func isMissingModuleBuildError(err error) bool {
	var installerErr *InstallerError
	if errors.As(err, &installerErr) {
		output := strings.ToLower(installerErr.RawOutput)
		if strings.Contains(output, "could not resolve") ||
			strings.Contains(output, "maybe you need to \"bun install\"") ||
			strings.Contains(output, "cannot find package") {
			return true
		}
	}

	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "could not resolve") ||
		strings.Contains(msg, "cannot find package") ||
		strings.Contains(msg, "bun install")
}

func (m model) startInstallation() (tea.Model, tea.Cmd) {
	m.step = stepInstalling

	m.tasks = []installTask{
		{name: "Check prerequisites", description: "Verifying bun and cursor-agent", execute: checkPrerequisites, status: statusPending},
		{name: "Build plugin", description: "Running bun install && bun run build", execute: buildPlugin, status: statusPending},
		{name: "Install AI SDK", description: "Adding @ai-sdk/openai-compatible to opencode", execute: installAiSdk, status: statusPending},
		{name: "Create symlink", description: "Linking to OpenCode plugin directory", execute: createSymlink, status: statusPending},
		{name: "Update config", description: "Adding cursor-acp plugin to opencode.json", execute: updateConfig, status: statusPending},
		{name: "Validate config", description: "Checking JSON syntax", execute: validateConfig, status: statusPending},
		{name: "Verify plugin loads", description: "Checking if plugin appears in opencode", execute: verifyPostInstall, optional: true, status: statusPending},
	}

	m.currentTaskIndex = 0
	m.tasks[0].status = statusRunning
	return m, tea.Batch(m.spinner.Tick, executeTaskCmd(0, &m))
}

func executeTaskCmd(index int, m *model) tea.Cmd {
	return func() tea.Msg {
		if index >= len(m.tasks) {
			return taskCompleteMsg{index: index, success: true}
		}

		task := &m.tasks[index]
		err := task.execute(m)

		if err != nil {
			return taskCompleteMsg{
				index:   index,
				success: false,
				err:     err.Error(),
			}
		}

		return taskCompleteMsg{index: index, success: true}
	}
}

func checkPrerequisites(m *model) error {
	if !commandExists("bun") {
		return fmt.Errorf("bun not found - install with: curl -fsSL https://bun.sh/install | bash")
	}
	if !commandExists("cursor-agent") {
		return fmt.Errorf("cursor-agent not found - install with: curl -fsS https://cursor.com/install | bash")
	}
	return nil
}

func buildPlugin(m *model) error {
	// Run bun install
	installCmd := exec.Command("bun", "install")
	installCmd.Dir = m.projectDir
	if err := runCommand("bun install", installCmd, m.logFile); err != nil {
		return err
	}

	// Run bun run build
	buildCmd := exec.Command("bun", "run", "build")
	buildCmd.Dir = m.projectDir
	if err := runCommand("bun run build", buildCmd, m.logFile); err != nil {
		if !isMissingModuleBuildError(err) {
			return err
		}

		// Recovery path for stale/broken node_modules where bun install did not restore all packages.
		repairCmd := exec.Command("bun", "install", "--force", "--no-cache")
		repairCmd.Dir = m.projectDir
		if repairErr := runCommand("bun install --force --no-cache", repairCmd, m.logFile); repairErr != nil {
			return repairErr
		}

		retryBuildCmd := exec.Command("bun", "run", "build")
		retryBuildCmd.Dir = m.projectDir
		if retryErr := runCommand("bun run build (retry)", retryBuildCmd, m.logFile); retryErr != nil {
			return retryErr
		}
	}

	// Verify dist/plugin-entry.js exists (plugin-only entrypoint)
	distPath := filepath.Join(m.projectDir, "dist", "plugin-entry.js")
	info, err := os.Stat(distPath)
	if err != nil || info.Size() == 0 {
		return fmt.Errorf("dist/plugin-entry.js not found or empty after build")
	}

	return nil
}

func installAiSdk(m *model) error {
	configDir, err := getConfigDir()
	if err != nil {
		return NewConfigError("failed to determine config directory", "", err)
	}

	opencodeDir := filepath.Join(configDir, "opencode")

	if err := os.MkdirAll(opencodeDir, 0755); err != nil {
		return NewConfigError("failed to create opencode directory", opencodeDir, err)
	}

	installCmd := exec.Command("bun", "install", "@ai-sdk/openai-compatible")
	installCmd.Dir = opencodeDir
	if err := runCommand("bun install @ai-sdk/openai-compatible", installCmd, m.logFile); err != nil {
		return err
	}

	return nil
}

func installAcpSdk(m *model) error {
	if err := createBackup(m, m.configPath); err != nil {
		return fmt.Errorf("failed to backup config: %w", err)
	}

	configDir, _ := getConfigDir()
	opencodeNodeModules := filepath.Join(configDir, "opencode", "node_modules")

	acpPath := filepath.Join(opencodeNodeModules, "@agentclientprotocol", "sdk")
	if _, err := os.Stat(acpPath); err == nil {
		return nil
	}

	packageJsonPath := filepath.Join(configDir, "opencode", "package.json")
	if err := createBackup(m, packageJsonPath); err != nil {
		return fmt.Errorf("failed to backup package.json: %w", err)
	}

	installCmd := exec.Command("bun", "add", "@agentclientprotocol/sdk@^0.13.1")
	installCmd.Dir = filepath.Join(configDir, "opencode")
	if err := runCommand("bun add @agentclientprotocol/sdk", installCmd, m.logFile); err != nil {
		cleanupBackups(m)
		return fmt.Errorf("failed to install ACP SDK: %w", err)
	}

	return nil
}

func createSymlink(m *model) error {
	// Ensure plugin directory exists (e.g. ~/.config/opencode/plugin)
	if err := os.MkdirAll(m.pluginDir, 0755); err != nil {
		return fmt.Errorf("failed to create plugin directory: %w", err)
	}

	// Create symlink in OpenCode's plugin directory
	symlinkPath := filepath.Join(m.pluginDir, "cursor-acp.js")

	// Remove existing symlink if present
	if _, err := os.Lstat(symlinkPath); err == nil {
		os.Remove(symlinkPath)
	}

	// Create symlink to built plugin entry
	distPath := filepath.Join(m.projectDir, "dist", "plugin-entry.js")
	if err := os.Symlink(distPath, symlinkPath); err != nil {
		return fmt.Errorf("failed to create symlink: %w", err)
	}

	// Verify symlink resolves
	if _, err := os.Stat(symlinkPath); err != nil {
		return fmt.Errorf("symlink verification failed: %w", err)
	}

	return nil
}

func updateConfig(m *model) error {
	// Persist a timestamped backup for recovery outside the installer process
	_ = backupConfigToDisk(m.configPath)
	if err := createBackup(m, m.configPath); err != nil {
		return fmt.Errorf("failed to backup config: %w", err)
	}

	var config map[string]interface{}

	data, err := os.ReadFile(m.configPath)
	if err != nil {
		if !os.IsNotExist(err) {
			return fmt.Errorf("failed to read config: %w", err)
		}
		config = make(map[string]interface{})
	} else {
		if err := json.Unmarshal(data, &config); err != nil {
			return fmt.Errorf("failed to parse config: %w", err)
		}
	}

	// Ensure provider section exists
	providers, ok := config["provider"].(map[string]interface{})
	if !ok {
		providers = make(map[string]interface{})
		config["provider"] = providers
	}

	// Fetch models dynamically from cursor-agent
	models, err := fetchCursorModels()
	if err != nil {
		return fmt.Errorf("failed to fetch models from cursor-agent: %w", err)
	}

	// Add cursor-acp provider (merge with existing to preserve user config)
	existingCursorAcp, ok := providers["cursor-acp"].(map[string]interface{})
	if !ok {
		// If cursor-acp exists but isn't a map, user config is malformed
		if providers["cursor-acp"] != nil {
			return fmt.Errorf("cursor-acp provider has invalid type (expected object, got %T)", providers["cursor-acp"])
		}
		existingCursorAcp = make(map[string]interface{})
	}

	// Only set name if not already present (preserve user customization)
	if _, hasName := existingCursorAcp["name"]; !hasName {
		existingCursorAcp["name"] = "Cursor Agent (ACP stdin)"
	}

	// Always update models list (this is what installer needs to ensure)
	existingCursorAcp["models"] = models

	// Ensure options.baseURL is set so OpenCode never builds "undefined/chat/completions"
	const defaultBaseURL = "http://127.0.0.1:32124/v1"
	opts, _ := existingCursorAcp["options"].(map[string]interface{})
	if opts == nil {
		opts = make(map[string]interface{})
		existingCursorAcp["options"] = opts
	}
	if _, hasBaseURL := opts["baseURL"]; !hasBaseURL {
		opts["baseURL"] = defaultBaseURL
	}

	// Preserve any other user fields (npm, etc.)
	providers["cursor-acp"] = existingCursorAcp

	// Ensure plugin array exists and add cursor-acp
	plugins, ok := config["plugin"].([]interface{})
	if !ok {
		plugins = []interface{}{}
	}

	// Check if cursor-acp is already in the plugin list
	hasPlugin := false
	for _, p := range plugins {
		if p == "cursor-acp" {
			hasPlugin = true
			break
		}
	}

	if !hasPlugin {
		plugins = append(plugins, "cursor-acp")
		config["plugin"] = plugins
	}

	// Write config back
	output, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to serialize config: %w", err)
	}

	// Ensure config directory exists
	if err := os.MkdirAll(filepath.Dir(m.configPath), 0755); err != nil {
		return fmt.Errorf("failed to create config directory: %w", err)
	}

	if err := os.WriteFile(m.configPath, output, 0644); err != nil {
		return fmt.Errorf("failed to write config: %w", err)
	}

	return nil
}

func validateConfig(m *model) error {
	if err := validateJSON(m.configPath); err != nil {
		return NewValidationError("config validation failed", m.configPath, err)
	}

	data, err := os.ReadFile(m.configPath)
	if err != nil {
		return NewConfigError("failed to read config for validation", m.configPath, err)
	}

	var config map[string]interface{}
	if err := json.Unmarshal(data, &config); err != nil {
		return NewConfigError("failed to parse config JSON", m.configPath, err)
	}

	providers, ok := config["provider"].(map[string]interface{})
	if !ok {
		return NewValidationError("provider section missing from config", m.configPath, nil)
	}

	if _, exists := providers["cursor-acp"]; !exists {
		return NewValidationError("cursor-acp provider not found in config", m.configPath, nil)
	}

	return nil
}

func verifyPlugin(m *model) error {
	// Try to load plugin with node to catch syntax/import errors
	pluginPath := filepath.Join(m.projectDir, "dist", "plugin-entry.js")
	cmd := exec.Command("node", "-e", fmt.Sprintf(`require("%s")`, pluginPath))
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("plugin failed to load: %w", err)
	}

	// Check cursor-agent responds
	cmd = exec.Command("cursor-agent", "--version")
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("cursor-agent not responding")
	}

	return nil
}

func verifyPostInstall(m *model) error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, "opencode", "models")
	output, err := cmd.CombinedOutput()

	cancel()

	if err != nil {
		return fmt.Errorf("failed to run opencode models: %w. Output: %s", err, string(output))
	}

	if strings.Contains(string(output), "cursor-acp") {
		return nil
	}

	return fmt.Errorf("cursor-acp provider not found - plugin may not be installed correctly. OpenCode output: %s", string(output))
}

// Backup and restore functions
func createBackup(m *model, path string) error {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("failed to read file for backup: %w", err)
	}

	m.backupFiles[path] = data
	return nil
}

func restoreBackup(m *model, path string) error {
	if backupData, exists := m.backupFiles[path]; exists {
		if err := os.WriteFile(path, backupData, 0644); err != nil {
			return fmt.Errorf("failed to restore backup: %w", err)
		}
		delete(m.backupFiles, path)
	}
	return nil
}

func restoreAllBackups(m *model) error {
	for path, data := range m.backupFiles {
		if err := os.WriteFile(path, data, 0644); err != nil {
			return fmt.Errorf("failed to restore %s: %w", path, err)
		}
	}
	m.backupFiles = make(map[string][]byte)
	return nil
}

func cleanupBackups(m *model) {
	// On success we just drop the in-memory copies; never delete the user's files.
	m.backupFiles = make(map[string][]byte)
}

// backupConfigToDisk writes a timestamped backup alongside the given file.
// Failures are intentionally non-fatal to avoid blocking installation.
func backupConfigToDisk(path string) error {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}

	ts := time.Now().Format("20060102-150405")
	backupPath := fmt.Sprintf("%s.bak.%s", path, ts)
	return os.WriteFile(backupPath, data, 0644)
}

// Uninstall functions
func (m model) startUninstallation() (tea.Model, tea.Cmd) {
	m.step = stepUninstalling
	m.isUninstall = true

	m.tasks = []installTask{
		{name: "Remove plugin symlink", description: "Removing cursor-acp.js from plugin directory", execute: removeSymlink, status: statusPending},
		{name: "Remove ACP SDK", description: "Removing @agentclientprotocol/sdk from opencode", execute: removeAcpSdk, status: statusPending},
		{name: "Remove provider config", description: "Removing cursor-acp from opencode.json", execute: removeProviderConfig, status: statusPending},
		{name: "Remove old plugin", description: "Removing cursor-acp-auth if present", execute: removeOldPlugin, status: statusPending},
		{name: "Validate config", description: "Checking JSON syntax", execute: validateConfigAfterUninstall, status: statusPending},
	}

	m.currentTaskIndex = 0
	m.tasks[0].status = statusRunning
	return m, tea.Batch(m.spinner.Tick, executeTaskCmd(0, &m))
}

func removeSymlink(m *model) error {
	// Remove symlink from plugin directory
	symlinkPath := filepath.Join(m.pluginDir, "cursor-acp.js")

	// Check if symlink exists
	if _, err := os.Lstat(symlinkPath); os.IsNotExist(err) {
		// Symlink doesn't exist, that's fine - already uninstalled
		return nil
	}

	// Remove symlink
	if err := os.Remove(symlinkPath); err != nil {
		return fmt.Errorf("failed to remove symlink: %w", err)
	}

	// Also remove old node_modules symlink if it exists (migration from older installer)
	configDir, _ := getConfigDir()
	oldNodeModulesPath := filepath.Join(configDir, "opencode", "node_modules", "cursor-acp")
	if _, err := os.Lstat(oldNodeModulesPath); err == nil {
		os.Remove(oldNodeModulesPath)
	}

	return nil
}

func removeAcpSdk(m *model) error {
	configDir, _ := getConfigDir()
	opencodeConfigDir := filepath.Join(configDir, "opencode")
	acpPath := filepath.Join(opencodeConfigDir, "node_modules", "@agentclientprotocol", "sdk")

	if _, err := os.Stat(acpPath); os.IsNotExist(err) {
		return nil
	}

	packageJsonPath := filepath.Join(opencodeConfigDir, "package.json")
	if _, err := os.Stat(packageJsonPath); err == nil {
		if err := createBackup(m, packageJsonPath); err != nil {
			return fmt.Errorf("failed to backup package.json: %w", err)
		}

		data, err := os.ReadFile(packageJsonPath)
		if err != nil {
			return fmt.Errorf("failed to read package.json: %w", err)
		}

		var packageJson map[string]interface{}
		if err := json.Unmarshal(data, &packageJson); err != nil {
			return fmt.Errorf("failed to parse package.json: %w", err)
		}

		if dependencies, ok := packageJson["dependencies"].(map[string]interface{}); ok {
			if _, hasAcpSdk := dependencies["@agentclientprotocol/sdk"]; hasAcpSdk {
				delete(dependencies, "@agentclientprotocol/sdk")
				packageJson["dependencies"] = dependencies

				output, err := json.MarshalIndent(packageJson, "", "  ")
				if err != nil {
					return fmt.Errorf("failed to serialize package.json: %w", err)
				}

				if err := os.WriteFile(packageJsonPath, output, 0644); err != nil {
					return fmt.Errorf("failed to write package.json: %w", err)
				}
			}
		}
	}

	if err := os.RemoveAll(filepath.Join(opencodeConfigDir, "node_modules", "@agentclientprotocol")); err != nil {
		return fmt.Errorf("failed to remove ACP SDK: %w", err)
	}

	return nil
}

func removeProviderConfig(m *model) error {
	_ = backupConfigToDisk(m.configPath)
	if err := createBackup(m, m.configPath); err != nil {
		return fmt.Errorf("failed to backup config: %w", err)
	}

	// Read existing config
	data, err := os.ReadFile(m.configPath)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("failed to read config: %w", err)
	}

	var config map[string]interface{}
	if err := json.Unmarshal(data, &config); err != nil {
		return fmt.Errorf("failed to parse config: %w", err)
	}

	// Remove cursor-acp provider
	if providers, ok := config["provider"].(map[string]interface{}); ok {
		if _, exists := providers["cursor-acp"]; exists {
			delete(providers, "cursor-acp")
		}
	}

	// Remove cursor-acp from plugin array
	if plugins, ok := config["plugin"].([]interface{}); ok {
		var newPlugins []interface{}
		for _, p := range plugins {
			if p != "cursor-acp" {
				newPlugins = append(newPlugins, p)
			}
		}
		config["plugin"] = newPlugins
	}

	// Write config back
	output, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to serialize config: %w", err)
	}

	if err := os.WriteFile(m.configPath, output, 0644); err != nil {
		return fmt.Errorf("failed to write config: %w", err)
	}

	return nil
}

func validateConfigAfterUninstall(m *model) error {
	if err := validateJSON(m.configPath); err != nil {
		return fmt.Errorf("config validation failed: %w", err)
	}

	// Verify cursor-acp provider is removed
	data, _ := os.ReadFile(m.configPath)
	var config map[string]interface{}
	json.Unmarshal(data, &config)

	if providers, ok := config["provider"].(map[string]interface{}); ok {
		if _, exists := providers["cursor-acp"]; exists {
			return fmt.Errorf("cursor-acp provider still exists in config")
		}
	}

	return nil
}

func removeOldPlugin(m *model) error {
	configDir, _ := getConfigDir()
	configPath := filepath.Join(configDir, "opencode", "opencode.json")

	_ = backupConfigToDisk(configPath)
	if err := createBackup(m, configPath); err != nil {
		return fmt.Errorf("failed to backup config: %w", err)
	}

	data, err := os.ReadFile(configPath)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("failed to read config: %w", err)
	}

	var config map[string]interface{}
	if err := json.Unmarshal(data, &config); err != nil {
		return fmt.Errorf("failed to parse config: %w", err)
	}

	if plugins, ok := config["plugin"].([]interface{}); ok {
		var newPlugins []interface{}
		for _, p := range plugins {
			pluginStr, ok := p.(string)
			if !ok {
				continue
			}
			if !strings.HasPrefix(pluginStr, "cursor-acp-auth") {
				newPlugins = append(newPlugins, pluginStr)
			}
		}
		config["plugin"] = newPlugins
	}

	output, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to serialize config: %w", err)
	}

	if err := os.WriteFile(configPath, output, 0644); err != nil {
		return fmt.Errorf("failed to write config: %w", err)
	}

	cacheDir := filepath.Join(os.Getenv("HOME"), ".cache", "opencode", "node_modules")
	oldPluginPath := filepath.Join(cacheDir, "cursor-acp-auth")
	if _, err := os.Stat(oldPluginPath); err == nil {
		if err := os.RemoveAll(oldPluginPath); err != nil {
			return fmt.Errorf("failed to remove old plugin from cache: %w", err)
		}
	}

	return nil
}

func (m model) handleTaskComplete(msg taskCompleteMsg) (tea.Model, tea.Cmd) {
	if msg.index >= len(m.tasks) {
		m.step = stepComplete
		return m, nil
	}

	task := &m.tasks[msg.index]

	if msg.success {
		task.status = statusComplete
	} else {
		task.status = statusFailed
		task.errorDetails = &errorInfo{
			message: msg.err,
			logFile: m.logFile.Name(),
		}

		if !task.optional && len(m.backupFiles) > 0 && !m.isUninstall && !m.noRollback {
			if err := restoreAllBackups(&m); err != nil {
				m.errors = append(m.errors, msg.err+" (rollback failed: "+err.Error())
			} else {
				m.errors = append(m.errors, msg.err+" (rolled back)")
			}
		}

		if !task.optional {
			m.errors = append(m.errors, msg.err)
			m.step = stepComplete
			return m, nil
		}
	}

	// Move to next task
	m.currentTaskIndex++
	if m.currentTaskIndex >= len(m.tasks) {
		cleanupBackups(&m)
		m.step = stepComplete
		return m, nil
	}

	m.tasks[m.currentTaskIndex].status = statusRunning
	return m, executeTaskCmd(m.currentTaskIndex, &m)
}
