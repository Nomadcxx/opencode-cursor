// cmd/installer/view.go
package main

import (
	"fmt"
	"strings"

	"github.com/charmbracelet/lipgloss"
)

func (m model) View() string {
	if m.width == 0 {
		return "Loading..."
	}

	if m.width < 80 || m.height < 24 {
		return lipgloss.NewStyle().
			Foreground(ErrorColor).
			Background(BgBase).
			Bold(true).
			Width(m.width).
			Height(m.height).
			Render(fmt.Sprintf(
				"Terminal too small!\n\nMinimum: 80x24\nCurrent: %dx%d\n\nPlease resize.",
				m.width, m.height,
			))
	}

	var content strings.Builder

	// Render animated header
	if m.beams != nil {
		beamsOutput := m.beams.Render()
		content.WriteString(beamsOutput)
		content.WriteString("\n")
	} else {
		// Render entire ASCII block at once to preserve character alignment
		// (per-line Render() mangles widths with Unicode block characters)
		asciiStyle := lipgloss.NewStyle().
			Foreground(Primary).
			Background(BgBase).
			Bold(true)
		styledAscii := asciiStyle.Render(asciiHeader)

		// Center the entire block
		centeredAscii := lipgloss.NewStyle().
			Width(m.width).
			Align(lipgloss.Center).
			Render(styledAscii)
		content.WriteString(centeredAscii)
		content.WriteString("\n")
	}
	content.WriteString("\n")

	// Render ticker
	if m.ticker != nil {
		tickerText := m.ticker.Render(m.width - 4)
		tickerStyled := lipgloss.NewStyle().
			Foreground(FgMuted).
			Background(BgBase).
			Italic(true).
			Width(m.width).
			Align(lipgloss.Center).
			Render(tickerText)
		content.WriteString(tickerStyled)
		content.WriteString("\n\n")
	}

	// Main content based on step
	var mainContent string
	switch m.step {
	case stepWelcome:
		mainContent = m.renderWelcome()
	case stepSelectMode:
		mainContent = m.renderSelectMode()
	case stepInstalling:
		mainContent = m.renderInstalling()
	case stepUninstalling:
		mainContent = m.renderInstalling() // Same view for uninstalling
	case stepComplete:
		mainContent = m.renderComplete()
	}

	mainStyle := lipgloss.NewStyle().
		Padding(1, 2).
		Border(lipgloss.RoundedBorder()).
		BorderForeground(Secondary).
		Foreground(FgPrimary).
		Background(BgBase).
		Width(m.width - 4)
	content.WriteString(mainStyle.Render(mainContent))
	content.WriteString("\n")

	// Help text
	helpText := m.getHelpText()
	if helpText != "" {
		helpStyle := lipgloss.NewStyle().
			Foreground(FgMuted).
			Background(BgBase).
			Italic(true).
			Width(m.width).
			Align(lipgloss.Center)
		content.WriteString("\n" + helpStyle.Render(helpText))
	}

	// Full screen background
	bgStyle := lipgloss.NewStyle().
		Background(BgBase).
		Foreground(FgPrimary).
		Width(m.width).
		Height(m.height).
		Align(lipgloss.Center, lipgloss.Top)

	return bgStyle.Render(content.String())
}

func (m model) getHelpText() string {
	switch m.step {
	case stepWelcome:
		if m.existingSetup {
			return "Enter: Install  •  u: Uninstall  •  q: Quit"
		}
		return "Enter: Install  •  q: Quit"
	case stepSelectMode:
		return "Press 1 or 2 to continue"
	case stepInstalling, stepUninstalling:
		return "Please wait..."
	case stepComplete:
		return "Enter: Exit"
	}
	return ""
}

func (m model) renderWelcome() string {
	var b strings.Builder

	b.WriteString(lipgloss.NewStyle().Bold(true).Foreground(Primary).Render("OpenCode-Cursor Plugin Installer"))
	b.WriteString("\n\n")

	b.WriteString("Pre-install checks:\n\n")

	for _, check := range m.checks {
		var status string
		if check.passed {
			status = checkMark.String()
		} else if check.warning {
			status = skipMark.String()
		} else {
			status = failMark.String()
		}
		b.WriteString(fmt.Sprintf("  %s %s: %s\n", status, check.name, check.message))
	}

	b.WriteString("\n")

	if m.existingSetup {
		b.WriteString(lipgloss.NewStyle().Foreground(WarningColor).Render("⚠ cursor-acp already configured"))
		b.WriteString("\n\n")
		b.WriteString(lipgloss.NewStyle().Bold(true).Foreground(Primary).Render("Press Enter to reinstall"))
		b.WriteString("  •  ")
		b.WriteString(lipgloss.NewStyle().Bold(true).Foreground(ErrorColor).Render("Press 'u' to uninstall"))
	} else {
		// Check if we can proceed
		canProceed := true
		for _, check := range m.checks {
			if !check.passed && !check.warning {
				canProceed = false
				break
			}
		}

		if canProceed {
			b.WriteString(lipgloss.NewStyle().Bold(true).Foreground(Primary).Render("Press Enter to install"))
		} else {
			b.WriteString(lipgloss.NewStyle().Foreground(ErrorColor).Render("Fix errors above before installing"))
		}
	}

	return b.String()
}

func (m model) renderSelectMode() string {
	return "Choose installation method:\n\n" +
		"  [1] Quick Install (recommended)\n" +
		"      Adds the npm package to your opencode.json plugin array.\n" +
		"      Fastest — no building required.\n\n" +
		"  [2] Build from Source\n" +
		"      Clones, builds, and symlinks the plugin locally.\n" +
		"      Use if you need to modify the source code.\n\n" +
		"Press 1 or 2 to continue."
}

func (m model) renderInstalling() string {
	var b strings.Builder

	for _, task := range m.tasks {
		var line string
		switch task.status {
		case statusPending:
			line = lipgloss.NewStyle().Foreground(FgMuted).Render("  " + task.name)
		case statusRunning:
			line = m.spinner.View() + " " + lipgloss.NewStyle().Foreground(Secondary).Render(task.description)
		case statusComplete:
			line = checkMark.String() + " " + task.name
		case statusFailed:
			line = failMark.String() + " " + task.name
		case statusSkipped:
			line = skipMark.String() + " " + task.name
		}
		b.WriteString(line + "\n")

		if task.status == statusFailed && task.errorDetails != nil {
			err := task.errorDetails
			b.WriteString(lipgloss.NewStyle().Foreground(ErrorColor).Render(
				fmt.Sprintf("  └─ Error: %s\n", err.message)))
			if err.logFile != "" {
				b.WriteString(lipgloss.NewStyle().Foreground(FgMuted).Render(
					fmt.Sprintf("  └─ See logs: %s\n", err.logFile)))
			}
			if strings.Contains(err.message, "no models found") {
				b.WriteString(lipgloss.NewStyle().Foreground(WarningColor).Render(
					"  └─ Hint: Run with --debug to see raw cursor-agent output\n"))
			}
			if strings.Contains(err.message, "cursor-agent") && strings.Contains(err.message, "failed") {
				b.WriteString(lipgloss.NewStyle().Foreground(WarningColor).Render(
					"  └─ Hint: Ensure cursor-agent is installed and logged in\n"))
			}
		}
	}

	return b.String()
}

func (m model) renderComplete() string {
	hasCriticalFailure := false
	for _, task := range m.tasks {
		if task.status == statusFailed && !task.optional {
			hasCriticalFailure = true
			break
		}
	}

	if hasCriticalFailure {
		action := "Installation"
		if m.isUninstall {
			action = "Uninstallation"
		}

		var b strings.Builder
		b.WriteString(lipgloss.NewStyle().Foreground(ErrorColor).Bold(true).Render(
			fmt.Sprintf("✗ %s Failed\n\n", action)))

		for _, task := range m.tasks {
			var line string
			switch task.status {
			case statusComplete:
				line = checkMark.String() + " " + task.name
			case statusFailed:
				line = failMark.String() + " " + task.name
			case statusSkipped:
				line = skipMark.String() + " " + task.name
			default:
				line = lipgloss.NewStyle().Foreground(FgMuted).Render("  " + task.name)
			}
			b.WriteString(line + "\n")

			if task.status == statusFailed && task.errorDetails != nil {
				err := task.errorDetails
				b.WriteString(lipgloss.NewStyle().Foreground(ErrorColor).Render(
					fmt.Sprintf("  └─ Error: %s\n", err.message)))
				if err.logFile != "" {
					b.WriteString(lipgloss.NewStyle().Foreground(FgMuted).Render(
						fmt.Sprintf("  └─ Logs: %s\n", err.logFile)))
				}
				if strings.Contains(err.message, "no models found") {
					b.WriteString(lipgloss.NewStyle().Foreground(WarningColor).Render(
						"  └─ Hint: Run with --debug to see raw cursor-agent output\n"))
				}
			}
		}

		b.WriteString("\n")
		b.WriteString(lipgloss.NewStyle().Foreground(FgMuted).Render("Press Enter to exit"))
		return b.String()
	}

	var b strings.Builder
	if m.isUninstall {
		b.WriteString(lipgloss.NewStyle().Foreground(SuccessColor).Bold(true).Render("✓ Uninstallation Complete"))
		b.WriteString("\n\n")
		b.WriteString("The cursor-acp plugin has been removed from OpenCode.\n\n")
	} else {
		b.WriteString(lipgloss.NewStyle().Foreground(SuccessColor).Bold(true).Render("✓ Installation Complete"))
		b.WriteString("\n\n")
		b.WriteString("The cursor-acp provider is now available in OpenCode.\n\n")
	}

	if !m.isUninstall {
		b.WriteString(lipgloss.NewStyle().Bold(true).Foreground(Primary).Render("Quick Start"))
		b.WriteString("\n")

		cmdStyle := lipgloss.NewStyle().Foreground(Secondary)
		descStyle := lipgloss.NewStyle().Foreground(FgMuted)

		b.WriteString(fmt.Sprintf("  %s  %s\n", cmdStyle.Render("opencode"), descStyle.Render("Start OpenCode")))
		b.WriteString(fmt.Sprintf("  %s  %s\n\n", cmdStyle.Render("cursor-acp/auto"), descStyle.Render("Use as model name")))

		if !cursorAgentLoggedIn() {
			b.WriteString(lipgloss.NewStyle().Foreground(WarningColor).Render("⚠ Remember to run: cursor-agent login"))
			b.WriteString("\n\n")
		}

		pathStyle := lipgloss.NewStyle().Foreground(FgMuted).Italic(true)
		b.WriteString(fmt.Sprintf("Plugin:  %s\n", pathStyle.Render(m.pluginDir+"/cursor-acp.js")))
		b.WriteString(fmt.Sprintf("Config:  %s\n", pathStyle.Render(m.configPath)))
	}

	b.WriteString("\n")
	b.WriteString(lipgloss.NewStyle().Foreground(FgMuted).Render("Press Enter to exit"))

	return b.String()
}
