import { describe, expect, it } from "bun:test";
import {
  buildModelSelection,
  buildUserMessage,
  cancelRequest,
  isCancelPending,
  registerRun,
  resolveStateRoot,
  sdkMessageToStreamJson,
  unregisterRun,
} from "../../scripts/sdk-runner.mjs";

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
      source: "cursor-sdk",
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

function fakeRun(supportsCancel = true) {
  const run = {
    cancelCalls: 0,
    supports: (op: string) => op !== "cancel" || supportsCancel,
    cancel: async () => {
      run.cancelCalls++;
    },
  };
  return run;
}

describe("sdk-runner cancellation", () => {
  it("cancels a registered run and flags its state", async () => {
    const run = fakeRun();
    const state = registerRun("req-a", run);

    expect(await cancelRequest("req-a")).toBe(true);
    expect(state.cancelled).toBe(true);
    expect(run.cancelCalls).toBe(1);

    // A repeated cancel does not cancel the run twice.
    expect(await cancelRequest("req-a")).toBe(true);
    expect(run.cancelCalls).toBe(1);
    unregisterRun("req-a");
  });

  it("applies a cancel that arrives before the run is registered", async () => {
    expect(await cancelRequest("req-b")).toBe(false);
    expect(isCancelPending("req-b")).toBe(true);

    const run = fakeRun();
    const state = registerRun("req-b", run);
    await Promise.resolve();

    expect(state.cancelled).toBe(true);
    expect(run.cancelCalls).toBe(1);
    expect(isCancelPending("req-b")).toBe(false);
    unregisterRun("req-b");
  });

  it("still flags the state when the run cannot be cancelled", async () => {
    const run = fakeRun(false);
    const state = registerRun("req-c", run);

    expect(await cancelRequest("req-c")).toBe(true);
    expect(state.cancelled).toBe(true);
    expect(run.cancelCalls).toBe(0);
    unregisterRun("req-c");
  });

  it("forgets a pending cancel when the request is unregistered", async () => {
    await cancelRequest("req-d");
    unregisterRun("req-d");
    expect(isCancelPending("req-d")).toBe(false);
  });
});

describe("sdk-runner resolveStateRoot", () => {
  const cwd = "C:\\Users\\me\\OneDrive - Contoso, Inc\\Documents\\some\\deep\\project";

  it("keeps the SDK default store off Windows", () => {
    expect(resolveStateRoot(cwd, {}, "linux", "/home/me")).toBeUndefined();
    expect(resolveStateRoot(cwd, {}, "darwin", "/Users/me")).toBeUndefined();
  });

  it("uses a short per-workspace root on Windows", () => {
    const root = resolveStateRoot(cwd, {}, "win32", "C:\\Users\\me");
    expect(root).toMatch(/[\\/]\.cursor[\\/]oc-sdk[\\/][0-9a-f]{16}$/);
    // Deepest SDK file under the root: agents/agent-<64 hex>/store.db-wal
    expect(root!.length + "/agents/agent-".length + 64 + "/store.db-wal".length).toBeLessThan(260);
    expect(resolveStateRoot(cwd + "2", {}, "win32", "C:\\Users\\me")).not.toBe(root);
  });

  it("honors CURSOR_ACP_SDK_STATE_ROOT on any platform", () => {
    const root = resolveStateRoot(cwd, { CURSOR_ACP_SDK_STATE_ROOT: "/tmp/oc" }, "linux", "/home/me");
    expect(root).toMatch(/^[\\/]tmp[\\/]oc[\\/][0-9a-f]{16}$/);
  });
});
