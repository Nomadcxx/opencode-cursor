import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CURSOR_BRIDGE_HOOK_COMMAND,
  CURSOR_BRIDGE_USER_HOOK_COMMAND,
  ensureCursorBridgeHook,
} from "../../../src/cli/opencode-cursor.js";

describe("cli cursor bridge hook install", () => {
  it("installs the Cursor sessionStart hook into the current workspace", () => {
    const dir = mkdtempSync(join(tmpdir(), "open-cursor-bridge-"));

    try {
      const result = ensureCursorBridgeHook(dir, { dryRun: false });
      const hooksPath = join(dir, ".cursor", "hooks.json");
      const scriptPath = join(dir, ".cursor", "hooks", "opencode-bridge-context.mjs");
      const rulePath = join(dir, ".cursor", "rules", "opencode-bridge.mdc");
      const hooks = JSON.parse(readFileSync(hooksPath, "utf8"));

      expect(result.changed).toBe(true);
      expect(existsSync(scriptPath)).toBe(true);
      expect(readFileSync(rulePath, "utf8")).toContain("Do not use cursor native edit");
      expect(hooks.version).toBe(1);
      expect(hooks.hooks.sessionStart).toContainEqual({ command: CURSOR_BRIDGE_HOOK_COMMAND });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves existing Cursor hooks and avoids duplicate bridge hooks", () => {
    const dir = mkdtempSync(join(tmpdir(), "open-cursor-bridge-"));
    const cursorDir = join(dir, ".cursor");
    const hooksPath = join(cursorDir, "hooks.json");

    try {
      mkdirSync(cursorDir, { recursive: true });
      writeFileSync(
        hooksPath,
        JSON.stringify({
          version: 1,
          hooks: {
            sessionStart: [{ command: "node existing.mjs" }],
          },
        }),
        "utf8",
      );

      ensureCursorBridgeHook(dir, { dryRun: false });
      ensureCursorBridgeHook(dir, { dryRun: false });

      const hooks = JSON.parse(readFileSync(hooksPath, "utf8"));
      expect(hooks.hooks.sessionStart).toEqual([
        { command: "node existing.mjs" },
        { command: CURSOR_BRIDGE_HOOK_COMMAND },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not write Cursor files during dry-run", () => {
    const dir = mkdtempSync(join(tmpdir(), "open-cursor-bridge-"));

    try {
      const result = ensureCursorBridgeHook(dir, { dryRun: true });

      expect(result.changed).toBe(true);
      expect(existsSync(join(dir, ".cursor"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses the user hook command shape for user-level Cursor hooks", () => {
    const dir = mkdtempSync(join(tmpdir(), "open-cursor-bridge-user-"));

    try {
      ensureCursorBridgeHook(dir, { dryRun: false, scope: "user" });
      const hooks = JSON.parse(readFileSync(join(dir, ".cursor", "hooks.json"), "utf8"));

      expect(hooks.hooks.sessionStart).toContainEqual({ command: CURSOR_BRIDGE_USER_HOOK_COMMAND });
      expect(hooks.hooks.sessionStart).not.toContainEqual({ command: CURSOR_BRIDGE_HOOK_COMMAND });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
