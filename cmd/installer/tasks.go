// cmd/installer/tasks.go
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"

	tea "github.com/charmbracelet/bubbletea"
)

func (m model) startInstallation() (tea.Model, tea.Cmd) {
	m.step = stepInstalling

	m.tasks = []installTask{
		{name: "Check prerequisites", description: "Verifying bun and cursor-agent", execute: checkPrerequisites, status: statusPending},
		{name: "Build plugin", description: "Running bun install && bun run build", execute: buildPlugin, status: statusPending},
		{name: "Create symlink", description: "Linking to OpenCode plugin directory", execute: createSymlink, status: statusPending},
		{name: "Update config", description: "Adding cursor-acp provider to opencode.json", execute: updateConfig, status: statusPending},
		{name: "Validate config", description: "Checking JSON syntax", execute: validateConfig, status: statusPending},
		{name: "Verify plugin", description: "Testing plugin loads correctly", execute: verifyPlugin, optional: true, status: statusPending},
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
		return fmt.Errorf("bun install failed")
	}

	// Run bun run build
	buildCmd := exec.Command("bun", "run", "build")
	buildCmd.Dir = m.projectDir
	if err := runCommand("bun run build", buildCmd, m.logFile); err != nil {
		return fmt.Errorf("bun run build failed")
	}

	// Verify dist/index.js exists
	distPath := filepath.Join(m.projectDir, "dist", "index.js")
	info, err := os.Stat(distPath)
	if err != nil || info.Size() == 0 {
		return fmt.Errorf("dist/index.js not found or empty after build")
	}

	return nil
}

func createSymlink(m *model) error {
	// Ensure plugin directory exists
	if err := os.MkdirAll(m.pluginDir, 0755); err != nil {
		return fmt.Errorf("failed to create plugin directory: %w", err)
	}

	symlinkPath := filepath.Join(m.pluginDir, "cursor-acp.js")
	targetPath := filepath.Join(m.projectDir, "dist", "index.js")

	// Remove existing symlink if present
	os.Remove(symlinkPath)

	// Create symlink
	if err := os.Symlink(targetPath, symlinkPath); err != nil {
		return fmt.Errorf("failed to create symlink: %w", err)
	}

	// Verify symlink resolves
	if _, err := os.Stat(symlinkPath); err != nil {
		return fmt.Errorf("symlink verification failed: %w", err)
	}

	return nil
}

func updateConfig(m *model) error {
	// Read existing config or create new
	var config map[string]interface{}

	data, err := os.ReadFile(m.configPath)
	if err != nil {
		if !os.IsNotExist(err) {
			return fmt.Errorf("failed to read config: %w", err)
		}
		// Create new config
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

	// Add cursor-acp provider
	providers["cursor-acp"] = map[string]interface{}{
		"npm":  "@ai-sdk/openai-compatible",
		"name": "Cursor Agent (ACP stdin)",
		"options": map[string]interface{}{
			"baseURL": "http://127.0.0.1:32123/v1",
		},
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
		return fmt.Errorf("config validation failed: %w", err)
	}

	// Verify cursor-acp provider exists in config
	data, _ := os.ReadFile(m.configPath)
	var config map[string]interface{}
	json.Unmarshal(data, &config)

	providers, ok := config["provider"].(map[string]interface{})
	if !ok {
		return fmt.Errorf("provider section missing from config")
	}

	if _, exists := providers["cursor-acp"]; !exists {
		return fmt.Errorf("cursor-acp provider not found in config")
	}

	return nil
}

func verifyPlugin(m *model) error {
	// Try to load plugin with node to catch syntax/import errors
	pluginPath := filepath.Join(m.projectDir, "dist", "index.js")
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
		// If not optional, stop installation
		if !task.optional {
			m.errors = append(m.errors, msg.err)
			m.step = stepComplete
			return m, nil
		}
	}

	// Move to next task
	m.currentTaskIndex++
	if m.currentTaskIndex >= len(m.tasks) {
		m.step = stepComplete
		return m, nil
	}

	m.tasks[m.currentTaskIndex].status = statusRunning
	return m, executeTaskCmd(m.currentTaskIndex, &m)
}
