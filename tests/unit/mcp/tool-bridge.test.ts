import { describe, expect, it, vi } from "bun:test";
import {
  buildMcpToolDefinitions,
  buildMcpToolHookEntries,
  namespaceMcpTool,
} from "../../../src/mcp/tool-bridge.js";

describe("mcp/tool-bridge", () => {
  it("creates tool hook entries for discovered MCP tools", () => {
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
    const entry = entries["mcp__hybrid_memory__memory_store"];
    expect(entry).toBeDefined();
  });

  it("namespaces tool names as mcp__<server>__<tool>", () => {
    const tools = [
      { name: "search", serverName: "my-server", description: "Search" },
      { name: "store", serverName: "my-server", description: "Store" },
    ];

    const entries = buildMcpToolHookEntries(tools as any, { callTool: async () => "" } as any);

    expect(Object.keys(entries)).toEqual([
      "mcp__my_server__search",
      "mcp__my_server__store",
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
    expect(Object.keys(entries)).toEqual(["mcp__hybrid_memory__memory_search"]);

    const defs = buildMcpToolDefinitions(tools as any);
    expect(defs[0]?.function?.name).toBe("mcp__hybrid_memory__memory_search");
  });

  it("handles tools with no inputSchema", () => {
    const tools = [
      { name: "ping", serverName: "srv", description: "Ping" },
    ];

    const entries = buildMcpToolHookEntries(tools as any, { callTool: async () => "pong" } as any);
    expect(Object.keys(entries)).toContain("mcp__srv__ping");
  });

  it("deduplicates tool names across servers", () => {
    const tools = [
      { name: "search", serverName: "server-a", description: "Search A" },
      { name: "search", serverName: "server-b", description: "Search B" },
    ];

    const entries = buildMcpToolHookEntries(tools as any, { callTool: async () => "" } as any);
    expect(Object.keys(entries)).toHaveLength(2);
    expect(Object.keys(entries)).toContain("mcp__server_a__search");
    expect(Object.keys(entries)).toContain("mcp__server_b__search");
  });
});
