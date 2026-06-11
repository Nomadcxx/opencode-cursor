import { describe, expect, it } from "bun:test";
import { sdkMessageToStreamJson } from "../../scripts/sdk-runner.mjs";

describe("sdk-runner MCP remapping", () => {
  it("sanitizes generic SDK mcp tool calls with the same namespace convention as OpenCode MCP tools", () => {
    const event = sdkMessageToStreamJson({
      type: "tool_call",
      call_id: "call-1",
      name: "mcp",
      args: {
        providerIdentifier: "hybrid-memory",
        toolName: "memory-search",
        args: { query: "release notes" },
      },
    });

    expect(event).toEqual({
      type: "tool_call",
      call_id: "call-1",
      tool_call: {
        mcp__hybrid_memory__memory_search: {
          args: { query: "release notes" },
          result: undefined,
        },
      },
    });
  });
});
