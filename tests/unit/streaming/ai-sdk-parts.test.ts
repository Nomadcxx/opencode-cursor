import { describe, expect, it } from "bun:test";

import { StreamToAiSdkParts } from "../../../src/streaming/ai-sdk-parts.js";

describe("ai-sdk stream parts", () => {
  it("emits text deltas", () => {
    const converter = new StreamToAiSdkParts();

    const first = converter.handleEvent({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Hello" }],
      },
    });

    expect(first).toEqual([{ type: "text-delta", textDelta: "Hello" }]);

    const second = converter.handleEvent({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Hello world" }],
      },
    });

    expect(second).toEqual([{ type: "text-delta", textDelta: " world" }]);
  });

  it("emits thinking deltas from assistant message", () => {
    const converter = new StreamToAiSdkParts();

    const parts = converter.handleEvent({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "thinking", thinking: "Plan" }],
      },
    });

    expect(parts).toEqual([{ type: "text-delta", textDelta: "Plan" }]);
  });

  it("emits thinking deltas from real thinking events", () => {
    const converter = new StreamToAiSdkParts();

    const first = converter.handleEvent({
      type: "thinking",
      subtype: "delta",
      text: "Let me analyze",
      session_id: "test",
    });

    expect(first).toEqual([{ type: "text-delta", textDelta: "Let me analyze" }]);

    const second = converter.handleEvent({
      type: "thinking",
      subtype: "delta",
      text: "Let me analyze this problem",
      session_id: "test",
    });

    expect(second).toEqual([{ type: "text-delta", textDelta: " this problem" }]);
  });

  it("emits tool call start and delta", () => {
    const converter = new StreamToAiSdkParts();

    const parts = converter.handleEvent({
      type: "tool_call",
      call_id: "call_1",
      tool_call: {
        readToolCall: { args: { path: "/tmp/file" } },
      },
    });

    expect(parts[0]).toEqual({
      type: "tool-call-streaming-start",
      toolCallId: "call_1",
      toolName: "read",
    });
    expect(parts[1]).toEqual({
      type: "tool-call-delta",
      toolCallId: "call_1",
      toolName: "read",
      argsTextDelta: "{\"path\":\"/tmp/file\"}",
    });
  });

  it("emits tool input when available", () => {
    const converter = new StreamToAiSdkParts();

    const parts = converter.handleEvent({
      type: "tool_call",
      call_id: "call_1",
      tool_call: {
        readToolCall: { result: { content: "hello" } },
      },
    });

    expect(parts).toEqual([
      {
        type: "tool-input-available",
        toolCallId: "call_1",
        toolName: "read",
        inputText: "{\"content\":\"hello\"}",
      },
    ]);
  });
});
