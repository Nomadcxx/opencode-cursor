import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const configHome = mkdtempSync(join(tmpdir(), "open-cursor-opencode2-"));
const previousEnv = {
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  OPENCODE_CONFIG: process.env.OPENCODE_CONFIG,
  CURSOR_ACP_MCP_BRIDGE: process.env.CURSOR_ACP_MCP_BRIDGE,
  CURSOR_ACP_MODEL_AUTO_REFRESH: process.env.CURSOR_ACP_MODEL_AUTO_REFRESH,
  CURSOR_ACP_REUSE_EXISTING_PROXY: process.env.CURSOR_ACP_REUSE_EXISTING_PROXY,
  CURSOR_ACP_OPENCODE2_SKIP_DISCOVERY: process.env.CURSOR_ACP_OPENCODE2_SKIP_DISCOVERY,
};

process.env.XDG_CONFIG_HOME = configHome;
process.env.OPENCODE_CONFIG = join(configHome, "missing.json");
process.env.CURSOR_ACP_MCP_BRIDGE = "false";
process.env.CURSOR_ACP_MODEL_AUTO_REFRESH = "false";
process.env.CURSOR_ACP_REUSE_EXISTING_PROXY = "false";
process.env.CURSOR_ACP_OPENCODE2_SKIP_DISCOVERY = "1";

const pluginModule = await import("../../src/plugin.js") as typeof import("../../src/plugin.js") & {
  getStoredApiKey?: () => string | undefined;
};
const opencode2 = await import("../../src/plugin-opencode2.js");
const { CURSOR_AISDK_PACKAGE } = await import("../../src/opencode2/catalog.js");
const { toOpenCode2Costs } = await import("../../src/models/pricing.js");

type Registration = { dispose: () => Promise<void> | void };

function registration(onDispose: () => void = () => {}): Registration {
  return { dispose: async () => onDispose() };
}

function createContext(options: { withMcp?: boolean; withSessionGet?: boolean } = {}) {
  const disposed: string[] = [];
  const toolAddCalls: any[][] = [];
  const toolTransforms: Array<(draft: any) => void> = [];
  const providerAdds: any[] = [];
  const hookOptions: Record<string, unknown> = {};
  let modelRequestHook: ((event: any) => Promise<void>) | undefined;
  let sessionContextHook: ((event: any) => Promise<void>) | undefined;
  let providerTransform: ((editor: any) => void) | undefined;
  let mcpTransform: ((editor: any) => void) | undefined;
  let activeConnectionCalls = 0;
  let reloadCalls = 0;
  let credential: any = { type: "key", key: "cursor-key" };
  let models: any[] = [];

  const replayProvider = () => {
    if (!providerTransform) return;
    providerTransform({
      add: (input: any) => {
        providerAdds.push(input);
        models = input.models ?? [];
      },
    });
  };

  const context: any = {
    integration: {
      transform: async (callback: (draft: any) => void) => {
        callback({
          update: () => {},
          method: { update: () => {} },
        });
        return registration(() => disposed.push("integration"));
      },
      reload: async () => {},
      connection: {
        active: async () => {
          activeConnectionCalls += 1;
          return { type: "credential", id: "cursor-connection", label: "key" };
        },
        resolve: async () => credential,
      },
    },
    provider: {
      transform: async (callback: (editor: any) => void) => {
        providerTransform = callback;
        replayProvider();
        return registration(() => disposed.push("provider"));
      },
      reload: async () => {
        reloadCalls += 1;
        // Stable OpenCode 2.0 replays provider transforms on reload().
        replayProvider();
      },
    },
    tool: {
      transform: async (callback: (draft: any) => void) => {
        toolTransforms.push(callback);
        callback({ add: (...args: any[]) => toolAddCalls.push(args), list: () => [], update: () => {} });
        return registration(() => disposed.push("tool"));
      },
      reload: async () => {},
    },
    session: {
      hook: async (name: string, callback: (event: any) => Promise<void>, opts?: unknown) => {
        hookOptions[name] = opts;
        if (name === "context") {
          sessionContextHook = callback;
          return registration(() => disposed.push("session:context"));
        }
        if (name === "model.request") {
          modelRequestHook = callback;
          return registration(() => disposed.push("session:model.request"));
        }
        throw new Error(`Unexpected session hook: ${name}`);
      },
      ...(options.withSessionGet
        ? {
            get: async ({ sessionID }: { sessionID: string }) => ({
              id: sessionID,
              location: { directory: `/projects/${sessionID}` },
            }),
          }
        : {}),
    },
    location: { directory: process.cwd() },
  };

  if (options.withMcp) {
    context.mcp = {
      transform: async (callback: (editor: any) => void) => {
        mcpTransform = callback;
        return registration(() => disposed.push("mcp"));
      },
    };
  }

  return {
    context,
    disposed,
    toolAddCalls,
    toolTransforms,
    providerAdds,
    hookOptions,
    models: () => models,
    reloadCalls: () => reloadCalls,
    activeConnectionCalls: () => activeConnectionCalls,
    resetActiveConnectionCalls: () => {
      activeConnectionCalls = 0;
    },
    setCredential: (value: any) => {
      credential = value;
    },
    modelRequestHook: () => modelRequestHook,
    sessionContextHook: () => sessionContextHook,
    mcpTransform: () => mcpTransform,
  };
}

afterAll(() => {
  for (const [name, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(configHome, { recursive: true, force: true });
});

describe("opencode 2.0 stable adapter", () => {
  test("publishes openai-compatible inventory via provider.transform", async () => {
    const fixture = createContext();

    const cleanup = await opencode2.default.setup(fixture.context);

    expect(fixture.providerAdds.length).toBeGreaterThan(0);
    const latest = fixture.providerAdds[fixture.providerAdds.length - 1];
    expect(latest.info.id).toBe("cursor-acp");
    expect(latest.info.package).toBe(CURSOR_AISDK_PACKAGE);
    expect(latest.info.package).toBe("aisdk:@ai-sdk/openai-compatible");
    expect(latest.info.settings.baseURL).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);
    expect(latest.models.length).toBeGreaterThan(0);
    expect(latest.models[0]).toEqual(
      expect.objectContaining({
        id: expect.any(String),
        modelID: expect.any(String),
        providerID: "cursor-acp",
        status: "active",
        enabled: true,
      }),
    );
    expect(fixture.reloadCalls()).toBeGreaterThan(0);
    await cleanup?.();
  });

  test("does not use ctx.catalog", async () => {
    const fixture = createContext();
    const context = {
      ...fixture.context,
      catalog: {
        transform: async () => {
          throw new Error("catalog must not be used on stable OpenCode 2.0");
        },
      },
    };

    const cleanup = await opencode2.default.setup(context);
    expect(cleanup).toBeTypeOf("function");
    await cleanup?.();
  });

  test("registers no plugin tools, so host builtins are never replaced", async () => {
    const fixture = createContext({ withMcp: true });

    const cleanup = await opencode2.default.setup(fixture.context);

    expect(fixture.toolAddCalls).toEqual([]);
    await cleanup?.();
  });

  test("moves MCP tools onto the direct catalog without writing server config", async () => {
    const fixture = createContext({ withMcp: true });
    const cleanup = await opencode2.default.setup(fixture.context);

    fixture.mcpTransform()!({
      list: () => [
        ["github", { type: "local" }],
        ["executor", { type: "local", codemode: true }],
      ],
    });

    const tools = [
      { id: "github_create_pr", options: { namespace: "github", codemode: true, pinned: true } },
      { id: "executor_run", options: { namespace: "executor", codemode: true } },
      { id: "read", options: { codemode: false } },
    ];
    const updated: Record<string, any> = {};
    for (const transform of fixture.toolTransforms) {
      transform({
        list: () => tools,
        update: (id: string, update: (draft: any) => void) => {
          const draft = { options: { ...tools.find((t) => t.id === id)!.options } };
          update(draft);
          updated[id] = draft.options;
        },
      });
    }

    expect(updated).toEqual({ github_create_pr: { namespace: "github", codemode: false } });
    await cleanup?.();
  });

  test("model.request sends the session workspace directory to the proxy", async () => {
    const fixture = createContext({ withSessionGet: true });
    const cleanup = await opencode2.default.setup(fixture.context);
    expect(fixture.hookOptions["model.request"]).toEqual({ providerID: "cursor-acp" });

    const event = { sessionID: "ses_a", model: { providerID: "cursor-acp" }, headers: {} as Record<string, string> };
    await fixture.modelRequestHook()!(event);
    expect(event.headers["x-opencode-directory"]).toBe(encodeURIComponent("/projects/ses_a"));

    const other = { sessionID: "ses_b", model: { providerID: "ollama" }, headers: {} as Record<string, string> };
    await fixture.modelRequestHook()!(other);
    expect(other.headers).toEqual({});
    await cleanup?.();
  });

  test("model.request falls back to the plugin location without session.get", async () => {
    const fixture = createContext();
    const cleanup = await opencode2.default.setup(fixture.context);

    const event = { sessionID: "ses_a", model: { providerID: "cursor-acp" }, headers: {} as Record<string, string> };
    await fixture.modelRequestHook()!(event);
    expect(decodeURIComponent(event.headers["x-opencode-directory"])).toBe(process.cwd());
    await cleanup?.();
  });

  test("resolves Cursor credentials only for cursor-acp turns", async () => {
    const fixture = createContext();
    const cleanup = await opencode2.default.setup(fixture.context);
    expect(fixture.hookOptions.context).toEqual({ providerID: "cursor-acp" });
    fixture.resetActiveConnectionCalls();

    await fixture.sessionContextHook()!({
      model: { providerID: "ollama" },
      system: [],
      tools: {},
    });
    expect(fixture.activeConnectionCalls()).toBe(0);

    expect(pluginModule.getStoredApiKey).toBeTypeOf("function");
    const system: any[] = [];
    await fixture.sessionContextHook()!({
      model: { providerID: "cursor-acp" },
      system,
      tools: {},
    });
    expect(pluginModule.getStoredApiKey!()).toBe("cursor-key");
    // No MCP domain → no direct-MCP guidance and no local tool advertisement.
    expect(system).toEqual([]);

    fixture.setCredential(undefined);
    await fixture.sessionContextHook()!({
      model: { providerID: "cursor-acp" },
      system: [],
      tools: {},
    });
    expect(pluginModule.getStoredApiKey!()).toBeUndefined();
    await cleanup?.();
  });

  test("adds direct-MCP guidance when MCP servers are placed on the direct catalog", async () => {
    const fixture = createContext({ withMcp: true });
    const cleanup = await opencode2.default.setup(fixture.context);
    fixture.mcpTransform()!({ list: () => [["github", { type: "local" }]] });

    const system: any[] = [];
    await fixture.sessionContextHook()!({ model: { providerID: "cursor-acp" }, system, tools: {} });

    expect(system).toHaveLength(1);
    expect(system[0].text).toContain("called directly");
    await cleanup?.();
  });

  test("cleanup disposes OpenCode 2.0 registrations", async () => {
    const fixture = createContext({ withMcp: true });
    const cleanup = await opencode2.default.setup(fixture.context);

    expect(cleanup).toBeTypeOf("function");
    await cleanup!();
    expect(fixture.disposed.sort()).toEqual([
      "integration",
      "mcp",
      "provider",
      "session:context",
      "session:model.request",
      "tool",
    ]);
  });
});

describe("OpenCode 2.0 credential events", () => {
  test("only Cursor credential changes trigger rediscovery", () => {
    expect(opencode2.isCursorCredentialEvent({ type: "credential.updated", data: {} })).toBe(true);
    expect(
      opencode2.isCursorCredentialEvent({ type: "credential.switched", data: { integrationID: "cursor-acp" } }),
    ).toBe(true);
    expect(
      opencode2.isCursorCredentialEvent({ type: "credential.switched", data: { integrationID: "openai" } }),
    ).toBe(false);
    expect(opencode2.isCursorCredentialEvent({ type: "session.updated", data: {} })).toBe(false);
  });
});

describe("proxy workspace directory header", () => {
  test("uses an absolute URI-encoded header, else the fallback", () => {
    const { resolveRequestWorkspaceDirectory } = pluginModule;
    expect(resolveRequestWorkspaceDirectory(encodeURIComponent("/work/my project"), "/fallback")).toBe(
      "/work/my project",
    );
    expect(resolveRequestWorkspaceDirectory(undefined, "/fallback")).toBe("/fallback");
    expect(resolveRequestWorkspaceDirectory("relative/dir", "/fallback")).toBe("/fallback");
    expect(resolveRequestWorkspaceDirectory("%E0%A4%A", "/fallback")).toBe("/fallback");
  });
});

describe("OpenCode 2.0 cost mapping", () => {
  test("toOpenCode2Costs preserves long-context tiers", () => {
    const costs = toOpenCode2Costs({
      input: 3,
      output: 15,
      cache_read: 0.3,
      cache_write: 3.75,
      context_over_200k: {
        input: 6,
        output: 22.5,
        cache_read: 0.6,
        cache_write: 7.5,
      },
    });

    expect(costs).toEqual([
      {
        input: 3,
        output: 15,
        cache: { read: 0.3, write: 3.75 },
      },
      {
        tier: { type: "context", size: 200_000 },
        input: 6,
        output: 22.5,
        cache: { read: 0.6, write: 7.5 },
      },
    ]);
  });
});
