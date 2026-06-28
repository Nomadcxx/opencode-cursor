package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestInstallCursorBridgeHookWritesProjectHook(t *testing.T) {
	root := t.TempDir()

	if err := installCursorBridgeHook(root); err != nil {
		t.Fatalf("installCursorBridgeHook returned error: %v", err)
	}

	hooksPath := filepath.Join(root, ".cursor", "hooks.json")
	scriptPath := filepath.Join(root, ".cursor", "hooks", "opencode-bridge-context.mjs")

	raw, err := os.ReadFile(hooksPath)
	if err != nil {
		t.Fatalf("read hooks.json: %v", err)
	}
	var hooks map[string]interface{}
	if err := json.Unmarshal(raw, &hooks); err != nil {
		t.Fatalf("parse hooks.json: %v", err)
	}

	sessionStart := hooks["hooks"].(map[string]interface{})["sessionStart"].([]interface{})
	if len(sessionStart) != 1 {
		t.Fatalf("expected one sessionStart hook, got %d", len(sessionStart))
	}
	command := sessionStart[0].(map[string]interface{})["command"]
	if command != cursorBridgeHookCommand {
		t.Fatalf("expected command %q, got %q", cursorBridgeHookCommand, command)
	}

	script, err := os.ReadFile(scriptPath)
	if err != nil {
		t.Fatalf("read hook script: %v", err)
	}
	if !strings.Contains(string(script), "opencode bridge mode is active") {
		t.Fatalf("hook script missing bridge context")
	}
}

func TestInstallCursorBridgeHookPreservesExistingHooks(t *testing.T) {
	root := t.TempDir()
	cursorDir := filepath.Join(root, ".cursor")
	if err := os.MkdirAll(cursorDir, 0755); err != nil {
		t.Fatal(err)
	}
	hooksPath := filepath.Join(cursorDir, "hooks.json")
	existing := `{"version":1,"hooks":{"sessionStart":[{"command":"node existing.mjs"}]}}`
	if err := os.WriteFile(hooksPath, []byte(existing), 0644); err != nil {
		t.Fatal(err)
	}

	if err := installCursorBridgeHook(root); err != nil {
		t.Fatalf("first install failed: %v", err)
	}
	if err := installCursorBridgeHook(root); err != nil {
		t.Fatalf("second install failed: %v", err)
	}

	raw, err := os.ReadFile(hooksPath)
	if err != nil {
		t.Fatal(err)
	}
	var hooks map[string]interface{}
	if err := json.Unmarshal(raw, &hooks); err != nil {
		t.Fatal(err)
	}
	sessionStart := hooks["hooks"].(map[string]interface{})["sessionStart"].([]interface{})
	if len(sessionStart) != 2 {
		t.Fatalf("expected existing hook plus bridge hook, got %d", len(sessionStart))
	}
	if sessionStart[0].(map[string]interface{})["command"] != "node existing.mjs" {
		t.Fatalf("existing hook was not preserved")
	}
	if sessionStart[1].(map[string]interface{})["command"] != cursorBridgeHookCommand {
		t.Fatalf("bridge hook was not appended")
	}
}
