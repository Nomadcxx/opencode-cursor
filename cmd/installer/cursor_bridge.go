package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
)

const cursorBridgeHookCommand = "node .cursor/hooks/opencode-bridge-context.mjs"

const cursorBridgeContext = `SYSTEM: opencode bridge mode is active.
For file changes through opencode-cursor, read any needed files first, then respond with exactly one JSON object and no prose:
{"name":"write","arguments":{"path":"relative/path","content":"complete file contents"}}
Use this only for a single complete-file write. Otherwise answer normally or use the available tool format.`

func installCursorBridgeHook(root string) error {
	cursorDir := filepath.Join(root, ".cursor")
	hooksDir := filepath.Join(cursorDir, "hooks")
	hooksPath := filepath.Join(cursorDir, "hooks.json")
	scriptPath := filepath.Join(hooksDir, "opencode-bridge-context.mjs")

	config, err := readCursorHooksConfig(hooksPath)
	if err != nil {
		return err
	}
	next := mergeCursorBridgeHook(config)

	if err := os.MkdirAll(hooksDir, 0755); err != nil {
		return fmt.Errorf("failed to create Cursor hooks directory: %w", err)
	}
	script := "#!/usr/bin/env node\n" +
		"const context = " + strconv.Quote(cursorBridgeContext) + ";\n" +
		"process.stdout.write(JSON.stringify({ additional_context: context }) + \"\\n\");\n"
	if err := os.WriteFile(scriptPath, []byte(script), 0644); err != nil {
		return fmt.Errorf("failed to write Cursor bridge hook script: %w", err)
	}

	output, err := json.MarshalIndent(next, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to serialize Cursor hooks config: %w", err)
	}
	if err := os.WriteFile(hooksPath, append(output, '\n'), 0644); err != nil {
		return fmt.Errorf("failed to write Cursor hooks config: %w", err)
	}
	return nil
}

func readCursorHooksConfig(path string) (map[string]interface{}, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return map[string]interface{}{"version": float64(1), "hooks": map[string]interface{}{}}, nil
		}
		return nil, fmt.Errorf("failed to read Cursor hooks config: %w", err)
	}

	var config map[string]interface{}
	if err := json.Unmarshal(data, &config); err != nil {
		return nil, fmt.Errorf("failed to parse Cursor hooks config %s: %w", path, err)
	}
	if config == nil {
		config = map[string]interface{}{}
	}
	return config, nil
}

func mergeCursorBridgeHook(config map[string]interface{}) map[string]interface{} {
	next := map[string]interface{}{}
	for key, value := range config {
		next[key] = value
	}
	if _, ok := next["version"].(float64); !ok {
		next["version"] = float64(1)
	}

	hooks, ok := next["hooks"].(map[string]interface{})
	if !ok {
		hooks = map[string]interface{}{}
	}
	nextHooks := map[string]interface{}{}
	for key, value := range hooks {
		nextHooks[key] = value
	}

	sessionStart, _ := nextHooks["sessionStart"].([]interface{})
	for _, hook := range sessionStart {
		if entry, ok := hook.(map[string]interface{}); ok && entry["command"] == cursorBridgeHookCommand {
			nextHooks["sessionStart"] = sessionStart
			next["hooks"] = nextHooks
			return next
		}
	}

	nextHooks["sessionStart"] = append(sessionStart, map[string]interface{}{"command": cursorBridgeHookCommand})
	next["hooks"] = nextHooks
	return next
}

func installCursorBridgeHookTask(m *model) error {
	if m.skipCursorBridge {
		return nil
	}
	root := m.cursorBridgeRoot
	if root == "" {
		root = m.projectDir
	}
	return installCursorBridgeHook(root)
}
