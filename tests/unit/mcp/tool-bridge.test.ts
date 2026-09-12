import { describe, expect, it, vi } from "bun:test";
import {
  buildMcpToolDefinitions,
  buildMcpToolHookEntries,
  namespaceMcpTool,
} from "../../../src/mcp/tool-bridge.js";

describe("mcp/tool-bridge", () => {
  it("creates tool hook entries for discovered MCP tools (dual naming)", () => {
    const mockManager = {
      callTool: vi.fn(async () => "result"),
    };

    const tools = [
      {
        name: "memory_store",
        serverName: "hybrid-memory",
        description: "Store a memory",
        inputSchema: {
          type: "object",
          properties: { key: { type: "string" }, value: { type: "string" } },
          required: ["key", "value"],
        },
      },
    ];

    const entries = buildMcpToolHookEntries(tools as any, mockManager as any);

    expect(Object.keys(entries)).toContain("mcp__hybrid_memory__memory_store");
    expect(Object.keys(entries)).toContain("hybrid_memory_memory_store");
    expect(entries["mcp__hybrid_memory__memory_store"]).toBeDefined();
  });

  it("namespaces tool names as mcp__<server>__<tool> and <server>_<tool>", () => {
    const tools = [
      { name: "search", serverName: "my-server", description: "Search" },
      { name: "store", serverName: "my-server", description: "Store" },
    ];

    const entries = buildMcpToolHookEntries(tools as any, { callTool: async () => "" } as any);

    expect(Object.keys(entries)).toEqual([
      "mcp__my_server__search",
      "my_server_search",
      "my-server_search",
      "mcp__my_server__store",
      "my_server_store",
      "my-server_store",
    ]);
  });

  it("uses one sanitized MCP namespace for hyphenated server and tool names", () => {
    const tools = [
      { name: "memory-search", serverName: "hybrid-memory", description: "Search memory" },
    ];

    expect(namespaceMcpTool("hybrid-memory", "memory-search")).toBe(
      "mcp__hybrid_memory__memory_search",
    );

    const entries = buildMcpToolHookEntries(tools as any, { callTool: async () => "" } as any);
    expect(Object.keys(entries)).toEqual([
      "mcp__hybrid_memory__memory_search",
      "hybrid_memory_memory_search",
      "hybrid-memory_memory-search",
    ]);

    const defs = buildMcpToolDefinitions(tools as any);
    const names = defs.map((d) => d?.function?.name);
    expect(names).toEqual(["hybrid-memory_memory-search"]);
  });

  it("handles tools with no inputSchema", () => {
    const tools = [
      { name: "ping", serverName: "srv", description: "Ping" },
    ];

    const entries = buildMcpToolHookEntries(tools as any, { callTool: async () => "pong" } as any);
    expect(Object.keys(entries)).toContain("mcp__srv__ping");
    expect(Object.keys(entries)).toContain("srv_ping");
  });

  it("deduplicates tool names across servers", () => {
    const tools = [
      { name: "search", serverName: "server-a", description: "Search A" },
      { name: "search", serverName: "server-b", description: "Search B" },
    ];

    const entries = buildMcpToolHookEntries(tools as any, { callTool: async () => "" } as any);
    expect(Object.keys(entries)).toHaveLength(6);
    expect(Object.keys(entries)).toContain("mcp__server_a__search");
    expect(Object.keys(entries)).toContain("server_a_search");
    expect(Object.keys(entries)).toContain("server-a_search");
    expect(Object.keys(entries)).toContain("mcp__server_b__search");
    expect(Object.keys(entries)).toContain("server_b_search");
    expect(Object.keys(entries)).toContain("server-b_search");
  });
});
