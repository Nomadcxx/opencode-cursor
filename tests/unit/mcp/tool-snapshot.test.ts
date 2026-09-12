import { describe, expect, it } from "bun:test";
import {
  createChatParamToolSnapshotResolver,
  discoverKiloNativeMcpToolDefsSettled,
  fingerprintMcpToolNames,
  hasPendingMcpServers,
} from "../../../src/mcp/tool-snapshot.js";

function mcpTool(name: string) {
  return {
    type: "function",
    function: {
      name,
      description: `MCP tool ${name}`,
      parameters: { type: "object", properties: {} },
    },
  };
}

function mockClient(state: {
  mcpTools?: Array<any>;
  serverStatus?: Record<string, { status: string }>;
  statusCalls?: number;
  listCalls?: number;
}) {
  let listCalls = 0;
  let statusCalls = 0;

  return {
    mcp: {
      status: async () => {
        statusCalls += 1;
        state.statusCalls = statusCalls;
        return { data: state.serverStatus ?? {} };
      },
      tool: {
        list: async () => {
          listCalls += 1;
          state.listCalls = listCalls;
          return { data: { tools: state.mcpTools ?? [] } };
        },
      },
    },
  };
}

describe("mcp/tool-snapshot", () => {
  it("detects pending MCP servers", async () => {
    const client = mockClient({
      serverStatus: {
        openviking: { status: "connecting" },
        context7: { status: "connected" },
      },
    });
    await expect(hasPendingMcpServers(client)).resolves.toBe(true);
  });

  it("returns false when all MCP servers are connected", async () => {
    const client = mockClient({
      serverStatus: {
        openviking: { status: "connected" },
      },
    });
    await expect(hasPendingMcpServers(client)).resolves.toBe(false);
  });

  it("polls MCP discovery until servers settle", async () => {
    const state = {
      mcpTools: [] as Array<any>,
      serverStatus: { openviking: { status: "connecting" } },
    };

    const client = {
      mcp: {
        status: async () => ({ data: state.serverStatus }),
        tool: {
          list: async () => {
            if (state.serverStatus.openviking.status === "connecting") {
              state.serverStatus = { openviking: { status: "connected" } };
              state.mcpTools = [{ name: "openviking_search", description: "search" }];
            }
            return { data: { tools: state.mcpTools } };
          },
        },
      },
    };

    const tools = await discoverKiloNativeMcpToolDefsSettled(client, {
      maxWaitMs: 1000,
      pollIntervalMs: 50,
      stablePolls: 2,
    });

    expect(tools.map((t) => t.function.name)).toContain("openviking_search");
  });

  it("reuses cached snapshot when fingerprint is unchanged", async () => {
    const state = {
      mcpTools: [{ name: "openviking_search", description: "search" }],
      serverStatus: { openviking: { status: "connected" } },
      listCalls: 0,
    };
    const client = mockClient(state);

    const resolver = createChatParamToolSnapshotResolver(client, {
      discovery: { enabled: true, maxWaitMs: 500, pollIntervalMs: 25, stablePolls: 1 },
    });

    const first = await resolver.resolve([
      { type: "function", function: { name: "read", description: "read", parameters: {} } },
    ]);
    const second = await resolver.resolve([
      { type: "function", function: { name: "read", description: "read", parameters: {} } },
    ]);

    expect(first.cacheHit).toBe(false);
    expect(second.cacheHit).toBe(true);
    expect(second.tools).toBe(first.tools);
    expect(state.listCalls).toBe(2);
  });

  it("re-snapshots when MCP tools appear", async () => {
    const state = {
      mcpTools: [] as Array<any>,
      serverStatus: { openviking: { status: "connected" } },
      listCalls: 0,
    };
    const client = mockClient(state);

    const resolver = createChatParamToolSnapshotResolver(client, {
      discovery: { enabled: true, maxWaitMs: 500, pollIntervalMs: 25, stablePolls: 1 },
    });

    const first = await resolver.resolve([]);
    state.mcpTools = [{ name: "openviking_search", description: "search" }];
    const second = await resolver.resolve([]);

    expect(second.fingerprintChanged).toBe(true);
    expect(first.fingerprint).not.toBe(second.fingerprint);
    expect(second.tools.map((t) => t.function.name)).toContain("openviking_search");
    expect(second.tools.map((t) => t.function.name)).toContain("GetDynamicTools");
    expect(second.tools.map((t) => t.function.name).some((name) => name.startsWith("mcp__"))).toBe(false);
  });

  it("merges dynamically registered plugin MCP tools from tool.ids into the snapshot", async () => {
    const client = {
      mcp: {
        status: async () => ({ data: {} }),
        tool: {},
      },
      tool: {
        ids: async () => ({
          data: ["read", "openviking_health", "browser-harness_browser_list_tabs"],
        }),
      },
    };

    const resolver = createChatParamToolSnapshotResolver(client, {
      discovery: { enabled: true, maxWaitMs: 200, pollIntervalMs: 25, stablePolls: 1 },
    });

    const snapshot = await resolver.resolve([
      { type: "function", function: { name: "read", description: "read", parameters: {} } },
    ]);
    const names = snapshot.tools.map((t) => t.function.name);

    expect(names).toContain("read");
    expect(names).toContain("openviking_health");
    expect(names).toContain("browser-harness_browser_list_tabs");
    expect(names).toContain("GetDynamicTools");
  });

  it("backfills the skill tool when chat.params omits it", async () => {
    const client = {
      mcp: {
        status: async () => ({ data: {} }),
        tool: {},
      },
      tool: {
        list: async () => ({ data: [] }),
        ids: async () => ({ data: ["read"] }),
      },
    };

    const resolver = createChatParamToolSnapshotResolver(client, {
      discovery: { enabled: true, maxWaitMs: 200, pollIntervalMs: 25, stablePolls: 1 },
    });

    const snapshot = await resolver.resolve([
      { type: "function", function: { name: "read", description: "read", parameters: {} } },
    ]);
    const names = snapshot.tools.map((t) => t.function.name);

    expect(names).toContain("read");
    expect(names).toContain("skill");
    expect(names).toContain("skill_mcp");
    expect(snapshot.tools.find((t) => t.function.name === "skill")?.function.parameters).toEqual({
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Skill id from available_skills (e.g. superpowers/brainstorming)",
        },
      },
      required: ["name"],
    });
  });

  it("fingerprints MCP tool name lists deterministically", () => {
    expect(
      fingerprintMcpToolNames([
        mcpTool("openviking_read"),
        mcpTool("openviking_search"),
      ]),
    ).toBe("openviking_read|openviking_search");
  });
});
