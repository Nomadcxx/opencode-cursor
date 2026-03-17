import {
  existsSync as nodeExistsSync,
  readFileSync as nodeReadFileSync,
} from "node:fs";
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

interface ReadSubagentNamesDeps {
  configJson?: string;
  existsSync?: (path: string) => boolean;
  readFileSync?: (path: string, enc: BufferEncoding) => string;
  env?: NodeJS.ProcessEnv;
}

export function readSubagentNames(deps: ReadSubagentNamesDeps = {}): string[] {
  let raw: string;

  if (deps.configJson != null) {
    raw = deps.configJson;
  } else {
    const exists = deps.existsSync ?? nodeExistsSync;
    const readFile = deps.readFileSync ?? nodeReadFileSync;
    const configPath = resolveOpenCodeConfigPath(deps.env ?? process.env);
    if (!exists(configPath)) return ["general-purpose"];
    try {
      raw = readFile(configPath, "utf8");
    } catch {
      return ["general-purpose"];
    }
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return ["general-purpose"];
  }

  const agentSection = parsed.agent;
  if (!agentSection || typeof agentSection !== "object" || Array.isArray(agentSection)) {
    return ["general-purpose"];
  }

  const agents = agentSection as Record<string, unknown>;
  const names = Object.keys(agents);
  if (names.length === 0) return ["general-purpose"];

  const subagentNames = names.filter((name) => {
    const entry = agents[name];
    return entry && typeof entry === "object" && !Array.isArray(entry)
      && (entry as Record<string, unknown>).mode === "subagent";
  });

  return subagentNames.length > 0 ? subagentNames : names;
}

function isStringRecord(v: unknown): v is Record<string, string> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
