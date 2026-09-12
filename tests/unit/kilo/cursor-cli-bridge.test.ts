import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureNativeMcpDenied,
  isDirectMcpEnabled,
  KILO_MCP_DENY_CLI_CONFIG,
  KILO_PASSTHROUGH_BRIDGE_CLI_CONFIG,
  syncKiloPassthroughBridgeCliConfig,
} from "../../../src/kilo/cursor-cli-bridge.js";

describe("kilo/cursor-cli-bridge", () => {
  it("enables direct MCP by default", () => {
    expect(isDirectMcpEnabled({})).toBe(true);
  });

  it("disables direct MCP when CURSOR_KILO_DIRECT_MCP=false", () => {
    expect(isDirectMcpEnabled({ CURSOR_KILO_DIRECT_MCP: "false" })).toBe(false);
  });

  it("honors legacy CURSOR_KILO_MCP_BRIDGE=false", () => {
    expect(isDirectMcpEnabled({ CURSOR_KILO_MCP_BRIDGE: "false" })).toBe(false);
  });

  it("prefers CURSOR_KILO_DIRECT_MCP over legacy flag", () => {
    expect(
      isDirectMcpEnabled({
        CURSOR_KILO_DIRECT_MCP: "true",
        CURSOR_KILO_MCP_BRIDGE: "false",
      }),
    ).toBe(true);
  });

  it("writes valid project cli.json permissions without top-level version", () => {
    expect(KILO_PASSTHROUGH_BRIDGE_CLI_CONFIG).not.toHaveProperty("version");
    expect(Array.isArray(KILO_PASSTHROUGH_BRIDGE_CLI_CONFIG.permissions.allow)).toBe(true);
    expect(KILO_PASSTHROUGH_BRIDGE_CLI_CONFIG.permissions.deny).toContain("Mcp(*:*)");
    expect(KILO_PASSTHROUGH_BRIDGE_CLI_CONFIG.permissions.deny).toContain("Write(*)");
    expect(KILO_PASSTHROUGH_BRIDGE_CLI_CONFIG).not.toHaveProperty("approvalMode");
  });

  it("writes a mcp-only deny stub when cli.json is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "kilo-mcp-deny-"));
    try {
      ensureNativeMcpDenied(dir);
      const written = JSON.parse(readFileSync(join(dir, ".cursor", "cli.json"), "utf8"));
      expect(written).toEqual(KILO_MCP_DENY_CLI_CONFIG);
      expect(written.permissions.deny).toEqual(["Mcp(*:*)"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("replaces the full passthrough stub with mcp-only deny", () => {
    const dir = mkdtempSync(join(tmpdir(), "kilo-mcp-deny-full-"));
    try {
      syncKiloPassthroughBridgeCliConfig(dir);
      ensureNativeMcpDenied(dir);
      const written = JSON.parse(readFileSync(join(dir, ".cursor", "cli.json"), "utf8"));
      expect(written).toEqual(KILO_MCP_DENY_CLI_CONFIG);
      expect(written.permissions.deny).not.toContain("Write(*)");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("merges Mcp(*:*) into a custom cli.json without clobbering other denies", () => {
    const dir = mkdtempSync(join(tmpdir(), "kilo-mcp-deny-merge-"));
    try {
      const cursorDir = join(dir, ".cursor");
      mkdirSync(cursorDir, { recursive: true });
      const cliPath = join(cursorDir, "cli.json");
      writeFileSync(cliPath, `${JSON.stringify({
        permissions: { allow: ["Read(*)"], deny: ["Shell(*)"] },
      }, null, 2)}\n`, "utf8");
      ensureNativeMcpDenied(dir);
      const written = JSON.parse(readFileSync(cliPath, "utf8"));
      expect(written.permissions.allow).toEqual(["Read(*)"]);
      expect(written.permissions.deny).toEqual(["Shell(*)", "Mcp(*:*)"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves custom cli.json unchanged when Mcp(*:*) is already denied", () => {
    const dir = mkdtempSync(join(tmpdir(), "kilo-mcp-deny-keep-"));
    try {
      const cursorDir = join(dir, ".cursor");
      mkdirSync(cursorDir, { recursive: true });
      const cliPath = join(cursorDir, "cli.json");
      const original = `${JSON.stringify({
        permissions: { allow: [], deny: ["Mcp(*:*)", "WebFetch(*)"] },
      }, null, 2)}\n`;
      writeFileSync(cliPath, original, "utf8");
      ensureNativeMcpDenied(dir);
      expect(readFileSync(cliPath, "utf8")).toBe(original);
      expect(existsSync(cliPath)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
