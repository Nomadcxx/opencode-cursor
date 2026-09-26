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
 * Tools: this entry registers no plugin tools. OpenCode 2.0 ships its own
 * permission-checked `read` / `shell` / `glob` / `grep` / `edit` / `write` /
 * `subagent` builtins and connects MCP servers itself; `editor.add` would
 * replace a host tool of the same name for every provider in the location.
 * The proxy's default tool loop forwards Cursor tool calls that match the
 * advertised host catalog and leaves the rest to Cursor.
 *
 * Load only as: `{ "plugin": ["@rama_nigg/open-cursor/plugin/opencode2"] }`
 * Do not also load the classic root entry under OpenCode 2.0.
 */
import { resolveSdkApiKey } from "./auth.js";
import { shouldEnableCursorPlugin } from "./plugin-toggle.js";
import { createLogger } from "./utils/logger.js";
import {
  CURSOR_PROVIDER_ID,
  OPENCODE_DIRECTORY_HEADER,
  ensureCursorProxyServer,
  setStoredApiKey,
} from "./plugin.js";
import { discoverModelsForRefresh, type DiscoveredModel } from "./models/sync.js";
import { ModelDiscoveryService } from "./models/discovery.js";
import { applyCursorProviderInventory, CURSOR_INTEGRATION_ID } from "./opencode2/catalog.js";
import { applyCursorIntegration, resolveCursorApiKey } from "./opencode2/integration.js";
import { exposeDirectMcpTools, rememberDirectMcpNamespaces } from "./opencode2/mcp-direct.js";
import type { Cleanup, ConnectionInfo, Plugin2, PluginContext } from "./opencode2/types.js";

const log = createLogger("plugin-opencode2");

/** Static picker seed when live discovery has not completed yet. */
const FALLBACK_MODELS: DiscoveredModel[] = [
  { id: "auto", name: "Auto" },
  { id: "composer-2", name: "Composer 2" },
  { id: "composer-1.5", name: "Composer 1.5" },
];

/**
 * OpenCode's `<mcp_instructions>` tell the model to reach a server through
 * Code Mode `execute` whenever the server config leaves `codemode` unset.
 * That sentence reads server config, not the tool option this plugin clears.
 */
const DIRECT_MCP_GUIDANCE =
  "MCP tools that appear in your tool list are called directly by their listed name. " +
  "Use `execute` only for tools that are not in that list.";

async function discoverModels(apiKey: string | undefined): Promise<DiscoveredModel[]> {
  const resolveApiKey = () =>
    resolveSdkApiKey({ env: process.env, storedApiKey: apiKey });

  try {
    const discovered = await discoverModelsForRefresh({ resolveApiKey });
    if (discovered.length > 0) return discovered;
  } catch (err) {
    log.debug("Model discovery via refresh path failed", { error: String(err) });
  }

  try {
    const service = new ModelDiscoveryService({ cacheTTL: 0 });
    const models = await service.discover(resolveApiKey());
    if (models.length > 0) {
      return models.map((model) => ({ id: model.id, name: model.name }));
    }
  } catch (err) {
    log.debug("ModelDiscoveryService failed; using static fallback", { error: String(err) });
  }

  return FALLBACK_MODELS;
}

function eventPayload(event: any): any {
  if (event?.data && typeof event.data === "object") return event.data;
  if (event?.properties && typeof event.properties === "object") return event.properties;
  return event;
}

/** True for credential events that may change the active Cursor key. */
export function isCursorCredentialEvent(event: any): boolean {
  if (event?.type !== "credential.switched" && event?.type !== "credential.updated") return false;
  // `credential.updated` carries no integration id; treat it as a possible change.
  const integrationID = eventPayload(event)?.integrationID;
  return !integrationID || integrationID === CURSOR_INTEGRATION_ID;
}

/** Workspace directory of the session, falling back to the plugin location. */
async function sessionDirectory(
  ctx: PluginContext,
  sessionID: string,
  fallback: string,
): Promise<string> {
  if (typeof ctx.session.get !== "function") return fallback;
  try {
    const info = await ctx.session.get({ sessionID });
    // OpenCode 2.0 `Session.Info` nests it under `location.directory`; accept a
    // flat `directory` too so a client-shaped response also resolves.
    return info?.directory || info?.location?.directory || fallback;
  } catch {
    return fallback;
  }
}

function subscribeCredentialEvents(
  ctx: PluginContext,
  onCredentialChange: () => void,
): () => void {
  let stopped = false;
  let iterator: AsyncIterator<unknown> | undefined;
  try {
    const stream = ctx.event?.subscribe() as AsyncIterable<unknown> | undefined;
    if (!stream || typeof stream[Symbol.asyncIterator] !== "function") return () => {};
    iterator = stream[Symbol.asyncIterator]();
    void (async () => {
      while (!stopped) {
        const next = await iterator!.next();
        if (next.done || stopped) break;
        if (isCursorCredentialEvent(next.value)) onCredentialChange();
      }
    })().catch((err) => {
      log.debug("Event subscription ended", { error: String(err) });
    });
  } catch (err) {
    log.debug("Event subscription unavailable", { error: String(err) });
  }
  return () => {
    stopped = true;
    void iterator?.return?.()?.catch?.(() => {});
  };
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

    // The plugin host is location-scoped, but one daemon process serves every
    // location through a single shared proxy. The per-request directory header
    // below is authoritative; this is the fallback.
    const workspaceDirectory = ctx.location?.directory || process.cwd();
    log.debug("OpenCode 2.0 plugin initializing", { workspaceDirectory });

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

    // ── Proxy ────────────────────────────────────────────────
    const proxyBaseURL = await ensureCursorProxyServer(workspaceDirectory);
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

    // Discovery runs against the active integration key, so a later /connect
    // or account switch must rediscover: the prior list may belong to another
    // account or be the keyless fallback. Generations drop stale results.
    let discoveryGeneration = 0;
    const refreshModels = async (): Promise<void> => {
      const generation = ++discoveryGeneration;
      const apiKey = await resolveCursorApiKey(ctx.integration);
      const discovered = await discoverModels(apiKey);
      if (generation !== discoveryGeneration || discovered.length === 0) return;
      await publishModels(discovered);
    };
    const scheduleModelRefresh = () => {
      void refreshModels().catch((err) => {
        log.debug("Background model publish failed", { error: String(err) });
      });
    };

    // Live discovery is async and talks to cursor-agent / the SDK runner. Tests
    // set CURSOR_ACP_OPENCODE2_SKIP_DISCOVERY=1 to keep setup deterministic.
    const discoveryEnabled = process.env.CURSOR_ACP_OPENCODE2_SKIP_DISCOVERY !== "1";
    if (discoveryEnabled) scheduleModelRefresh();
    const unsubscribe = discoveryEnabled
      ? subscribeCredentialEvents(ctx, scheduleModelRefresh)
      : () => {};

    // ── Per-request workspace directory ─────────────────────
    // Headers set here reach the AI SDK call options and therefore the proxy.
    // `settings.baseURL` is the route; the AI SDK path uses its own fetch, so
    // `http.request` hooks would never see these requests.
    await track(
      ctx.session.hook(
        "model.request",
        async (event) => {
          if (event.model?.providerID !== CURSOR_PROVIDER_ID) return;
          const directory = await sessionDirectory(ctx, event.sessionID, workspaceDirectory);
          event.headers[OPENCODE_DIRECTORY_HEADER] = encodeURIComponent(directory);
        },
        { providerID: CURSOR_PROVIDER_ID },
      ),
    );

    // ── MCP: direct catalog placement ───────────────────────
    // Filled by the MCP transform (config is not written) and read whenever
    // the tool transform replays, including after later MCP discovery.
    const directMcpNamespaces = new Set<string>();
    if (ctx.mcp) {
      await track(
        ctx.mcp.transform((editor) => {
          rememberDirectMcpNamespaces(directMcpNamespaces, editor.list());
        }),
      );
      await track(
        ctx.tool.transform((draft) => {
          exposeDirectMcpTools(draft, directMcpNamespaces);
        }),
      );
    }

    // ── Per-turn credential + MCP guidance ──────────────────
    await track(
      ctx.session.hook(
        "context",
        async (event) => {
          if (event.model?.providerID !== CURSOR_PROVIDER_ID) return;

          try {
            const key = await resolveCursorApiKey(ctx.integration);
            setStoredApiKey(key);
          } catch (err) {
            setStoredApiKey(undefined);
            log.debug("Could not resolve Cursor API key", { error: String(err) });
          }

          if (directMcpNamespaces.size > 0) {
            event.system.push({ type: "text", text: DIRECT_MCP_GUIDANCE });
          }
        },
        { providerID: CURSOR_PROVIDER_ID },
      ),
    );

    return async () => {
      unsubscribe();
      discoveryGeneration++;
      for (const registration of registrations.reverse()) {
        try {
          await registration.dispose();
        } catch {
          // best-effort cleanup
        }
      }
      setStoredApiKey(undefined);
    };
  },
};

export default plugin;
