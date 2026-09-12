import { buildToolFingerprint, _resetToolSchemaCache } from "../proxy/prompt-builder.js";
import { createLogger } from "../utils/logger.js";
import { getDynamicToolsDefinition, rememberCoreToolsFromTools, rememberMcpCatalogFromTools, rememberMcpServers } from "./dynamic-catalog.js";
import {
  discoverKiloNativeCoreToolDefs,
  discoverKiloNativeMcpToolDefs,
  extractFunctionToolNames,
  mergeToolDefinitionsByName,
  preferCanonicalMcpNames,
  splitKiloMcpToolName,
  stripVisibleMcpPrefixTools,
} from "./kilo-bridge.js";

const log = createLogger("mcp:tool-snapshot");

const ENV_FALSE = new Set(["0", "false", "off", "no", "disabled"]);
const PENDING_MCP_STATUSES = new Set(["connecting", "pending", "starting"]);
const INACTIVE_MCP_STATUSES = new Set(["disabled", "failed", "error", "disconnected"]);

function extractMcpServerNames(status: unknown): string[] {
  if (!status || typeof status !== "object") {
    return [];
  }
  const servers = (status as { data?: unknown }).data ?? status;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
    return [];
  }
  const names: string[] = [];
  for (const [name, entry] of Object.entries(servers as Record<string, any>)) {
    const state = String(entry?.status ?? entry?.state ?? "").toLowerCase();
    if (INACTIVE_MCP_STATUSES.has(state)) {
      continue;
    }
    names.push(name);
  }
  return names;
}

export type McpDiscoveryOptions = {
  maxWaitMs?: number;
  pollIntervalMs?: number;
  stablePolls?: number;
  enabled?: boolean;
};

export type ToolSnapshotResult = {
  tools: Array<any>;
  fingerprint: string;
  cacheHit: boolean;
  fingerprintChanged: boolean;
};

export type ChatParamToolSnapshotResolver = {
  resolve(existingTools: unknown): Promise<ToolSnapshotResult>;
  resetCache(): void;
};

export type CreateChatParamToolSnapshotResolverOptions = {
  applyBaseTools?: (tools: Array<any>) => Array<any>;
  getAppendTools?: () => Array<any>;
  onFingerprintChange?: (previous: string, next: string) => void;
  discovery?: McpDiscoveryOptions;
};

type ToolSnapshotCache = {
  fingerprint: string;
  tools: Array<any>;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function isMcpDiscoveryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.CURSOR_KILO_MCP_DISCOVERY;
  if (value === undefined) {
    return true;
  }
  return !ENV_FALSE.has(value.trim().toLowerCase());
}

function resolveDiscoveryOptions(
  overrides?: McpDiscoveryOptions,
): Required<Pick<McpDiscoveryOptions, "maxWaitMs" | "pollIntervalMs" | "stablePolls" | "enabled">> {
  return {
    enabled: overrides?.enabled ?? isMcpDiscoveryEnabled(),
    maxWaitMs: overrides?.maxWaitMs ?? envInt("CURSOR_KILO_MCP_DISCOVERY_MAX_WAIT_MS", 2000),
    pollIntervalMs: overrides?.pollIntervalMs ?? envInt("CURSOR_KILO_MCP_DISCOVERY_POLL_MS", 200),
    stablePolls: overrides?.stablePolls ?? envInt("CURSOR_KILO_MCP_DISCOVERY_STABLE_POLLS", 2),
  };
}

export function fingerprintMcpToolNames(tools: Array<any>): string {
  return extractFunctionToolNames(tools).sort().join("|");
}

/** True when any Kilo MCP server is still registering or connecting. */
export async function hasPendingMcpServers(client: any): Promise<boolean> {
  try {
    const status = client?.mcp?.status ? await client.mcp.status({ query: {} }) : null;
    rememberMcpServers(extractMcpServerNames(status));
    const servers = status?.data;
    if (!servers || typeof servers !== "object") {
      return false;
    }

    return Object.values(servers).some((entry: any) => {
      const state = String(entry?.status ?? "").toLowerCase();
      return PENDING_MCP_STATUSES.has(state);
    });
  } catch {
    return false;
  }
}

/** Poll MCP discovery until servers settle or timeout (bootstrap only). */
export async function discoverKiloNativeMcpToolDefsSettled(
  client: any,
  overrides?: McpDiscoveryOptions,
): Promise<Array<any>> {
  const options = resolveDiscoveryOptions(overrides);
  if (!options.enabled) {
    return discoverKiloNativeMcpToolDefs(client);
  }

  const deadline = Date.now() + options.maxWaitMs;
  let lastFingerprint = "";
  let stableCount = 0;
  let best: Array<any> = [];

  while (Date.now() < deadline) {
    const pending = await hasPendingMcpServers(client);
    const discovered = await discoverKiloNativeMcpToolDefs(client);
    if (discovered.length >= best.length) {
      best = discovered;
    }

    const fingerprint = fingerprintMcpToolNames(discovered);
    if (!pending && fingerprint.length > 0 && fingerprint === lastFingerprint) {
      stableCount += 1;
      if (stableCount >= options.stablePolls) {
        return best;
      }
    } else {
      stableCount = 0;
      lastFingerprint = fingerprint;
    }

    if (!pending && discovered.length === 0) {
      break;
    }

    await sleep(options.pollIntervalMs);
  }

  return best;
}

function buildFinalizedTools(
  baseTools: Array<any>,
  coreTools: Array<any>,
  mcpTools: Array<any>,
  appendTools: Array<any>,
): Array<any> {
  const canonicalMcpNames = extractFunctionToolNames(mcpTools);
  let merged = mergeToolDefinitionsByName(baseTools, coreTools);
  merged = mergeToolDefinitionsByName(merged, mcpTools);
  if (appendTools.length > 0) {
    merged = mergeToolDefinitionsByName(merged, appendTools);
  }
  merged = mergeToolDefinitionsByName(merged, [getDynamicToolsDefinition()]);
  merged = stripVisibleMcpPrefixTools(merged);
  return preferCanonicalMcpNames(merged, canonicalMcpNames);
}

export function createChatParamToolSnapshotResolver(
  client: any,
  options: CreateChatParamToolSnapshotResolverOptions = {},
): ChatParamToolSnapshotResolver {
  let cache: ToolSnapshotCache | null = null;
  const discovery = resolveDiscoveryOptions(options.discovery);
  const applyBaseTools = options.applyBaseTools ?? ((tools: Array<any>) => tools);
  const getAppendTools = options.getAppendTools ?? (() => []);

  async function resolve(existingTools: unknown): Promise<ToolSnapshotResult> {
    const baseTools = applyBaseTools(Array.isArray(existingTools) ? [...existingTools] : []);
    const appendTools = getAppendTools();

    let mcpTools: Array<any>;
    let pending = false;

    if (discovery.enabled) {
      pending = await hasPendingMcpServers(client);
      mcpTools = pending
        ? await discoverKiloNativeMcpToolDefsSettled(client, discovery)
        : await discoverKiloNativeMcpToolDefs(client);
    } else {
      mcpTools = await discoverKiloNativeMcpToolDefs(client);
    }

    const coreTools = await discoverKiloNativeCoreToolDefs(client, extractFunctionToolNames(baseTools));
    const finalized = buildFinalizedTools(baseTools, coreTools, mcpTools, appendTools);
    rememberMcpCatalogFromTools(mcpTools);
    rememberMcpCatalogFromTools(finalized);
    rememberCoreToolsFromTools(finalized);
    rememberMcpServers(
      extractFunctionToolNames(mcpTools)
        .map((name) => splitKiloMcpToolName(name)?.server)
        .filter((server): server is string => Boolean(server)),
    );
    const fingerprint = buildToolFingerprint(finalized);

    if (!pending && cache?.fingerprint === fingerprint) {
      log.debug("Tool snapshot cache hit", {
        toolCount: cache.tools.length,
        fingerprint: fingerprint.slice(0, 24),
      });
      return {
        tools: cache.tools,
        fingerprint,
        cacheHit: true,
        fingerprintChanged: false,
      };
    }

    const previous = cache?.fingerprint ?? "";
    const fingerprintChanged = previous !== fingerprint;
    cache = { fingerprint, tools: finalized };

    if (fingerprintChanged) {
      log.debug("Tool snapshot refreshed", {
        cacheHit: false,
        pending,
        toolCount: finalized.length,
        mcpToolCount: mcpTools.length,
        coreToolCount: coreTools.length,
        previous: previous.slice(0, 24),
        next: fingerprint.slice(0, 24),
      });
      options.onFingerprintChange?.(previous, fingerprint);
    }

    return {
      tools: finalized,
      fingerprint,
      cacheHit: false,
      fingerprintChanged,
    };
  }

  return {
    resolve,
    resetCache() {
      cache = null;
    },
  };
}

/** Default fingerprint-change handler: invalidate prompt-builder tool schema cache. */
export function resetPromptToolSchemaCacheOnFingerprintChange(
  _previous: string,
  _next: string,
): void {
  _resetToolSchemaCache();
}
