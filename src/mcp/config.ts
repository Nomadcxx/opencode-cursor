import {
  existsSync as nodeExistsSync,
  readdirSync as nodeReaddirSync,
  readFileSync as nodeReadFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { resolveOpenCodeConfigPath } from "../plugin-toggle.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("mcp:config");

export type McpLocalServerConfig = {
  name: string;
  type: "local";
  command: string[];
  environment?: Record<string, string>;
  timeout?: number;
};

export type McpRemoteServerConfig = {
  name: string;
  type: "remote";
  url: string;
  headers?: Record<string, string>;
  timeout?: number;
};

export type McpServerConfig = McpLocalServerConfig | McpRemoteServerConfig;

interface ReadMcpConfigsDeps {
  configJson?: string;
  existsSync?: (path: string) => boolean;
  readFileSync?: (path: string, enc: BufferEncoding) => string;
  env?: NodeJS.ProcessEnv;
}

export function readMcpConfigs(deps: ReadMcpConfigsDeps = {}): McpServerConfig[] {
  let raw: string;

  if (deps.configJson != null) {
    raw = deps.configJson;
  } else {
    const exists = deps.existsSync ?? nodeExistsSync;
    const readFile = deps.readFileSync ?? nodeReadFileSync;
    const configPath = resolveOpenCodeConfigPath(deps.env ?? process.env);
    if (!exists(configPath)) return [];
    try {
      raw = readFile(configPath, "utf8");
    } catch {
      return [];
    }
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  const mcpSection = parsed.mcp;
  if (!mcpSection || typeof mcpSection !== "object" || Array.isArray(mcpSection)) {
    return [];
  }

  const configs: McpServerConfig[] = [];

  for (const [name, entry] of Object.entries(mcpSection as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const e = entry as Record<string, unknown>;

    if (e.enabled === false) continue;

    if (e.type === "local" && Array.isArray(e.command) && e.command.length > 0) {
      configs.push({
        name,
        type: "local",
        command: e.command as string[],
        environment: isStringRecord(e.environment) ? e.environment : undefined,
        timeout: typeof e.timeout === "number" ? e.timeout : undefined,
      });
    } else if (e.type === "remote" && typeof e.url === "string") {
      configs.push({
        name,
        type: "remote",
        url: e.url,
        headers: isStringRecord(e.headers) ? e.headers : undefined,
        timeout: typeof e.timeout === "number" ? e.timeout : undefined,
      });
    } else {
      log.debug("Skipping unrecognised MCP config entry", { name, type: e.type });
    }
  }

  return configs;
}

let _subagentCache: { names: string[]; expiry: number } | null = null;
const SUBAGENT_CACHE_TTL_MS = 60_000;

/** Clear cached subagent names (for testing only). */
export function _resetSubagentCache(): void {
  _subagentCache = null;
}

interface ReadSubagentNamesDeps {
  configJson?: string;
  configDir?: string;
  existsSync?: (path: string) => boolean;
  readFileSync?: (path: string, enc: BufferEncoding) => string;
  readdirSync?: (path: string, options?: { recursive?: boolean }) => string[];
  env?: NodeJS.ProcessEnv;
}

export function readSubagentNames(deps: ReadSubagentNamesDeps = {}): string[] {
  const useCache = deps.configJson == null;
  if (useCache && _subagentCache && Date.now() < _subagentCache.expiry) {
    return _subagentCache.names;
  }

  const result = readSubagentNamesUncached(deps);

  if (useCache) {
    _subagentCache = { names: result, expiry: Date.now() + SUBAGENT_CACHE_TTL_MS };
  }
  return result;
}

function resolveAgentDirs(deps: ReadSubagentNamesDeps): string[] {
  const configDir = deps.configDir
    ?? dirname(resolveOpenCodeConfigPath(deps.env ?? process.env));
  // OpenCode loads agents from both `agent/` and `agents/` (glob {agent,agents}/**/*.md).
  return [join(configDir, "agent"), join(configDir, "agents")];
}

function unquoteFrontmatterValue(value: string): string {
  const match = value.match(/^(["'])(.*)\1$/);
  return match ? match[2] : value;
}

function isFrontmatterTrue(value: string): boolean {
  const normalized = unquoteFrontmatterValue(value).toLowerCase();
  return normalized === "true" || normalized === "yes" || normalized === "on";
}

// Reads only `mode` and `disable` from frontmatter — an intentional two-key subset,
// not a full YAML parser. Inline comments (`disable: true # off`) and block scalars
// are out of scope; upstream reads real YAML.
function parseAgentFrontmatter(content: string): { mode?: string; disable?: boolean } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};

  const meta: { mode?: string; disable?: boolean } = {};
  for (const line of match[1].split(/\r?\n/)) {
    const entry = line.match(/^\s*([a-zA-Z_-]+)\s*:\s*(.+?)\s*$/);
    if (!entry) continue;
    const [, key, value] = entry;
    if (key === "mode") meta.mode = unquoteFrontmatterValue(value);
    if (key === "disable" && isFrontmatterTrue(value)) meta.disable = true;
  }
  return meta;
}

function readAgentsFromDirectory(deps: ReadSubagentNamesDeps): Record<string, unknown> {
  // Test-only shortcut: unit tests pass `configJson` alone (no directory deps) to
  // stay hermetic and off the real filesystem. No production caller passes `configJson`.
  if (deps.configJson != null && deps.configDir == null && deps.readdirSync == null) {
    return {};
  }

  const exists = deps.existsSync ?? nodeExistsSync;
  const readFile = deps.readFileSync ?? nodeReadFileSync;
  const readdir = deps.readdirSync ?? nodeReaddirSync;

  const agents: Record<string, unknown> = {};
  for (const agentsDir of resolveAgentDirs(deps)) {
    if (!exists(agentsDir)) continue;

    let files: string[];
    try {
      files = readdir(agentsDir, { recursive: true });
    } catch {
      continue;
    }

    for (const file of files) {
      if (!file.endsWith(".md")) continue;

      const filePath = join(agentsDir, file);
      let content: string;
      try {
        content = readFile(filePath, "utf8");
      } catch {
        continue;
      }

      const meta = parseAgentFrontmatter(content);
      if (meta.disable) continue;

      // Match OpenCode's path-based agent name (forward slashes, no extension).
      const name = file.slice(0, -3).split(/[\\/]/).join("/");
      agents[name] = meta.mode ? { mode: meta.mode } : {};
    }
  }

  return agents;
}

function pickSubagentNames(agents: Record<string, unknown>): string[] {
  const names = Object.keys(agents);
  if (names.length === 0) return ["general-purpose"];

  const subagentNames = names.filter((name) => {
    const entry = agents[name];
    return entry && typeof entry === "object" && !Array.isArray(entry)
      && (entry as Record<string, unknown>).mode === "subagent";
  });

  return subagentNames.length > 0 ? subagentNames : names;
}

function readAgentsFromConfigJson(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const agentSection = parsed.agent;
    if (!agentSection || typeof agentSection !== "object" || Array.isArray(agentSection)) {
      return {};
    }
    const agents: Record<string, unknown> = {};
    for (const [name, entry] of Object.entries(agentSection as Record<string, unknown>)) {
      // Match OpenCode: a JSON agent with `disable: true` is dropped.
      if (entry && typeof entry === "object" && (entry as Record<string, unknown>).disable === true) {
        continue;
      }
      agents[name] = entry;
    }
    return agents;
  } catch {
    return {};
  }
}

function readSubagentNamesUncached(deps: ReadSubagentNamesDeps): string[] {
  let agents: Record<string, unknown>;

  if (deps.configJson != null) {
    agents = readAgentsFromConfigJson(deps.configJson);
  } else {
    const exists = deps.existsSync ?? nodeExistsSync;
    const readFile = deps.readFileSync ?? nodeReadFileSync;
    const configPath = resolveOpenCodeConfigPath(deps.env ?? process.env);
    if (!exists(configPath)) {
      agents = {};
    } else {
      try {
        agents = readAgentsFromConfigJson(readFile(configPath, "utf8"));
      } catch {
        agents = {};
      }
    }
  }

  Object.assign(agents, readAgentsFromDirectory(deps));
  return pickSubagentNames(agents);
}

function isStringRecord(v: unknown): v is Record<string, string> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
