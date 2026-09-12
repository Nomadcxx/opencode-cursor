/**
 * Kilo Code platform constants — minimal fork delta over OpenCode.
 *
 * Kilo is an OpenCode fork; most internals (oc_ tool prefix, tool loop mode
 * "opencode", plugin hooks) stay identical. Only config paths, provider ID,
 * and MCP naming conventions differ.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "os";
import { join, resolve } from "node:path";

export const KILO_PROVIDER_ID = "cursor";
export const NPM_PACKAGE_NAME = "kilo-cursor-plugin";

type EnvLike = Record<string, string | undefined>;

/** Resolve primary Kilo config file (supports JSONC, per Kilo docs) */
export function resolveKiloConfigPath(env: EnvLike = process.env): string {
  if (env.KILO_CONFIG?.length) return resolve(env.KILO_CONFIG);
  if (env.OPENCODE_CONFIG?.length) return resolve(env.OPENCODE_CONFIG);

  const configHome =
    env.XDG_CONFIG_HOME?.length ? env.XDG_CONFIG_HOME : join(homedir(), ".config");

  // Global config locations (see https://kilo.ai/docs/automate/extending/plugins)
  for (const candidate of [
    join(configHome, "kilo", "kilo.jsonc"),
    join(configHome, "kilo", "kilo.json"),
    join(configHome, "kilo", "opencode.jsonc"),
    join(configHome, "kilo", "tui.jsonc"),
    join(configHome, "opencode", "opencode.json"), // legacy
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return join(configHome, "kilo", "kilo.jsonc");
}

/** Resolve project-level config if present */
export function resolveProjectKiloConfig(cwd: string): string | null {
  for (const candidate of [
    join(cwd, "kilo.jsonc"),
    join(cwd, "kilo.json"),
    join(cwd, ".kilo", "opencode.jsonc"),
    join(cwd, ".kilo", "kilo.jsonc"),
    join(cwd, ".kilocode", "kilo.jsonc"),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Strip JSONC comments; does not treat // inside quoted strings (e.g. https URLs). */
export function stripJsoncComments(raw: string): string {
  let out = "";
  let i = 0;
  let inString = false;
  let escape = false;
  let stringQuote = "\"";

  while (i < raw.length) {
    const ch = raw[i]!;

    if (inString) {
      out += ch;
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === stringQuote) {
        inString = false;
      }
      i++;
      continue;
    }

    if (ch === "\"" || ch === "'") {
      inString = true;
      stringQuote = ch;
      out += ch;
      i++;
      continue;
    }

    if (ch === "/" && raw[i + 1] === "/") {
      while (i < raw.length && raw[i] !== "\n") {
        i++;
      }
      continue;
    }

    if (ch === "/" && raw[i + 1] === "*") {
      i += 2;
      while (i < raw.length && !(raw[i] === "*" && raw[i + 1] === "/")) {
        i++;
      }
      i += 2;
      continue;
    }

    out += ch;
    i++;
  }

  return out;
}

/** Remove trailing commas before `}` or `]` outside quoted strings. */
export function stripJsoncTrailingCommas(raw: string): string {
  let out = "";
  let i = 0;
  let inString = false;
  let escape = false;
  let stringQuote = "\"";

  while (i < raw.length) {
    const ch = raw[i]!;

    if (inString) {
      out += ch;
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === stringQuote) {
        inString = false;
      }
      i++;
      continue;
    }

    if (ch === "\"" || ch === "'") {
      inString = true;
      stringQuote = ch;
      out += ch;
      i++;
      continue;
    }

    if (ch === ",") {
      let j = i + 1;
      while (j < raw.length && /\s/.test(raw[j]!)) {
        j++;
      }
      if (raw[j] === "}" || raw[j] === "]") {
        i++;
        continue;
      }
    }

    out += ch;
    i++;
  }

  return out;
}

export function parseConfigJson(raw: string): Record<string, unknown> | null {
  const normalized = stripJsoncTrailingCommas(stripJsoncComments(raw));
  try {
    return JSON.parse(normalized);
  } catch {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
}

export function matchesPlugin(entry: string): boolean {
  return (
    entry === KILO_PROVIDER_ID ||
    entry === NPM_PACKAGE_NAME ||
    entry.startsWith(`${NPM_PACKAGE_NAME}@`) ||
    entry === "@rama_nigg/open-cursor" ||
    entry.startsWith("@rama_nigg/open-cursor@") ||
    entry === "cursor-acp" || // legacy open-cursor
    entry === "cursor-kilo" // legacy kilo-cursor-plugin
  );
}

export function isKiloPluginEnabledInConfig(config: unknown): boolean {
  if (!config || typeof config !== "object") return true;
  const c = config as { plugin?: unknown; provider?: unknown };
  if (c.provider && typeof c.provider === "object") {
    const p = c.provider as Record<string, unknown>;
    if (KILO_PROVIDER_ID in p || "cursor-acp" in p || "cursor-kilo" in p) return true;
  }
  if (Array.isArray(c.plugin)) {
    return c.plugin.some((e) => matchesPlugin(String(e)));
  }
  return true;
}

/** Kilo MCP native naming: {server}_{tool} (non-alphanumerics flattened to `_`). */
export function namespaceMcpToolKilo(serverName: string, toolName: string): string {
  return `${serverName.replace(/[^a-zA-Z0-9]/g, "_")}_${toolName.replace(/[^a-zA-Z0-9]/g, "_")}`;
}

/**
 * Kilo-visible MCP name: keep hyphens that Kilo registers
 * (`browser-harness_browser_list_tabs`, `context7_query-docs`).
 */
export function namespaceMcpToolKiloNative(serverName: string, toolName: string): string {
  const server = serverName.replace(/[^a-zA-Z0-9-]/g, "_");
  const tool = toolName.replace(/[^a-zA-Z0-9_.-]/g, "_");
  return `${server}_${tool}`;
}

/** Built-in + MCP tool names that should be intercepted and routed to Kilo */
const INTERCEPTABLE = new Set([
  "read", "write", "edit", "apply_patch", "grep", "glob", "bash", "ls",
  "mkdir", "rm", "stat", "webfetch", "websearch", "question", "task",
  "todowrite", "todoread", "plan", "skill", "skill_mcp",
  "list_mcp_resources", "read_mcp_resource", "list_mcp_resource_templates",
]);

export function isInterceptableToolName(name: string | undefined): boolean {
  if (!name) return false;
  if (name.startsWith("oc_") || name.startsWith("mcp__")) return true;
  if (INTERCEPTABLE.has(name.toLowerCase())) return true;
  // Kilo MCP: {server}_{tool} — server may contain hyphens (browser-harness_*)
  if (/^[a-zA-Z0-9][a-zA-Z0-9-]*_[a-zA-Z0-9_.-]+$/.test(name) && !name.startsWith("oc_")) return true;
  return false;
}

/** CLI fallback for tool discovery */
export function resolveKiloCliCommand(): string[] {
  const shim = process.env.KILO_TOOL_LIST_SHIM ?? process.env.OPENCODE_TOOL_LIST_SHIM;
  if (shim) return shim.split(" ");
  return ["kilo", "tool", "list", "--json"];
}
