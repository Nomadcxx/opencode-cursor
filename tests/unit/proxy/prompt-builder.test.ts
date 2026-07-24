import { describe, expect, it, beforeEach } from "bun:test";
import { buildPromptFromMessages, _resetToolSchemaCache } from "../../../src/proxy/prompt-builder.js";

describe("buildPromptFromMessages", () => {
  beforeEach(() => {
    _resetToolSchemaCache();
  });
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

  it("uses the OpenCode task description without appending a separate subagent list", () => {
    const task = {
      type: "function",
      function: {
        name: "task",
        description: [
          "Launch an OpenCode subagent.",
          "- general: built in",
          "- global-proof: global",
          "- project-proof: project local",
        ].join("\n"),
        parameters: {
          type: "object",
          properties: {
            description: { type: "string" },
            prompt: { type: "string" },
            subagent_type: { type: "string" },
          },
          required: ["description", "prompt", "subagent_type"],
        },
      },
    };

    const prompt = buildPromptFromMessages(
      [{ role: "user", content: "delegate" }],
      [task],
    );

    expect(prompt).toContain("global-proof");
    expect(prompt).toContain("project-proof");
    expect(prompt).not.toContain(["When calling", "the task tool"].join(" "));
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

    expect(result).toContain("TOOL_RESULT (name: read, call_id: call_1): file contents here");
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

  it("replays prior full-file edit calls as write examples when write is available", () => {
    const tools = [
      {
        type: "function",
        function: {
          name: "edit",
          parameters: {
            type: "object",
            properties: {
              filePath: { type: "string" },
              oldString: { type: "string" },
              newString: { type: "string" },
            },
            required: ["filePath", "oldString", "newString"],
            additionalProperties: false,
          },
        },
      },
      {
        type: "function",
        function: {
          name: "write",
          parameters: {
            type: "object",
            properties: {
              filePath: { type: "string" },
              content: { type: "string" },
            },
            required: ["filePath", "content"],
            additionalProperties: false,
          },
        },
      },
    ];
    const messages = [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_bad_edit",
            function: {
              name: "edit",
              arguments: '{"filePath":"/tmp/demo.md","content":"full rewrite"}',
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_bad_edit",
        content: 'The edit tool was called with invalid arguments: SchemaError(Missing key at ["oldString"]).',
      },
    ];

    const result = buildPromptFromMessages(messages, tools);

    expect(result).toContain(
      'tool_call(id: call_bad_edit, name: write, args: {"filePath":"/tmp/demo.md","content":"full rewrite"})',
    );
    expect(result).toContain(
      'TOOL_RESULT (name: write, call_id: call_bad_edit): The edit tool was called with invalid arguments: SchemaError(Missing key at ["oldString"]).',
    );
    expect(result).not.toContain("name: edit");
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
    expect(result).toContain("TOOL_RESULT (name: read, call_id: c1): hello world");
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

    expect(result).toContain("TOOL_RESULT (name: read, call_id: call_1): file contents here");
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

    expect(result).toContain("TOOL_RESULT (name: read, call_id: call_1): contents of a");
    expect(result).toContain("TOOL_RESULT (name: read, call_id: call_2): contents of b");

    // Suffix appears exactly once
    const suffixCount = result.split(
      "The above tool calls have been executed"
    ).length - 1;
    expect(suffixCount).toBe(1);
  });

  it("caches tool schema block across calls with same tools", () => {
    const tools = [
      { type: "function", function: { name: "read", description: "Read", parameters: { type: "object" } } },
      { type: "function", function: { name: "write", description: "Write", parameters: { type: "object" } } },
    ];
    const msgs = [{ role: "user", content: "Hello" }];

    const result1 = buildPromptFromMessages(msgs, tools);
    const result2 = buildPromptFromMessages(msgs, tools);

    expect(result1).toBe(result2);
    expect(result1).toContain("read: Read");
    expect(result1).toContain("write: Write");
  });

  it("invalidates cache when tools change", () => {
    const tools1 = [
      { type: "function", function: { name: "read", description: "Read", parameters: { type: "object" } } },
    ];
    const tools2 = [
      { type: "function", function: { name: "read", description: "Read", parameters: { type: "object" } } },
      { type: "function", function: { name: "write", description: "Write", parameters: { type: "object" } } },
    ];
    const msgs = [{ role: "user", content: "Hello" }];

    const result1 = buildPromptFromMessages(msgs, tools1);
    const result2 = buildPromptFromMessages(msgs, tools2);

    expect(result1).not.toBe(result2);
    expect(result1).not.toContain("write: Write");
    expect(result2).toContain("write: Write");
  });

  it("invalidates cache when same-named tool changes schema", () => {
    const tools1 = [
      { type: "function", function: { name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } } },
    ];
    const tools2 = [
      { type: "function", function: { name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" }, encoding: { type: "string" } } } } },
    ];
    const msgs = [{ role: "user", content: "Hello" }];

    const result1 = buildPromptFromMessages(msgs, tools1);
    const result2 = buildPromptFromMessages(msgs, tools2);

    expect(result1).not.toBe(result2);
    expect(result2).toContain("encoding");
  });

  it("invalidates cache when a tool description changes but keeps the same length", () => {
    const tools1 = [
      { type: "function", function: { name: "read", description: "Read a file", parameters: { type: "object" } } },
    ];
    // Same length (11 chars), different content: a length-only fingerprint
    // would falsely hit the cache and resume with a stale tool contract.
    const tools2 = [
      { type: "function", function: { name: "read", description: "Load a file", parameters: { type: "object" } } },
    ];
    const msgs = [{ role: "user", content: "Hello" }];

    const result1 = buildPromptFromMessages(msgs, tools1);
    const result2 = buildPromptFromMessages(msgs, tools2);

    expect(result1).not.toBe(result2);
    expect(result1).toContain("read: Read a file");
    expect(result2).toContain("read: Load a file");
  });

  it("does not mutate the caller's required parameter array", () => {
    const required = ["path", "encoding"];
    const tools = [
      { type: "function", function: { name: "read", description: "Read", parameters: { type: "object", required } } },
    ];
    const msgs = [{ role: "user", content: "Hello" }];

    buildPromptFromMessages(msgs, tools);

    // The caller's array must remain in its original order, not sorted in place.
    expect(required).toEqual(["path", "encoding"]);
  });
});
