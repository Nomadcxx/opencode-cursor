import { describe, expect, it } from "bun:test";

import {
  StreamToSseConverter,
  formatSseChunk,
  formatSseDone,
} from "../../../src/streaming/openai-sse.js";

const parseChunk = (chunk: string) => {
  const trimmed = chunk.trim();
  expect(trimmed.startsWith("data: ")).toBe(true);
  const json = trimmed.replace(/^data:\s*/, "");
  return JSON.parse(json);
};

describe("openai-sse", () => {
  it("formats SSE chunks", () => {
    const chunk = formatSseChunk({ ok: true });

    expect(chunk).toBe("data: {\"ok\":true}\n\n");
    expect(formatSseDone()).toBe("data: [DONE]\n\n");
  });

  it("emits text deltas and tool calls", () => {
    const converter = new StreamToSseConverter("test-model", {
      id: "chunk-id",
      created: 123,
    });

    const first = converter.handleEvent({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Hello" }],
      },
    });

    expect(first).toHaveLength(1);
    expect(parseChunk(first[0]).choices[0].delta.content).toBe("Hello");

    const second = converter.handleEvent({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Hello world" }],
      },
    });

    expect(parseChunk(second[0]).choices[0].delta.content).toBe(" world");

    const toolChunk = converter.handleEvent({
      type: "tool_call",
      call_id: "call_1",
      tool_call: {
        readToolCall: { args: { path: "/tmp/file" } },
      },
    });

    const toolDelta = parseChunk(toolChunk[0]).choices[0].delta;
    expect(toolDelta.tool_calls[0].id).toBe("call_1");
    expect(toolDelta.tool_calls[0].function.name).toBe("read");
    expect(toolDelta.tool_calls[0].function.arguments).toBe("{\"path\":\"/tmp/file\"}");
  });

  it("emits thinking deltas from assistant message", () => {
    const converter = new StreamToSseConverter("test-model", {
      id: "chunk-id",
      created: 123,
    });

    const chunk = converter.handleEvent({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "thinking", thinking: "Plan" }],
      },
    });

    expect(parseChunk(chunk[0]).choices[0].delta.reasoning_content).toBe("Plan");
  });

  it("emits thinking deltas from real thinking events", () => {
    const converter = new StreamToSseConverter("test-model", {
      id: "chunk-id",
      created: 123,
    });

    const first = converter.handleEvent({
      type: "thinking",
      subtype: "delta",
      text: "Analyzing",
      session_id: "test",
    });

    expect(parseChunk(first[0]).choices[0].delta.reasoning_content).toBe("Analyzing");

    const second = converter.handleEvent({
      type: "thinking",
      subtype: "delta",
      text: "Analyzing the problem",
      session_id: "test",
    });

    expect(parseChunk(second[0]).choices[0].delta.reasoning_content).toBe(" the problem");
  });

  it("does not duplicate text when partial (timestamp_ms) events are followed by final accumulated event", () => {
    const converter = new StreamToSseConverter("test-model", {
      id: "chunk-id",
      created: 123,
    });
    const now = Date.now();

    // Simulate real cursor-acp protocol: events with timestamp_ms carry delta text
    const first = converter.handleEvent({
      type: "assistant",
      timestamp_ms: now + 1,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Hello" }],
      },
    } as any);

    expect(first).toHaveLength(1);
    expect(parseChunk(first[0]).choices[0].delta.content).toBe("Hello");

    const second = converter.handleEvent({
      type: "assistant",
      timestamp_ms: now + 2,
      message: {
        role: "assistant",
        content: [{ type: "text", text: " world" }],
      },
    } as any);

    expect(second).toHaveLength(1);
    expect(parseChunk(second[0]).choices[0].delta.content).toBe(" world");

    // Final accumulated event (no timestamp_ms) with full text — should be skipped
    const final = converter.handleEvent({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Hello world" }],
      },
    });

    expect(final).toEqual([]);
  });

  it("does not duplicate thinking when partial (timestamp_ms) events are followed by final accumulated event", () => {
    const converter = new StreamToSseConverter("test-model", {
      id: "chunk-id",
      created: 123,
    });
    const now = Date.now();

    // Thinking events with timestamp_ms carry delta text
    const first = converter.handleEvent({
      type: "assistant",
      timestamp_ms: now + 1,
      message: {
        role: "assistant",
        content: [{ type: "thinking", thinking: "Let me think" }],
      },
    } as any);

    expect(first).toHaveLength(1);
    expect(parseChunk(first[0]).choices[0].delta.reasoning_content).toBe("Let me think");

    const second = converter.handleEvent({
      type: "assistant",
      timestamp_ms: now + 2,
      message: {
        role: "assistant",
        content: [{ type: "thinking", thinking: " about this" }],
      },
    } as any);

    expect(second).toHaveLength(1);
    expect(parseChunk(second[0]).choices[0].delta.reasoning_content).toBe(" about this");

    // Final accumulated thinking event (no timestamp_ms) — should be skipped
    const final = converter.handleEvent({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "thinking", thinking: "Let me think about this" }],
      },
    });

    expect(final).toEqual([]);
  });

  it("still works with accumulated-only events (no timestamp_ms) via DeltaTracker", () => {
    const converter = new StreamToSseConverter("test-model", {
      id: "chunk-id",
      created: 123,
    });

    // Accumulated-only events (no timestamp_ms), like fixture format — should work via DeltaTracker
    const first = converter.handleEvent({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Hello" }],
      },
    });

    expect(first).toHaveLength(1);
    expect(parseChunk(first[0]).choices[0].delta.content).toBe("Hello");

    const second = converter.handleEvent({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Hello world" }],
      },
    });

    expect(second).toHaveLength(1);
    expect(parseChunk(second[0]).choices[0].delta.content).toBe(" world");

    // Duplicate event should produce no output
    const dup = converter.handleEvent({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Hello world" }],
      },
    });

    expect(dup).toEqual([]);
  });

  it("handles empty partial event followed by accumulated - does not skip accumulated", () => {
    const converter = new StreamToSseConverter("test-model", {
      id: "chunk-id",
      created: 123,
    });

    // Empty partial event (with timestamp_ms but no content)
    const emptyPartial = converter.handleEvent({
      type: "assistant",
      timestamp_ms: 1234567890,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "" }],
      },
    });

    // Empty partial should produce no output and NOT set sawAssistantPartials
    expect(emptyPartial).toEqual([]);

    // Accumulated event (no timestamp_ms) should still work via DeltaTracker
    const accumulated = converter.handleEvent({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Hello world" }],
      },
    });

    // Should NOT be skipped - the empty partial didn't set the flag
    expect(accumulated).toHaveLength(1);
    expect(parseChunk(accumulated[0]).choices[0].delta.content).toBe("Hello world");
  });
});
