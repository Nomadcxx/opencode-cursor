/**
 * OpenCode 2.0 plugin entrypoint for open-cursor.
 *
 * Separate from `plugin-v2.ts` on purpose: that module targets the next-era
 * `ctx.catalog` API, which stable OpenCode 2.0 removed. This entrypoint uses
 * `ctx.provider.transform` + in-memory `editor.add` / `reload()`, matching the
 * stable 2.0 host contract, while keeping this project's local HTTP proxy +
 * `@cursor/sdk` backend (OpenCode talks openai-compatible HTTP; it does not
 * own a Connect-RPC LanguageModel factory).
 *
 * Load only as: `{ "plugin": ["@rama_nigg/open-cursor/plugin/opencode2"] }`
 * Do not also load the classic root entry under OpenCode 2.0.
 */
import { shouldEnableCursorPlugin } from "./plugin-toggle.js";
import { createLogger } from "./utils/logger.js";
import {
  CURSOR_PROVIDER_ID,
  buildAvailableToolsSystemMessage,
  buildToolHookEntries,
  ensureCursorProxyServer,
  ensurePluginDirectory,
  setStoredApiKey,
  buildLocalFallbackTools,
  TOOL_LOOP_MODE,
} from "./plugin.js";
import { readMcpConfigs } from "./mcp/config.js";
import { McpClientManager } from "./mcp/client-manager.js";
import {
  buildMcpToolHookEntries,
  buildMcpToolDefinitions,
  namespaceMcpTool,
} from "./mcp/tool-bridge.js";
import { discoverModelsForRefresh, type DiscoveredModel } from "./models/sync.js";
import { ModelDiscoveryService } from "./models/discovery.js";
import { ToolRegistry as CoreRegistry } from "./tools/core/registry.js";
import { registerDefaultTools } from "./tools/defaults.js";
import { ToolRouter } from "./tools/router.js";
import { SkillLoader } from "./tools/skills/loader.js";
import { SkillResolver } from "./tools/skills/resolver.js";
import { LocalExecutor } from "./tools/executors/local.js";
import { executeWithChain } from "./tools/core/executor.js";
import { applyCursorProviderInventory, CURSOR_INTEGRATION_ID } from "./opencode2/catalog.js";
import { applyCursorIntegration, resolveCursorApiKey } from "./opencode2/integration.js";
import type {
  Cleanup,
  ConnectionInfo,
  Plugin2,
  PluginContext,
  SessionHttpRequest,
  ToolDefinition,
} from "./opencode2/types.js";

const log = createLogger("plugin-opencode2");

const TOOL_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    content: { type: "string" },
  },
} as const;

/** Static picker seed when live discovery has not completed yet. */
const FALLBACK_MODELS: DiscoveredModel[] = [
  { id: "auto", name: "Auto" },
  { id: "composer-2", name: "Composer 2" },
  { id: "composer-1.5", name: "Composer 1.5" },
];

function routeRequestToProxy(request: Request, baseURL: string): Request {
  const target = new URL(request.url);
  const proxy = new URL(baseURL);
  target.protocol = proxy.protocol;
  target.host = proxy.host;
  return new Request(target, request);
}

/** Convert a V1-style tool entry into an OpenCode 2.0 direct-catalog tool. */
function toolFromV1(
  name: string,
  entry: any,
  jsonSchema?: Record<string, unknown>,
): ToolDefinition {
  const description = typeof entry?.description === "string" ? entry.description : name;
  const input =
    jsonSchema && typeof jsonSchema === "object"
      ? jsonSchema
      : { type: "object", properties: {} };
  const v1Execute =
    typeof entry?.execute === "function" ? entry.execute : async () => ({ content: "" });

  return {
    name,
    description,
    input,
    output: TOOL_OUTPUT_SCHEMA,
    // Direct catalog so OpenCode / Cursor can call the tool by name.
    // Code Mode (`codemode: true`) hides tools behind `execute`.
    options: { codemode: false },
    async execute(args: any, executeCtx: any) {
      const result = await v1Execute(args, executeCtx);
      if (typeof result === "string") {
        return { content: result };
      }
      return result ?? { content: "" };
    },
  };
}

async function discoverModels(): Promise<DiscoveredModel[]> {
  try {
    const discovered = await discoverModelsForRefresh();
    if (discovered.length > 0) return discovered;
  } catch (err) {
    log.debug("Model discovery via refresh path failed", { error: String(err) });
  }

  try {
    const service = new ModelDiscoveryService({ cacheTTL: 0 });
    const models = await service.discover();
    if (models.length > 0) {
      return models.map((model) => ({ id: model.id, name: model.name }));
    }
  } catch (err) {
    log.debug("ModelDiscoveryService failed; using static fallback", { error: String(err) });
  }

  return FALLBACK_MODELS;
}

const plugin: Plugin2 = {
  id: "open-cursor",

  setup: async (ctx: PluginContext): Promise<Cleanup | void> => {
    const state = shouldEnableCursorPlugin();
    if (!state.enabled) {
      log.info("Plugin disabled in OpenCode config; skipping initialization", {
        configPath: state.configPath,
        reason: state.reason,
      });
      return;
    }

    const registrations: Array<{ dispose: () => Promise<void> | void }> = [];
    const track = async (p: Promise<{ dispose: () => Promise<void> | void }>) => {
      registrations.push(await p);
    };

    const workspaceDirectory = ctx.location?.directory || process.cwd();
    log.debug("OpenCode 2.0 plugin initializing", { workspaceDirectory });

    await ensurePluginDirectory();

    // ── Credentials ─────────────────────────────────────────
    await track(ctx.integration.transform(applyCursorIntegration));

    let sourceConnection: ConnectionInfo | undefined;
    const refreshSourceConnection = async (): Promise<void> => {
      try {
        sourceConnection = await ctx.integration.connection.active(CURSOR_INTEGRATION_ID);
      } catch {
        sourceConnection = undefined;
      }
    };

    // ── Proxy + tools (same runtime as classic / next-era V2) ─
    const mcpManager = new McpClientManager();
    let mcpToolEntries: Record<string, any> = {};
    let mcpToolDefs: any[] = [];
    let mcpToolSummaries: Array<{
      serverName: string;
      toolName: string;
      callName?: string;
      description?: string;
      params?: string[];
    }> = [];
    const mcpEnabled = process.env.CURSOR_ACP_MCP_BRIDGE !== "false";

    if (mcpEnabled) {
      try {
        const configs = readMcpConfigs();
        if (configs.length > 0) {
          await Promise.allSettled(configs.map((c) => mcpManager.connectServer(c)));
          const tools = mcpManager.listTools();
          if (tools.length > 0) {
            mcpToolEntries = buildMcpToolHookEntries(tools, mcpManager);
            mcpToolDefs = buildMcpToolDefinitions(tools);
            mcpToolSummaries = tools.map((t: any) => ({
              serverName: t.serverName,
              toolName: t.name,
              callName: namespaceMcpTool(t.serverName, t.name),
              description: t.description,
              params: t.inputSchema
                ? Object.keys((t.inputSchema as any).properties ?? {})
                : undefined,
            }));
          }
        }
      } catch (err) {
        log.debug("MCP bridge init failed", { error: String(err) });
      }
    }

    const toolsEnabled = process.env.CURSOR_ACP_ENABLE_OPENCODE_TOOLS !== "false";
    const legacyProxyToolPathsEnabled = toolsEnabled && TOOL_LOOP_MODE === "proxy-exec";

    const localRegistry = new CoreRegistry();
    registerDefaultTools(localRegistry);
    const localExec = new LocalExecutor(localRegistry);
    const executorChain: any[] = [localExec];
    const toolsByName = new Map<string, any>();
    const skillLoader = new SkillLoader();
    let skillResolver: SkillResolver | null = null;

    const router = legacyProxyToolPathsEnabled
      ? new ToolRouter({
          execute: (toolId: string, args: any) => executeWithChain(executorChain, toolId, args),
          toolsByName,
          resolveName: (name: string) => skillResolver?.resolve(name),
        })
      : null;

    const localTools = buildLocalFallbackTools(localRegistry, TOOL_LOOP_MODE);
    for (const tool of localTools) toolsByName.set(tool.name, tool);
    skillResolver = new SkillResolver(skillLoader.load(localTools));
    const lastToolNames = localTools.map((tool) => tool.name);
    const lastToolMap = localTools.map((tool) => ({ id: tool.id, name: tool.name }));

    const proxyBaseURL = await ensureCursorProxyServer(workspaceDirectory, router ?? undefined);
    log.debug("Proxy server started", { baseURL: proxyBaseURL });

    // ── Provider inventory (in-memory; no opencode.json dump) ─
    let models: DiscoveredModel[] = [];

    await track(
      ctx.provider.transform((editor) => {
        applyCursorProviderInventory(editor, models, proxyBaseURL, sourceConnection);
      }),
    );

    const publishModels = async (next: DiscoveredModel[]): Promise<boolean> => {
      const previousModels = models;
      const previousConnection = sourceConnection;
      models = next;
      await refreshSourceConnection();
      try {
        await ctx.provider.reload();
        return true;
      } catch (err) {
        log.debug("provider.reload failed; restoring previous inventory", {
          error: String(err),
        });
        models = previousModels;
        sourceConnection = previousConnection;
        return false;
      }
    };

    // Seed fallback immediately so the picker is never empty while discovery runs.
    await publishModels(FALLBACK_MODELS);

    // Live discovery is async and talks to cursor-agent / the SDK runner. Tests
    // set CURSOR_ACP_OPENCODE2_SKIP_DISCOVERY=1 to keep setup deterministic.
    if (process.env.CURSOR_ACP_OPENCODE2_SKIP_DISCOVERY !== "1") {
      void (async () => {
        const discovered = await discoverModels();
        if (discovered.length === 0) return;
        await publishModels(discovered);
      })().catch((err) => {
        log.debug("Background model publish failed", { error: String(err) });
      });
    }

    // Optional: some hosts still expose http.request. Prefer provider settings
    // baseURL; rewrite when the hook exists so config overlays cannot pin
    // traffic to a stale URL. Stable OpenCode 2.0 may omit the hook entirely.
    try {
      await track(
        ctx.session.hook(
          "http.request",
          async (event: SessionHttpRequest) => {
            if (event.model.providerID !== CURSOR_PROVIDER_ID) return;
            event.request = routeRequestToProxy(event.request, proxyBaseURL);
          },
        ),
      );
    } catch {
      // settings.baseURL from provider.transform is the authoritative route.
    }

    // ── Tools ────────────────────────────────────────────────
    try {
      const toolHookEntries = buildToolHookEntries(localRegistry, workspaceDirectory);
      const allEntries = { ...toolHookEntries, ...mcpToolEntries };

      const schemaByName = new Map<string, Record<string, unknown>>();
      for (const t of localRegistry.list()) {
        schemaByName.set(t.name, t.parameters);
      }

      await track(
        ctx.tool.transform((tools) => {
          for (const [name, entry] of Object.entries(allEntries)) {
            tools.add(toolFromV1(name, entry, schemaByName.get(name)));
          }
        }),
      );
    } catch (err) {
      log.debug("Tool registration failed", { error: String(err) });
    }

    // ── Per-turn credential + tool system message ────────────
    await track(
      ctx.session.hook("context", async (event) => {
        if (event.model?.providerID !== CURSOR_PROVIDER_ID) return;

        try {
          const key = await resolveCursorApiKey(ctx.integration);
          setStoredApiKey(key);
        } catch (err) {
          setStoredApiKey(undefined);
          log.debug("Could not resolve Cursor API key", { error: String(err) });
        }

        const systemMessage = buildAvailableToolsSystemMessage(
          lastToolNames,
          lastToolMap,
          mcpToolDefs,
          mcpToolSummaries,
        );
        if (systemMessage) {
          event.system.push({ type: "text", text: systemMessage });
        }
      }),
    );

    return async () => {
      for (const registration of registrations.reverse()) {
        try {
          await registration.dispose();
        } catch {
          // best-effort cleanup
        }
      }
      await mcpManager.disconnectAll();
      setStoredApiKey(undefined);
    };
  },
};

export default plugin;
