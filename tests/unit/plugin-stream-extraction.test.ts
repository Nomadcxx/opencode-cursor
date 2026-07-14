import { describe, expect, it } from "bun:test";

import { extractCompletionFromStream } from "../../src/plugin";

describe("extractCompletionFromStream", () => {
  it("does not duplicate assistant text when partial events are followed by final accumulated event", () => {
    const output = [
      JSON.stringify({
        type: "assistant",
        timestamp_ms: 1,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Hello" }],
        },
      }),
      JSON.stringify({
        type: "assistant",
        timestamp_ms: 2,
        message: {
          role: "assistant",
          content: [{ type: "text", text: " world" }],
        },
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Hello world" }],
        },
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Hello world" }],
        },
      }),
    ].join("\n");

    expect(extractCompletionFromStream(output)).toEqual({
      assistantText: "Hello world",
      reasoningText: "",
    });
  });

  it("preserves raw assistant tokens that repeat the emitted prefix", () => {
    const output = [
      { type: "assistant", timestamp_ms: 1, message: { role: "assistant", content: [{ type: "text", text: "**" }] } },
      { type: "assistant", timestamp_ms: 2, message: { role: "assistant", content: [{ type: "text", text: "Heading" }] } },
      { type: "assistant", timestamp_ms: 3, message: { role: "assistant", content: [{ type: "text", text: "**" }] } },
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "**Heading**" }] } },
    ].map((event) => JSON.stringify(event)).join("\n");

    expect(extractCompletionFromStream(output)).toEqual({
      assistantText: "**Heading**",
      reasoningText: "",
    });
  });

  it("keeps snapshot tracking within tool-separated assistant segments", () => {
    const output = [
      { type: "assistant", timestamp_ms: 1, message: { role: "assistant", content: [{ type: "text", text: "Reading" }] } },
      { type: "assistant", timestamp_ms: 2, model_call_id: "call-before-tool", message: { role: "assistant", content: [{ type: "text", text: "Reading" }] } },
      { type: "tool_call", call_id: "tool-1", tool_call: { readToolCall: { args: { path: "package.json" } } } },
      { type: "assistant", timestamp_ms: 3, message: { role: "assistant", content: [{ type: "text", text: "Done" }] } },
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Done" }] } },
    ].map((event) => JSON.stringify(event)).join("\n");

    expect(extractCompletionFromStream(output)).toEqual({
      assistantText: "ReadingDone",
      reasoningText: "",
    });
  });

  it("keeps reasoning across an omitted-subtype tool boundary", () => {
    const output = [
      { type: "thinking", subtype: "delta", timestamp_ms: 1, text: "Plan" },
      { type: "thinking", subtype: "delta", timestamp_ms: 2, model_call_id: "call-before-tool", text: "Plan" },
      { type: "tool_call", call_id: "tool-1", tool_call: { readToolCall: { args: { path: "package.json" } } } },
      { type: "thinking", subtype: "delta", timestamp_ms: 3, text: "Done" },
      { type: "thinking", subtype: "completed", text: "Done" },
    ].map((event) => JSON.stringify(event)).join("\n");

    expect(extractCompletionFromStream(output)).toEqual({
      assistantText: "",
      reasoningText: "PlanDone",
    });
  });

  it("does not duplicate assistant text when partials include a model-call snapshot", () => {
    const output = [
      JSON.stringify({
        type: "assistant",
        timestamp_ms: 1,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Hello" }],
        },
      }),
      JSON.stringify({
        type: "assistant",
        timestamp_ms: 2,
        message: {
          role: "assistant",
          content: [{ type: "text", text: " world" }],
        },
      }),
      JSON.stringify({
        type: "assistant",
        timestamp_ms: 3,
        model_call_id: "model-call-1",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Hello world!" }],
        },
      }),
    ].join("\n");

    expect(extractCompletionFromStream(output)).toEqual({
      assistantText: "Hello world!",
      reasoningText: "",
    });
  });

  it("does not duplicate thinking text when partial events are followed by final accumulated event", () => {
    const output = [
      JSON.stringify({
        type: "thinking",
        subtype: "delta",
        timestamp_ms: 1,
        text: "Plan",
      }),
      JSON.stringify({
        type: "thinking",
        subtype: "delta",
        timestamp_ms: 2,
        text: " more",
      }),
      JSON.stringify({
        type: "thinking",
        text: "Plan more",
      }),
    ].join("\n");

    expect(extractCompletionFromStream(output)).toEqual({
      assistantText: "",
      reasoningText: "Plan more",
    });
  });

  it("does not duplicate thinking text when partials include a model-call snapshot", () => {
    const output = [
      JSON.stringify({
        type: "thinking",
        subtype: "delta",
        timestamp_ms: 1,
        text: "Plan",
      }),
      JSON.stringify({
        type: "thinking",
        subtype: "delta",
        timestamp_ms: 2,
        text: " more",
      }),
      JSON.stringify({
        type: "thinking",
        subtype: "delta",
        timestamp_ms: 3,
        model_call_id: "model-call-1",
        text: "Plan more carefully",
      }),
    ].join("\n");

    expect(extractCompletionFromStream(output)).toEqual({
      assistantText: "",
      reasoningText: "Plan more carefully",
    });
  });

  it("does not duplicate thinking text when multiple final accumulated events arrive without partials", () => {
    // Mirrors the assistant branch: multiple finals should replace, not concatenate.
    const output = [
      JSON.stringify({ type: "thinking", text: "Plan more" }),
      JSON.stringify({ type: "thinking", text: "Plan more" }),
    ].join("\n");

    expect(extractCompletionFromStream(output)).toEqual({
      assistantText: "",
      reasoningText: "Plan more",
    });
  });

  it("replaces a corrected accumulated assistant segment", () => {
    const output = [
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Hello world" }],
        },
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Hello there" }],
        },
      }),
    ].join("\n");

    expect(extractCompletionFromStream(output)).toEqual({
      assistantText: "Hello there",
      reasoningText: "",
    });
  });
});
