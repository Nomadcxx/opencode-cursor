// cmd/installer/update.go
package main

import (
	"github.com/charmbracelet/bubbles/spinner"
	tea "github.com/charmbracelet/bubbletea"
)

func (m model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		headerHeight := 7
		if m.beams == nil {
			m.beams = NewBeamsTextEffect(msg.Width, headerHeight, asciiHeader)
		} else {
			m.beams.Resize(msg.Width, headerHeight)
		}
		return m, nil

	case tickMsg:
		if m.beams != nil {
			m.beams.Update()
		}
		if m.ticker != nil {
			m.ticker.Update()
		}
		return m, tickCmd()

	case tea.KeyMsg:
		return m.handleKeyPress(msg)

	case spinner.TickMsg:
		var cmd tea.Cmd
		m.spinner, cmd = m.spinner.Update(msg)
		return m, cmd

	case taskCompleteMsg:
		return m.handleTaskComplete(msg)
	}

	return m, nil
}

func (m model) handleKeyPress(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	key := msg.String()

	switch key {
	case "ctrl+c":
		if m.step != stepInstalling {
			if m.cancel != nil {
				m.cancel()
			}
			return m, tea.Quit
		}
		return m, nil

	case "q":
		if m.step == stepComplete || m.step == stepWelcome {
			return m, tea.Quit
		}
	}

	switch m.step {
	case stepWelcome:
		return m.handleWelcomeKeys(key)
	case stepComplete:
		return m.handleCompleteKeys(key)
	}

	return m, nil
}

func (m model) handleWelcomeKeys(key string) (tea.Model, tea.Cmd) {
	switch key {
	case "enter":
		// Check for blocking errors
		for _, check := range m.checks {
			if !check.passed && !check.warning {
				return m, nil // Don't proceed with blocking errors
			}
		}
		return m.startInstallation()
	}
	return m, nil
}

func (m model) handleCompleteKeys(key string) (tea.Model, tea.Cmd) {
	if key == "enter" || key == "q" {
		return m, tea.Quit
	}
	return m, nil
}
