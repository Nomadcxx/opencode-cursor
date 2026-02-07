import { describe, expect, it } from "bun:test";

import {
  extractText,
  extractThinking,
  inferToolName,
  isAssistantText,
  isResult,
  isThinking,
  isToolCall,
} from "../../../src/streaming/types.js";

describe("stream-json types", () => {
  it("extracts assistant text content", () => {
    const event = {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Hello" },
          { type: "text", text: " world" },
        ],
      },
    } as const;

    expect(extractText(event)).toBe("Hello world");
  });

  it("extracts assistant thinking content", () => {
    const event = {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "thinking", thinking: "Let me think" }],
      },
    } as const;

    expect(extractThinking(event)).toBe("Let me think");
  });

  it("infers tool name from tool_call key", () => {
    const event = {
      type: "tool_call",
      tool_call: {
        readToolCall: { args: { path: "/tmp/file" } },
      },
    } as const;

    expect(inferToolName(event)).toBe("read");
  });

  it("keeps tool name if no ToolCall suffix", () => {
    const event = {
      type: "tool_call",
      tool_call: {
        custom: { args: { value: 1 } },
      },
    } as const;

    expect(inferToolName(event)).toBe("custom");
  });

  it("detects assistant text events", () => {
    const event = {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Hi" }],
      },
    } as const;

    expect(isAssistantText(event)).toBe(true);
    expect(isThinking(event)).toBe(false);
  });

  it("detects thinking events in assistant message", () => {
    const event = {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "thinking", thinking: "" }],
      },
    } as const;

    expect(isThinking(event)).toBe(true);
    expect(isAssistantText(event)).toBe(false);
  });

  it("detects real thinking events (type=thinking)", () => {
    const event = {
      type: "thinking",
      subtype: "delta",
      text: "Let me analyze this...",
      session_id: "test-session",
      timestamp_ms: 1700000000000,
    } as const;

    expect(isThinking(event)).toBe(true);
    expect(extractThinking(event)).toBe("Let me analyze this...");
  });

  it("extracts empty string from completed thinking event", () => {
    const event = {
      type: "thinking",
      subtype: "completed",
      session_id: "test-session",
    } as const;

    expect(isThinking(event)).toBe(true);
    expect(extractThinking(event)).toBe("");
  });

  it("detects tool_call and result events", () => {
    const toolEvent = {
      type: "tool_call",
      tool_call: {
        readToolCall: { args: { path: "x" } },
      },
    } as const;
    const resultEvent = {
      type: "result",
      subtype: "success",
    } as const;

    expect(isToolCall(toolEvent)).toBe(true);
    expect(isResult(resultEvent)).toBe(true);
  });
});
