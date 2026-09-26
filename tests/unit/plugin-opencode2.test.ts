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

function createContext(options: { supportHttpRequest?: boolean } = {}) {
  const supportHttpRequest = options.supportHttpRequest !== false;
  const disposed: string[] = [];
  const toolAddCalls: any[][] = [];
  const providerAdds: any[] = [];
  let httpRequestHook: ((event: any) => Promise<void>) | undefined;
  let sessionContextHook: ((event: any) => Promise<void>) | undefined;
  let providerTransform: ((editor: any) => void) | undefined;
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

  const context = {
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
        callback({ add: (...args: any[]) => toolAddCalls.push(args) });
        return registration(() => disposed.push("tool"));
      },
      reload: async () => {},
    },
    session: {
      hook: async (name: string, callback: (event: any) => Promise<void>) => {
        if (name === "context") {
          sessionContextHook = callback;
          return registration(() => disposed.push("session:context"));
        }
        if (name === "http.request") {
          if (!supportHttpRequest) {
            throw new Error("http.request not supported");
          }
          httpRequestHook = callback;
          return registration(() => disposed.push("session:http.request"));
        }
        throw new Error(`Unexpected session hook: ${name}`);
      },
    },
    location: { directory: process.cwd() },
  };

  return {
    context,
    disposed,
    toolAddCalls,
    providerAdds,
    models: () => models,
    reloadCalls: () => reloadCalls,
    activeConnectionCalls: () => activeConnectionCalls,
    resetActiveConnectionCalls: () => {
      activeConnectionCalls = 0;
    },
    setCredential: (value: any) => {
      credential = value;
    },
    httpRequestHook: () => httpRequestHook,
    sessionContextHook: () => sessionContextHook,
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

  test("registers direct-catalog tools (codemode false)", async () => {
    const fixture = createContext();

    const cleanup = await opencode2.default.setup(fixture.context);

    expect(fixture.toolAddCalls.length).toBeGreaterThan(0);
    for (const args of fixture.toolAddCalls) {
      expect(args).toHaveLength(1);
      expect(args[0]).toEqual(
        expect.objectContaining({
          name: expect.any(String),
          description: expect.any(String),
          input: expect.any(Object),
          output: expect.any(Object),
          execute: expect.any(Function),
          options: { codemode: false },
        }),
      );
    }
    await cleanup?.();
  });

  test("routes Cursor HTTP requests to the live proxy when the hook exists", async () => {
    const fixture = createContext({ supportHttpRequest: true });
    const cleanup = await opencode2.default.setup(fixture.context);
    const event = {
      model: { providerID: "cursor-acp" },
      request: new Request("http://127.0.0.1:9/v1/chat/completions", {
        method: "POST",
        body: "probe",
      }),
    };

    await fixture.httpRequestHook()!(event);

    expect(event.request.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1\/chat\/completions$/);
    expect(event.request.url).not.toContain(":9/");
    expect(await event.request.text()).toBe("probe");
    await cleanup?.();
  });

  test("still starts when http.request is unavailable", async () => {
    const fixture = createContext({ supportHttpRequest: false });

    const cleanup = await opencode2.default.setup(fixture.context);

    expect(cleanup).toBeTypeOf("function");
    expect(fixture.httpRequestHook()).toBeUndefined();
    expect(fixture.providerAdds.length).toBeGreaterThan(0);
    await cleanup?.();
  });

  test("resolves Cursor credentials only for cursor-acp turns", async () => {
    const fixture = createContext();
    const cleanup = await opencode2.default.setup(fixture.context);
    fixture.resetActiveConnectionCalls();

    await fixture.sessionContextHook()!({
      model: { providerID: "ollama" },
      system: [],
      tools: {},
    });
    expect(fixture.activeConnectionCalls()).toBe(0);

    expect(pluginModule.getStoredApiKey).toBeTypeOf("function");
    await fixture.sessionContextHook()!({
      model: { providerID: "cursor-acp" },
      system: [],
      tools: {},
    });
    expect(pluginModule.getStoredApiKey!()).toBe("cursor-key");

    fixture.setCredential(undefined);
    await fixture.sessionContextHook()!({
      model: { providerID: "cursor-acp" },
      system: [],
      tools: {},
    });
    expect(pluginModule.getStoredApiKey!()).toBeUndefined();
    await cleanup?.();
  });

  test("cleanup disposes OpenCode 2.0 registrations", async () => {
    const fixture = createContext();
    const cleanup = await opencode2.default.setup(fixture.context);

    expect(cleanup).toBeTypeOf("function");
    await cleanup!();
    expect(fixture.disposed.sort()).toEqual([
      "integration",
      "provider",
      "session:context",
      "session:http.request",
      "tool",
    ]);
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
