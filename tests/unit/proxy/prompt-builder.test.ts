import { describe, expect, it } from "bun:test";
import { buildPromptFromMessages } from "../../../src/proxy/prompt-builder.js";

describe("buildPromptFromMessages", () => {
  it("converts simple text messages", () => {
    const messages = [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Hello" },
    ];
    const result = buildPromptFromMessages(messages, []);
    expect(result).toBe("SYSTEM: You are helpful.\n\nUSER: Hello");
  });

  it("handles array content parts", () => {
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "Part 1" },
          { type: "text", text: "Part 2" },
        ],
      },
    ];
    const result = buildPromptFromMessages(messages, []);
    expect(result).toBe("USER: Part 1\nPart 2");
  });

  it("includes tool definitions as system section", () => {
    const tools = [
      {
        type: "function",
        function: {
          name: "read",
          description: "Read a file",
          parameters: { type: "object", properties: { path: { type: "string" } } },
        },
      },
    ];
    const messages = [{ role: "user", content: "Read foo.txt" }];
    const result = buildPromptFromMessages(messages, tools);

    expect(result).toContain("Available tools:");
    expect(result).toContain("- read: Read a file");
    expect(result).toContain("Parameters:");
    expect(result).toContain("USER: Read foo.txt");
  });

  it("handles role:tool result messages", () => {
    const messages = [
      { role: "user", content: "Read the file" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_1", function: { name: "read", arguments: '{"path":"foo.txt"}' } },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "file contents here" },
    ];
    const result = buildPromptFromMessages(messages, []);

    expect(result).toContain("TOOL_RESULT (call_id: call_1): file contents here");
  });

  it("handles assistant messages with tool_calls", () => {
    const messages = [
      {
        role: "assistant",
        content: "Let me read that file.",
        tool_calls: [
          { id: "call_1", function: { name: "read", arguments: '{"path":"foo.txt"}' } },
        ],
      },
    ];
    const result = buildPromptFromMessages(messages, []);

    expect(result).toContain("ASSISTANT: Let me read that file.");
    expect(result).toContain('tool_call(id: call_1, name: read, args: {"path":"foo.txt"})');
  });

  it("handles assistant tool_calls without content", () => {
    const messages = [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_1", function: { name: "bash", arguments: '{"command":"ls"}' } },
        ],
      },
    ];
    const result = buildPromptFromMessages(messages, []);

    expect(result).toContain("ASSISTANT: tool_call(id: call_1, name: bash");
    expect(result).not.toContain("null");
  });

  it("handles full multi-turn tool conversation", () => {
    const tools = [
      {
        type: "function",
        function: { name: "read", description: "Read a file", parameters: {} },
      },
    ];
    const messages = [
      { role: "system", content: "You are an assistant." },
      { role: "user", content: "Read foo.txt" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "c1", function: { name: "read", arguments: '{"path":"foo.txt"}' } }],
      },
      { role: "tool", tool_call_id: "c1", content: "hello world" },
      { role: "assistant", content: "The file contains: hello world" },
    ];
    const result = buildPromptFromMessages(messages, tools);

    // Should have tool definitions section
    expect(result).toContain("Available tools:");
    // Should have the user message
    expect(result).toContain("USER: Read foo.txt");
    // Should have the tool call
    expect(result).toContain("tool_call(id: c1, name: read");
    // Should have the tool result
    expect(result).toContain("TOOL_RESULT (call_id: c1): hello world");
    // Should have the final assistant message
    expect(result).toContain("ASSISTANT: The file contains: hello world");
  });

  it("skips non-text content parts", () => {
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "Hello" },
          { type: "image_url", image_url: { url: "data:..." } },
        ],
      },
    ];
    const result = buildPromptFromMessages(messages, []);
    expect(result).toBe("USER: Hello");
  });

  it("handles empty messages array", () => {
    expect(buildPromptFromMessages([], [])).toBe("");
  });

  it("handles empty tools array", () => {
    const result = buildPromptFromMessages([{ role: "user", content: "Hi" }], []);
    expect(result).not.toContain("Available tools:");
    expect(result).toBe("USER: Hi");
  });

  it("appends continuation suffix after tool result messages", () => {
    const messages = [
      { role: "user", content: "Read the file" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_1", function: { name: "read", arguments: '{"path":"foo.txt"}' } },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "file contents here" },
    ];
    const result = buildPromptFromMessages(messages, []);

    expect(result).toContain("TOOL_RESULT (call_id: call_1): file contents here");
    expect(result).toContain(
      "The above tool calls have been executed. Continue your response based on these results."
    );
  });

  it("does not append continuation suffix when no tool results present", () => {
    const messages = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there" },
    ];
    const result = buildPromptFromMessages(messages, []);

    expect(result).not.toContain("The above tool calls have been executed");
  });

  it("appends continuation suffix once after multiple tool results", () => {
    const messages = [
      { role: "user", content: "Read both files" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_1", function: { name: "read", arguments: '{"path":"a.txt"}' } },
          { id: "call_2", function: { name: "read", arguments: '{"path":"b.txt"}' } },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "contents of a" },
      { role: "tool", tool_call_id: "call_2", content: "contents of b" },
    ];
    const result = buildPromptFromMessages(messages, []);

    expect(result).toContain("TOOL_RESULT (call_id: call_1): contents of a");
    expect(result).toContain("TOOL_RESULT (call_id: call_2): contents of b");

    // Suffix appears exactly once
    const suffixCount = result.split(
      "The above tool calls have been executed"
    ).length - 1;
    expect(suffixCount).toBe(1);
  });
});
