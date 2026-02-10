import { describe, expect, it } from "bun:test";
import {
  createToolCallCompletionResponse,
  createToolCallStreamChunks,
  extractAllowedToolNames,
  extractOpenAiToolCall,
} from "../../../src/proxy/tool-loop.js";

describe("proxy/tool-loop", () => {
  it("extracts allowed names from OpenAI tools array", () => {
    const tools = [
      {
        type: "function",
        function: { name: "oc_read", description: "Read file", parameters: {} },
      },
      { function: { name: "oc_write" } },
      { name: "oc_misc" },
      {},
    ];

    const names = extractAllowedToolNames(tools);
    expect(names.has("oc_read")).toBe(true);
    expect(names.has("oc_write")).toBe(true);
    expect(names.has("oc_misc")).toBe(true);
    expect(names.size).toBe(3);
  });

  it("extracts an allowed tool call from event", () => {
    const event: any = {
      type: "tool_call",
      call_id: "call_1",
      name: "oc_read",
      tool_call: {
        oc_read: {
          args: { path: "/tmp/hello.txt" },
        },
      },
    };

    const call = extractOpenAiToolCall(event, new Set(["oc_read"]));
    expect(call).not.toBeNull();
    expect(call?.id).toBe("call_1");
    expect(call?.function.name).toBe("oc_read");
    expect(call?.function.arguments).toBe("{\"path\":\"/tmp/hello.txt\"}");
  });

  it("normalizes *ToolCall names from cursor events", () => {
    const event: any = {
      type: "tool_call",
      call_id: "call_2",
      tool_call: {
        readToolCall: {
          args: { path: "foo.txt" },
        },
      },
    };

    const call = extractOpenAiToolCall(event, new Set(["read"]));
    expect(call).not.toBeNull();
    expect(call?.function.name).toBe("read");
    expect(call?.function.arguments).toBe("{\"path\":\"foo.txt\"}");
  });

  it("ignores tool calls not present in allowed names", () => {
    const event: any = {
      type: "tool_call",
      call_id: "call_3",
      name: "oc_brainstorm",
      tool_call: {
        oc_brainstorm: {
          args: { topic: "test" },
        },
      },
    };

    const call = extractOpenAiToolCall(event, new Set(["oc_other"]));
    expect(call).toBeNull();
  });

  it("maps updateTodos alias to allowed todowrite tool name", () => {
    const event: any = {
      type: "tool_call",
      call_id: "call_4",
      name: "updateTodos",
      tool_call: {
        updateTodos: {
          args: { todos: [{ content: "Book flights", status: "pending" }] },
        },
      },
    };

    const call = extractOpenAiToolCall(event, new Set(["todowrite"]));
    expect(call).not.toBeNull();
    expect(call?.function.name).toBe("todowrite");
  });

  it("builds valid non-stream tool call response", () => {
    const response = createToolCallCompletionResponse(
      { id: "resp-1", created: 123, model: "cursor-acp/auto" },
      {
        id: "call_9",
        type: "function",
        function: {
          name: "oc_read",
          arguments: "{\"path\":\"a.txt\"}",
        },
      },
    );

    expect(response.object).toBe("chat.completion");
    expect(response.choices[0].finish_reason).toBe("tool_calls");
    expect(response.choices[0].message.role).toBe("assistant");
    expect(response.choices[0].message.tool_calls[0].function.name).toBe("oc_read");
  });

  it("builds valid stream chunks with tool_calls finish reason", () => {
    const chunks = createToolCallStreamChunks(
      { id: "resp-2", created: 456, model: "cursor-acp/auto" },
      {
        id: "call_10",
        type: "function",
        function: {
          name: "oc_write",
          arguments: "{\"path\":\"b.txt\",\"content\":\"x\"}",
        },
      },
    );

    expect(chunks).toHaveLength(2);
    expect(chunks[0].choices[0].delta.tool_calls[0].function.name).toBe("oc_write");
    expect(chunks[0].choices[0].finish_reason).toBeNull();
    expect(chunks[1].choices[0].finish_reason).toBe("tool_calls");
  });
});
