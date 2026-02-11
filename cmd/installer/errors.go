package main

import (
	"fmt"
	"strings"
)

func summarizeRawOutput(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}

	lines := strings.Split(raw, "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		line := strings.TrimSpace(lines[i])
		if line == "" {
			continue
		}
		if len(line) > 220 {
			return line[:220] + "..."
		}
		return line
	}

	if len(raw) > 220 {
		return raw[:220] + "..."
	}
	return raw
}

type InstallerError struct {
	Category    string
	Message     string
	Details     string
	RawOutput   string
	Cause       error
	Recoverable bool
}

func (e *InstallerError) Error() string {
	var b strings.Builder
	b.WriteString(fmt.Sprintf("[%s] %s", e.Category, e.Message))
	if e.Details != "" {
		b.WriteString(fmt.Sprintf(": %s", e.Details))
	}
	if summary := summarizeRawOutput(e.RawOutput); summary != "" {
		b.WriteString(fmt.Sprintf(" | output: %s", summary))
	}
	if e.Cause != nil {
		b.WriteString(fmt.Sprintf(" (cause: %v)", e.Cause))
	}
	return b.String()
}

func (e *InstallerError) Unwrap() error {
	return e.Cause
}

func NewParseError(msg, rawOutput string, cause error) *InstallerError {
	return &InstallerError{
		Category:    "PARSE",
		Message:     msg,
		RawOutput:   rawOutput,
		Cause:       cause,
		Recoverable: false,
	}
}

func NewConfigError(msg, path string, cause error) *InstallerError {
	return &InstallerError{
		Category:    "CONFIG",
		Message:     msg,
		Details:     path,
		Cause:       cause,
		Recoverable: true,
	}
}

func NewExecError(msg, output string, cause error) *InstallerError {
	return &InstallerError{
		Category:    "EXEC",
		Message:     msg,
		RawOutput:   output,
		Cause:       cause,
		Recoverable: false,
	}
}

func NewValidationError(msg, details string, cause error) *InstallerError {
	return &InstallerError{
		Category:    "VALIDATE",
		Message:     msg,
		Details:     details,
		Cause:       cause,
		Recoverable: true,
	}
}
