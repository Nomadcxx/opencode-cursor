// cmd/installer/main.go
package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/charmbracelet/bubbles/spinner"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

type installMode int

const (
	modeQuickInstall installMode = iota
	modeBuildFromSource
)

func newModel(debugMode, noRollback bool, logFile *os.File) model {
	s := spinner.New()
	s.Style = lipgloss.NewStyle().Foreground(Secondary)
	s.Spinner = spinner.Dot

	ctx, cancel := context.WithCancel(context.Background())

	// Detect paths
	configDir, _ := getConfigDir()
	projectDir := getProjectDir()
	existingSetup, configPath := detectExistingSetup()
	npmTag := os.Getenv("CURSOR_ACP_NPM_TAG")
	if npmTag == "" {
		npmTag = "latest"
	}

	m := model{
		step:          stepWelcome,
		tasks:         []installTask{},
		spinner:       s,
		errors:        []string{},
		warnings:      []string{},
		mode:          modeQuickInstall,
		debugMode:     debugMode,
		noRollback:    noRollback,
		logFile:       logFile,
		ctx:           ctx,
		cancel:        cancel,
		projectDir:    projectDir,
		pluginEntry:   "",
		pluginDir:     filepath.Join(configDir, "opencode", "plugin"),
		configPath:    configPath,
		existingSetup: existingSetup,
		backupFiles:   make(map[string][]byte),
		npmTag:        npmTag,

		beams:  nil,
		ticker: NewTypewriterTicker(),
	}

	// Run pre-install checks
	m.checks = runPreInstallChecks()

	return m
}

func runPreInstallChecks() []checkResult {
	var checks []checkResult

	// Check bun
	if commandExists("bun") {
		checks = append(checks, checkResult{name: "bun", passed: true, message: "installed"})
	} else {
		checks = append(checks, checkResult{name: "bun", passed: false, message: "not found - install with: curl -fsSL https://bun.sh/install | bash"})
	}

	// Check cursor-agent
	if commandExists("cursor-agent") {
		checks = append(checks, checkResult{name: "cursor-agent", passed: true, message: "installed"})
		if cursorAgentLoggedIn() {
			checks = append(checks, checkResult{name: "cursor-agent login", passed: true, message: "logged in"})
		} else {
			checks = append(checks, checkResult{name: "cursor-agent login", passed: false, message: "not logged in - run: cursor-agent login", warning: true})
		}
	} else {
		checks = append(checks, checkResult{name: "cursor-agent", passed: false, message: "not found - install with: curl -fsS https://cursor.com/install | bash"})
	}

	// Check OpenCode installation
	ocInfo := detectOpenCodeInstall()
	if ocInfo.Installed {
		versionInfo := ocInfo.Version
		if versionInfo == "" {
			versionInfo = "version unknown"
		}
		methodInfo := fmt.Sprintf("%s (%s)", versionInfo, ocInfo.InstallMethod.String())
		checks = append(checks, checkResult{name: "OpenCode", passed: true, message: methodInfo})
		checks = append(checks, checkResult{name: "OpenCode binary", passed: true, message: ocInfo.BinaryPath})
	} else {
		checks = append(checks, checkResult{name: "OpenCode", passed: false, message: "not found - install with: curl -fsSL https://opencode.ai/install | bash"})
	}

	// Check OpenCode config directory
	configDir, err := getConfigDir()
	if err == nil {
		opencodeDir := filepath.Join(configDir, "opencode")
		if _, err := os.Stat(opencodeDir); err == nil {
			checks = append(checks, checkResult{name: "OpenCode config", passed: true, message: opencodeDir})
		} else {
			checks = append(checks, checkResult{name: "OpenCode config", passed: true, message: "will create: " + opencodeDir, warning: true})
		}
	}

	return checks
}

func (m model) Init() tea.Cmd {
	return tea.Batch(
		m.spinner.Tick,
		tickCmd(),
	)
}

func tickCmd() tea.Cmd {
	return tea.Tick(time.Millisecond*50, func(t time.Time) tea.Msg {
		return tickMsg(t)
	})
}

func main() {
	debugMode := false
	noRollback := false

	for _, arg := range os.Args[1:] {
		switch arg {
		case "--debug", "-d":
			debugMode = true
		case "--no-rollback":
			noRollback = true
		}
	}

	logFile, err := os.CreateTemp("", "opencode-cursor-installer-*.log")
	if err != nil {
		logFile = nil
	}
	if logFile != nil {
		defer logFile.Close()
		logFile.WriteString(fmt.Sprintf("=== OpenCode-Cursor Installer Log ===\n"))
		logFile.WriteString(fmt.Sprintf("Started: %s\n", time.Now().Format("2006-01-02 15:04:05")))
		logFile.WriteString(fmt.Sprintf("Debug Mode: %v\n\n", debugMode))
	}

	m := newModel(debugMode, noRollback, logFile)
	p := tea.NewProgram(m, tea.WithAltScreen())
	globalProgram = p

	if _, err := p.Run(); err != nil {
		fmt.Printf("Error: %v\n", err)
		os.Exit(1)
	}
}
