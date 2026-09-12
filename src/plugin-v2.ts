/**
 * OpenCode V2 plugin entrypoint.
 *
 * OpenCode 2.x uses a different plugin API: the default export must be an
 * object with an `id` and a `setup` function, instead of the V1 async factory
 * function. This module provides that V2 shape while reusing the same proxy,
 * MCP bridge, and tool machinery as the V1 plugin.
 *
 * The V1 and V2 entrypoints are combined in plugin-entry.ts as a dual export
 * ({ id, server, setup }) so a single package works on both OpenCode 1.x and
 * 2.x — mirroring how oh-my-opencode-slim does it.
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
} from "./plugin.js";
import { readMcpConfigs } from "./mcp/config.js";
import { isDirectMcpEnabled } from "./kilo/cursor-cli-bridge.js";
import { McpClientManager } from "./mcp/client-manager.js";
import {
  buildMcpToolHookEntries,
  buildMcpToolDefinitions,
  namespaceMcpTool,
} from "./mcp/tool-bridge.js";
import { autoRefreshModels } from "./models/sync.js";
import { ToolRegistry as CoreRegistry } from "./tools/core/registry.js";
import { registerDefaultTools } from "./tools/defaults.js";
import { ToolRouter } from "./tools/router.js";
import { SkillLoader } from "./tools/skills/loader.js";
import { SkillResolver } from "./tools/skills/resolver.js";
import { LocalExecutor } from "./tools/executors/local.js";
import { executeWithChain } from "./tools/core/executor.js";
import { buildLocalFallbackTools, TOOL_LOOP_MODE } from "./plugin.js";

const log = createLogger("plugin-v2");

type V2Registration = { dispose: () => Promise<void> | void };
type V2ToolDefinition = {
  name: string;
  description: string;
  input: Record<string, unknown>;
  execute: (args: any, ctx: any) => Promise<unknown>;
  options: { codemode: true };
};
type V2SessionHook = {
  (name: "context", callback: (event: {
    model?: { providerID?: string };
    system: Array<{ type: "text"; text: string }>;
    tools: Record<string, { description: string; input: Record<string, unknown> }>;
  }) => Promise<void>): Promise<V2Registration>;
  (name: "http.request", callback: (event: {
    model: { providerID: string };
    request: Request;
  }) => Promise<void>): Promise<V2Registration>;
};
type V2Context = {
  catalog: {
    transform: (callback: (draft: {
      provider: { update: (id: string, update: (provider: {
        name: string;
        settings?: Record<string, unknown>;
      }) => void) => void };
    }) => void) => Promise<V2Registration>;
  };
  integration: {
    transform: (callback: (draft: {
      method: { update: (input: unknown) => void };
    }) => void) => Promise<V2Registration>;
    connection: {
      active: (integrationID: string) => Promise<Record<string, unknown> | undefined>;
      resolve: (connection: Record<string, unknown>) => Promise<{
        type: string;
        key?: string;
      } | undefined>;
    };
  };
  tool: {
    transform: (callback: (draft: {
      add: (tool: V2ToolDefinition) => void;
    }) => void) => Promise<V2Registration>;
  };
  session: {
    hook: V2SessionHook;
  };
};

function routeRequestToProxy(request: Request, baseURL: string): Request {
  const target = new URL(request.url);
  const proxy = new URL(baseURL);
  target.protocol = proxy.protocol;
  target.host = proxy.host;
  return new Request(target, request);
}

/** Convert a V1-style tool entry (with zod args) into a V2 tool definition. */
function v2ToolFromV1(
  name: string,
  entry: any,
  jsonSchema?: Record<string, unknown>,
): V2ToolDefinition {
  const description = typeof entry?.description === "string" ? entry.description : name;
  // Prefer the original JSON schema when available; fall back to an empty object.
  const input =
    jsonSchema && typeof jsonSchema === "object"
      ? jsonSchema
      : { type: "object", properties: {} };
  const v1Execute = typeof entry?.execute === "function" ? entry.execute : async () => ({ content: "" });

  return {
    name,
    description,
    input,
    options: { codemode: true },
    async execute(args: any, executeCtx: any) {
      const result = await v1Execute(args, executeCtx);
      // V1 tools return a string; V2 expects { content } or { output, content }.
      if (typeof result === "string") {
        return { content: result };
      }
      return result ?? { content: "" };
    },
  };
}

export function createV2Setup() {
  return async (ctx: V2Context) => {
    const state = shouldEnableCursorPlugin();
    if (!state.enabled) {
      log.info("Plugin disabled in OpenCode config; skipping initialization", {
        configPath: state.configPath,
        reason: state.reason,
      });
      return;
    }

    const registrations: V2Registration[] = [];

    // ponytail: V2 exposes no workspace path; use cwd until its Context adds one.
    const workspaceDirectory = process.cwd();
    log.debug("V2 plugin initializing", {
      workspaceDirectory,
    });

    await ensurePluginDirectory();
    autoRefreshModels().catch(() => {});

    // MCP bridge: connect to MCP servers and collect their tools.
    const mcpManager = new McpClientManager();
    let mcpToolEntries: Record<string, any> = {};
    let mcpToolDefs: any[] = [];
    let mcpToolSummaries: Array<{ serverName: string; toolName: string; callName?: string; description?: string; params?: string[] }> = [];
    const mcpEnabled = isDirectMcpEnabled();

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

    // Tools (skills) discovery/execution wiring (same as V1).
    const toolsEnabled = process.env.CURSOR_KILO_ENABLE_OPENCODE_TOOLS !== "false";
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

    // Config providers load after package plugins in V2 and can overwrite the
    // catalog URL. Route at the HTTP boundary as the final source of truth.
    registrations.push(await ctx.session.hook("http.request", async (event) => {
      if (event.model.providerID !== CURSOR_PROVIDER_ID) return;
      event.request = routeRequestToProxy(event.request, proxyBaseURL);
    }));

    // Register the cursor-kilo provider + auth via catalog/integration transforms.
    registrations.push(await ctx.catalog.transform((catalog) => {
      catalog.provider.update(CURSOR_PROVIDER_ID, (p) => {
        p.name = "Cursor";
        p.settings = { ...p.settings, baseURL: proxyBaseURL };
      });
    }));

    registrations.push(await ctx.integration.transform((integrations) => {
      integrations.method.update({
        integrationID: CURSOR_PROVIDER_ID,
        method: { type: "key", label: "Cursor API Key (cursor.com/settings)" },
      });
    }));

    // Register local + MCP tools as V2 tools (best-effort).
    try {
      const toolHookEntries = buildToolHookEntries(localRegistry, workspaceDirectory);
      const allEntries = { ...toolHookEntries, ...mcpToolEntries };

      // Map registry tool names back to their JSON schemas.
      const schemaByName = new Map<string, Record<string, unknown>>();
      for (const t of localRegistry.list()) {
        schemaByName.set(t.name, t.parameters);
      }

      registrations.push(await ctx.tool.transform((tools) => {
        for (const [name, entry] of Object.entries(allEntries)) {
          const def = v2ToolFromV1(name, entry, schemaByName.get(name));
          tools.add(def);
        }
      }));
    } catch (err) {
      log.debug("Tool registration failed", { error: String(err) });
    }

    // Resolve credentials and append the available-tools message on Cursor turns.
    registrations.push(await ctx.session.hook("context", async (event) => {
      const modelRef = event.model;
      const isCursor = modelRef?.providerID === CURSOR_PROVIDER_ID;
      if (!isCursor) return;

      // V1 filled this from auth.loader. In V2 resolve the active integration
      // connection before every Cursor turn so the local proxy gets the key.
      try {
        const connection = await ctx.integration.connection.active(CURSOR_PROVIDER_ID);
        const credential = connection && await ctx.integration.connection.resolve(connection);
        setStoredApiKey(credential?.type === "key" ? credential.key : undefined);
      } catch (err) {
        setStoredApiKey(undefined);
        log.debug("Could not resolve Cursor API key", { error: String(err) });
      }

      const systemMessage = buildAvailableToolsSystemMessage(
        lastToolNames, lastToolMap, mcpToolDefs, mcpToolSummaries,
      );
      if (systemMessage) {
        event.system.push({ type: "text", text: systemMessage });
      }
    }));

    return async () => {
      await Promise.allSettled(registrations.reverse().map((item) => item.dispose()));
      await mcpManager.disconnectAll();
      setStoredApiKey(undefined);
    };
  };
}
