import { describe, expect, it } from "bun:test";
import {
  createProviderBoundary,
  parseProviderBoundaryMode,
  type ToolLoopMode,
} from "../../src/provider/boundary";

describe("provider boundary", () => {
  it("parses provider boundary mode with v1 default", () => {
    expect(parseProviderBoundaryMode("legacy")).toEqual({ mode: "legacy", valid: true });
    expect(parseProviderBoundaryMode("v1")).toEqual({ mode: "v1", valid: true });
    expect(parseProviderBoundaryMode(undefined)).toEqual({ mode: "v1", valid: true });
    expect(parseProviderBoundaryMode("invalid")).toEqual({ mode: "v1", valid: false });
  });

  it("keeps legacy and v1 resolveChatParamTools behavior identical", () => {
    const legacy = createProviderBoundary("legacy", "cursor-acp");
    const v1 = createProviderBoundary("v1", "cursor-acp");

    const cases: Array<{
      mode: ToolLoopMode;
      existing: unknown;
      refreshed: Array<any>;
    }> = [
      { mode: "opencode", existing: [{ function: { name: "external" } }], refreshed: [] },
      { mode: "opencode", existing: undefined, refreshed: [{ function: { name: "oc_bash" } }] },
      { mode: "proxy-exec", existing: [{ function: { name: "legacy" } }], refreshed: [{ function: { name: "new" } }] },
      { mode: "off", existing: [{ function: { name: "keep" } }], refreshed: [{ function: { name: "ignored" } }] },
      { mode: "proxy-exec", existing: undefined, refreshed: [] },
    ];

    for (const testCase of cases) {
      const lhs = legacy.resolveChatParamTools(testCase.mode, testCase.existing, testCase.refreshed);
      const rhs = v1.resolveChatParamTools(testCase.mode, testCase.existing, testCase.refreshed);
      expect(lhs).toEqual(rhs);
    }
  });

  it("computes loop flags based on tool loop mode and env toggles", () => {
    const boundary = createProviderBoundary("v1", "cursor-acp");

    expect(boundary.computeToolLoopFlags("opencode", true, true)).toEqual({
      proxyExecuteToolCalls: false,
      suppressConverterToolEvents: false,
      shouldEmitToolUpdates: false,
    });

    expect(boundary.computeToolLoopFlags("proxy-exec", true, false)).toEqual({
      proxyExecuteToolCalls: true,
      suppressConverterToolEvents: false,
      shouldEmitToolUpdates: false,
    });

    expect(boundary.computeToolLoopFlags("proxy-exec", false, true)).toEqual({
      proxyExecuteToolCalls: false,
      suppressConverterToolEvents: true,
      shouldEmitToolUpdates: true,
    });
  });

  it("normalizes provider-prefixed model names", () => {
    const boundary = createProviderBoundary("v1", "cursor-acp");
    expect(boundary.normalizeRuntimeModel("cursor-acp/auto")).toBe("auto");
    expect(boundary.normalizeRuntimeModel("cursor-acp/gpt-5.3-codex")).toBe("gpt-5.3-codex");
    expect(boundary.normalizeRuntimeModel("auto")).toBe("auto");
    expect(boundary.normalizeRuntimeModel(undefined)).toBe("auto");
    expect(boundary.normalizeRuntimeModel("   ")).toBe("auto");
  });

  it("prefers merged cursorModel when resolving runtime models", () => {
    const boundary = createProviderBoundary("v1", "cursor-acp");

    expect(
      boundary.resolveRuntimeModel("cursor-acp/gpt-5.3-codex", "gpt-5.3-codex-high"),
    ).toBe("gpt-5.3-codex-high");
    expect(
      boundary.resolveRuntimeModel("cursor-acp/gpt-5.3-codex", "cursor-acp/gpt-5.3-codex-high-fast"),
    ).toBe("gpt-5.3-codex-high-fast");
    expect(
      boundary.resolveRuntimeModel("cursor-acp/gpt-5.3-codex", "   "),
    ).toBe("gpt-5.3-codex");
    expect(
      boundary.resolveRuntimeModel("cursor-acp/gpt-5.3-codex", undefined),
    ).toBe("gpt-5.3-codex");
    expect(boundary.resolveRuntimeModel(undefined, undefined)).toBe("auto");
  });

  it("matches provider across providerID/providerId/provider keys", () => {
    const boundary = createProviderBoundary("v1", "cursor-acp");
    expect(boundary.matchesProvider({ providerID: "cursor-acp" })).toBe(true);
    expect(boundary.matchesProvider({ providerId: "cursor-acp" })).toBe(true);
    expect(boundary.matchesProvider({ provider: "cursor-acp" })).toBe(true);
    expect(boundary.matchesProvider({ providerID: "other" })).toBe(false);
    expect(boundary.matchesProvider(undefined)).toBe(false);
  });

  it("applies chat param defaults without clobbering existing api key", () => {
    const boundary = createProviderBoundary("v1", "cursor-acp");
    const output: any = { options: { apiKey: "existing-key" } };
    boundary.applyChatParamDefaults(output, "http://127.0.0.1:32124/v1", "http://fallback/v1", "cursor-agent");
    expect(output.options.baseURL).toBe("http://127.0.0.1:32124/v1");
    expect(output.options.apiKey).toBe("existing-key");
  });

  it("extracts tool calls only for opencode mode and returns formatted responses", () => {
    const boundary = createProviderBoundary("v1", "cursor-acp");
    const event: any = {
      type: "tool_call",
      call_id: "c1",
      name: "updateTodos",
      tool_call: {
        updateTodos: {
          args: { todos: [{ content: "Book flights", status: "pending" }] },
        },
      },
    };

    const result = boundary.maybeExtractToolCall(event, new Set(["todowrite"]), "opencode");
    expect(result.action).toBe("intercept");
    expect(result.toolCall?.function.name).toBe("todowrite");

    const skipped = boundary.maybeExtractToolCall(event, new Set(["todowrite"]), "proxy-exec");
    expect(skipped.action).toBe("skip");

    const meta = { id: "resp-1", created: 123, model: "auto" };
    const nonStream = boundary.createNonStreamToolCallResponse(meta, result.toolCall!);
    expect(nonStream.choices[0].finish_reason).toBe("tool_calls");

    const stream = boundary.createStreamToolCallChunks(meta, result.toolCall!);
    expect(stream).toHaveLength(2);
    expect(stream[1].choices[0].finish_reason).toBe("tool_calls");
  });
});
