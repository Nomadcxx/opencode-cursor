import { describe, expect, it } from "bun:test";
import { buildUserMessage, sdkMessageToStreamJson } from "../../scripts/sdk-runner.mjs";

describe("sdk-runner buildUserMessage", () => {
  it("returns the plain string when no images are present (identical to today)", () => {
    expect(buildUserMessage("hello", undefined)).toBe("hello");
    expect(buildUserMessage("hello", [])).toBe("hello");
  });

  it("returns a { text, images } object when images are present", () => {
    const message = buildUserMessage("describe this", [
      { data: "AAAB", mimeType: "image/png" },
    ]);
    expect(message).toEqual({
      text: "describe this",
      images: [{ data: "AAAB", mimeType: "image/png" }],
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
