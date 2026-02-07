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

    expect(parseChunk(chunk[0]).choices[0].delta.content).toBe("Plan");
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

    expect(parseChunk(first[0]).choices[0].delta.content).toBe("Analyzing");

    const second = converter.handleEvent({
      type: "thinking",
      subtype: "delta",
      text: "Analyzing the problem",
      session_id: "test",
    });

    expect(parseChunk(second[0]).choices[0].delta.content).toBe(" the problem");
  });
});
