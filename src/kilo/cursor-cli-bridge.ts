import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "../utils/logger.js";

const log = createLogger("kilo:cursor-cli-bridge");

const ENV_FALSE_VALUES = new Set(["0", "false", "off", "no", "disabled"]);

function isEnvFalse(value: string | undefined): boolean {
  if (value === undefined) {
    return false;
  }
  return ENV_FALSE_VALUES.has(value.trim().toLowerCase());
}

/** Direct MCP bridge from kilo.jsonc. Default ON; set CURSOR_KILO_DIRECT_MCP=false to disable. */
export function isDirectMcpEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.CURSOR_KILO_DIRECT_MCP !== undefined) {
    return !isEnvFalse(env.CURSOR_KILO_DIRECT_MCP);
  }
  if (env.CURSOR_KILO_MCP_BRIDGE !== undefined) {
    return !isEnvFalse(env.CURSOR_KILO_MCP_BRIDGE);
  }
  return true;
}

/**
 * Deny cursor-agent native MCP — Kilo owns MCP in passthrough mode.
 * Do not set approvalMode: "allowlist" without permissions.allow (schema error).
 * See https://cursor.com/docs/cli/reference/configuration
 */
/** Project-level cli.json only supports `permissions` (no top-level `version`). */
export const KILO_PASSTHROUGH_BRIDGE_CLI_CONFIG = {
  permissions: {
    allow: [],
    deny: [
      "Write(*)",
      "Shell(*)",
      "Edit(*)",
      "Delete(*)",
      "Mcp(*:*)",
    ],
  },
} as const;

const PASSTHROUGH_CLI_JSON = `${JSON.stringify(KILO_PASSTHROUGH_BRIDGE_CLI_CONFIG, null, 2)}\n`;

/** Deny cursor-agent native MCP without blocking Write/Shell when direct MCP is on. */
export const KILO_MCP_DENY_CLI_CONFIG = {
  permissions: {
    allow: [],
    deny: ["Mcp(*:*)"],
  },
} as const;

const MCP_DENY_CLI_JSON = `${JSON.stringify(KILO_MCP_DENY_CLI_CONFIG, null, 2)}\n`;
const MCP_DENY_PERMISSION = "Mcp(*:*)";

export function syncKiloPassthroughBridgeCliConfig(workspaceDirectory: string): void {
  if (!workspaceDirectory) {
    return;
  }

  try {
    const cursorDir = join(workspaceDirectory, ".cursor");
    mkdirSync(cursorDir, { recursive: true });
    const cliPath = join(cursorDir, "cli.json");
    writeFileSync(cliPath, PASSTHROUGH_CLI_JSON, "utf8");
    log.debug("Synced passthrough bridge cli.json", { path: cliPath });
  } catch (error) {
    log.debug("Failed to sync passthrough bridge cli.json", { error: String(error) });
  }
}

/**
 * Direct MCP still must block cursor-agent's own MCP stack. Composer builtins
 * (GetDynamicTools / CallDynamicTool) otherwise hit "MCP server does not exist".
 * Writes a minimal deny stub, or merges Mcp(*:*) into an existing custom cli.json.
 */
export function ensureNativeMcpDenied(workspaceDirectory: string): void {
  if (!workspaceDirectory) {
    return;
  }

  try {
    const cursorDir = join(workspaceDirectory, ".cursor");
    mkdirSync(cursorDir, { recursive: true });
    const cliPath = join(cursorDir, "cli.json");

    if (!existsSync(cliPath)) {
      writeFileSync(cliPath, MCP_DENY_CLI_JSON, "utf8");
      log.debug("Wrote mcp-deny cli.json", { path: cliPath });
      return;
    }

    const current = readFileSync(cliPath, "utf8");
    if (current === MCP_DENY_CLI_JSON) {
      return;
    }
    if (current === PASSTHROUGH_CLI_JSON || isLegacyBrokenCliJson(current)) {
      writeFileSync(cliPath, MCP_DENY_CLI_JSON, "utf8");
      log.debug("Replaced passthrough stub with mcp-deny cli.json", { path: cliPath });
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(current);
    } catch {
      log.debug("Leaving unparseable cli.json in place", { path: cliPath });
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return;
    }

    const record = parsed as Record<string, unknown>;
    const permissions = isPlainObject(record.permissions) ? { ...record.permissions } : {};
    const deny = Array.isArray(permissions.deny) ? [...permissions.deny] : [];
    if (deny.includes(MCP_DENY_PERMISSION)) {
      return;
    }
    deny.push(MCP_DENY_PERMISSION);
    permissions.deny = deny;
    if (!Array.isArray(permissions.allow)) {
      permissions.allow = [];
    }
    record.permissions = permissions;
    writeFileSync(cliPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    log.debug("Merged Mcp(*:*) deny into existing cli.json", { path: cliPath });
  } catch (error) {
    log.debug("Failed to ensure native MCP deny in cli.json", { error: String(error) });
  }
}

function isLegacyBrokenCliJson(current: string): boolean {
  return current.includes('"approvalMode": "allowlist"')
    && current.includes('"deny"')
    && !current.includes('"allow"');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Remove passthrough stub when direct MCP is enabled (avoids stale invalid cli.json). */
export function removePassthroughBridgeCliConfig(workspaceDirectory: string): void {
  if (!workspaceDirectory) {
    return;
  }

  try {
    const cliPath = join(workspaceDirectory, ".cursor", "cli.json");
    if (!existsSync(cliPath)) {
      return;
    }
    const current = readFileSync(cliPath, "utf8");
    // Remove only our generated stub (exact match or legacy broken allowlist-only stub).
    if (current === PASSTHROUGH_CLI_JSON || isLegacyBrokenCliJson(current)) {
      unlinkSync(cliPath);
      log.debug("Removed passthrough bridge cli.json stub", { path: cliPath });
    }
  } catch (error) {
    log.debug("Failed to remove passthrough bridge cli.json", { error: String(error) });
  }
}
