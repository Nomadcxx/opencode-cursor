// cmd/installer/types.go
package main

import (
	"context"
	"os"
	"time"

	"github.com/charmbracelet/bubbles/spinner"
	tea "github.com/charmbracelet/bubbletea"
)

// Installation steps
type installStep int

const (
	stepWelcome installStep = iota
	stepSelectMode
	stepInstalling
	stepUninstalling
	stepComplete
)

// Task status
type taskStatus int

const (
	statusPending taskStatus = iota
	statusRunning
	statusComplete
	statusFailed
	statusSkipped
)

// Installation task
type installTask struct {
	name         string
	description  string
	execute      func(*model) error
	optional     bool
	status       taskStatus
	errorDetails *errorInfo
}

type errorInfo struct {
	message string
	command string
	logFile string
}

// Pre-install check result
type checkResult struct {
	name    string
	passed  bool
	message string
	warning bool // true = non-blocking warning, false = blocking error
}

// Main model
type model struct {
	step             installStep
	mode             installMode
	tasks            []installTask
	currentTaskIndex int
	width            int
	height           int
	spinner          spinner.Model
	errors           []string
	warnings         []string
	selectedOption   int
	debugMode        bool
	noRollback       bool
	logFile          *os.File

	// Animations
	beams  *BeamsTextEffect
	ticker *TypewriterTicker

	// Pre-install checks
	checks         []checkResult
	checksComplete bool

	// Installation paths
	projectDir    string
	pluginEntry   string
	pluginDir     string
	configPath    string
	existingSetup bool
	isUninstall   bool
	npmTag        string

	// Context for cancellation
	ctx    context.Context
	cancel context.CancelFunc

	// Backup files for rollback
	backupFiles map[string][]byte
}

// Messages
type taskCompleteMsg struct {
	index   int
	success bool
	err     string
}

type checksCompleteMsg struct {
	checks []checkResult
}

type tickMsg time.Time

// globalProgram for sending messages from goroutines
var globalProgram *tea.Program
