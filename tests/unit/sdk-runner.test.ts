import { describe, expect, it } from "bun:test";
import { buildModelSelection, sdkMessageToStreamJson } from "../../scripts/sdk-runner.mjs";

describe("sdk-runner buildModelSelection", () => {
  it("keeps model: { id } when params are absent or empty", () => {
    expect(buildModelSelection("claude-opus-5", undefined)).toEqual({ id: "claude-opus-5" });
    expect(buildModelSelection("claude-opus-5", [])).toEqual({ id: "claude-opus-5" });
    expect(buildModelSelection("claude-opus-5", null)).toEqual({ id: "claude-opus-5" });
    expect(buildModelSelection("claude-opus-5", "not-an-array")).toEqual({ id: "claude-opus-5" });
  });

  it("builds model: { id, params } when params are present", () => {
    expect(buildModelSelection("claude-opus-5", [{ id: "effort", value: "max" }])).toEqual({
      id: "claude-opus-5",
      params: [{ id: "effort", value: "max" }],
    });
    expect(
      buildModelSelection("gpt-5.6-sol", [
        { id: "reasoning", value: "high" },
        { id: "fast", value: "true" },
      ]),
    ).toEqual({
      id: "gpt-5.6-sol",
      params: [
        { id: "reasoning", value: "high" },
        { id: "fast", value: "true" },
      ],
    });
  });

  it("drops malformed entries from params while keeping valid ones", () => {
    expect(
      buildModelSelection("claude-opus-5", [
        { id: "effort", value: "high" },
        { id: "bad" },
        { id: "fast", value: true },
        null,
      ]),
    ).toEqual({
      id: "claude-opus-5",
      params: [{ id: "effort", value: "high" }],
    });
  });
});

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
