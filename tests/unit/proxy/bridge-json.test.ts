import { describe, expect, it } from "bun:test";
import {
  applyBridgeJsonPrompt,
  BridgeJsonStreamDetector,
  extractBridgeToolCallFromStreamOutput,
  extractBridgeToolCallFromText,
  isBridgeJsonEnabled,
} from "../../../src/proxy/bridge-json.js";

const delta = (text: string) => ({
  type: "assistant" as const,
  timestamp_ms: Date.now(),
  message: {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
  },
});

const snapshot = (text: string) => ({
  type: "assistant" as const,
  model_call_id: "call-1",
  message: {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
  },
});

const TASK_JSON = JSON.stringify({
  name: "task",
  arguments: {
    description: "Run project proof",
    prompt: "Follow your configured instructions.",
    subagent_type: "project-proof",
  },
});

describe("proxy/bridge-json", () => {
  it("extracts a strict write bridge response into an OpenAI tool call", () => {
    const toolCall = extractBridgeToolCallFromText(
      '{"name":"write","arguments":{"path":"demo.txt","content":"hello"}}',
      new Set(["write"]),
    );

    expect(toolCall?.function.name).toBe("write");
    expect(toolCall?.function.arguments).toBe('{"path":"demo.txt","content":"hello"}');
    expect(toolCall?.id).toStartWith("call_bridge_");
  });

  it("extracts a single fenced json bridge response", () => {
    const toolCall = extractBridgeToolCallFromText(
      '```json\n{"name":"write","arguments":{"path":"demo.txt","content":"hello"}}\n```',
      new Set(["write"]),
    );

    expect(toolCall?.function.name).toBe("write");
  });

  it("rejects prose-wrapped bridge json", () => {
    const toolCall = extractBridgeToolCallFromText(
      'I will write this:\n{"name":"write","arguments":{"path":"demo.txt","content":"hello"}}',
      new Set(["write"]),
    );

    expect(toolCall).toBeNull();
  });

  it("rejects bridge writes when write is not an offered tool", () => {
    const toolCall = extractBridgeToolCallFromText(
      '{"name":"write","arguments":{"path":"demo.txt","content":"hello"}}',
      new Set(["read"]),
    );

    expect(toolCall).toBeNull();
  });

  it("extracts a valid offered task bridge response", () => {
    const call = extractBridgeToolCallFromText(TASK_JSON, new Set(["task"]));

    expect(call?.function.name).toBe("task");
    expect(JSON.parse(call?.function.arguments ?? "{}")).toEqual({
      description: "Run project proof",
      prompt: "Follow your configured instructions.",
      subagent_type: "project-proof",
    });
  });

  it("rejects task bridge responses when task is not offered", () => {
    expect(extractBridgeToolCallFromText(TASK_JSON, new Set(["read"]))).toBeNull();
  });

  for (const field of ["description", "prompt", "subagent_type"] as const) {
    for (const invalid of [undefined, "", "   ", 42]) {
      it(`rejects task bridge responses with invalid ${field}: ${String(invalid)}`, () => {
        const parsed = JSON.parse(TASK_JSON);
        if (invalid === undefined) {
          delete parsed.arguments[field];
        } else {
          parsed.arguments[field] = invalid;
        }

        expect(
          extractBridgeToolCallFromText(JSON.stringify(parsed), new Set(["task"])),
        ).toBeNull();
      });
    }
  }

  it("preserves compatible optional task fields", () => {
    const parsed = JSON.parse(TASK_JSON);
    parsed.arguments.task_id = "task-123";
    parsed.arguments.command = "continue";
    parsed.arguments.future_option = { enabled: true };

    const call = extractBridgeToolCallFromText(JSON.stringify(parsed), new Set(["task"]));

    expect(JSON.parse(call?.function.arguments ?? "{}")).toEqual(parsed.arguments);
  });

  for (const field of ["task_id", "command"] as const) {
    it(`rejects a non-string optional ${field}`, () => {
      const parsed = JSON.parse(TASK_JSON);
      parsed.arguments[field] = 42;

      expect(
        extractBridgeToolCallFromText(JSON.stringify(parsed), new Set(["task"])),
      ).toBeNull();
    });
  }

  it("extracts a later bridge response from stream-json output after prelude text", () => {
    const output = [
      JSON.stringify({
        type: "assistant",
        timestamp_ms: 1,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Reading first.\n" }],
        },
      }),
      JSON.stringify({
        type: "tool_call",
        call_id: "read_1",
        tool_call: { readToolCall: { args: { path: "demo.txt" } } },
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: '{"name":"write","arguments":{"path":"demo.txt","content":"after read"}}',
            },
          ],
        },
      }),
    ].join("\n");

    const toolCall = extractBridgeToolCallFromStreamOutput(output, new Set(["write"]));

    expect(toolCall?.function.name).toBe("write");
    expect(toolCall?.function.arguments).toBe('{"path":"demo.txt","content":"after read"}');
  });

  it("does not extract trailing bridge JSON after ordinary prose", () => {
    const output = JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text: [
              "The file will be written to demo.txt.",
              '{"name":"write","arguments":{"path":"demo.txt","content":"after prose"}}',
            ].join("\n"),
          },
        ],
      },
    });

    const toolCall = extractBridgeToolCallFromStreamOutput(output, new Set(["write"]));

    expect(toolCall).toBeNull();
  });

  it("extracts a split-delta task bridge response from stream output", () => {
    const output = [
      delta('{"name":"task",'),
      delta('"arguments":{"description":"Run project proof",'),
      delta('"prompt":"Follow your configured instructions.",'),
      delta('"subagent_type":"project-proof"}}'),
    ].map(JSON.stringify).join("\n");

    const call = extractBridgeToolCallFromStreamOutput(output, new Set(["task"]));

    expect(call?.function.name).toBe("task");
    expect(JSON.parse(call?.function.arguments ?? "{}")).toEqual({
      description: "Run project proof",
      prompt: "Follow your configured instructions.",
      subagent_type: "project-proof",
    });
  });

  it("accepts contents as a bridge write content alias", () => {
    const toolCall = extractBridgeToolCallFromText(
      '{"name":"write","arguments":{"path":"demo.txt","contents":"alias body"}}',
      new Set(["write"]),
    );

    expect(toolCall?.function.name).toBe("write");
    expect(toolCall?.function.arguments).toBe('{"path":"demo.txt","content":"alias body"}');
  });

  it("uses filePath for bridge writes when the offered write schema requires it", () => {
    const toolCall = extractBridgeToolCallFromText(
      '{"name":"write","arguments":{"path":"demo.txt","content":"hello"}}',
      new Set(["write"]),
      {
        type: "object",
        properties: {
          filePath: { type: "string" },
          content: { type: "string" },
        },
        required: ["filePath", "content"],
      },
    );

    expect(toolCall?.function.name).toBe("write");
    expect(toolCall?.function.arguments).toBe('{"filePath":"demo.txt","content":"hello"}');
  });

  it("uses oc_write when bridge mode runs with fallback tools", () => {
    const toolCall = extractBridgeToolCallFromText(
      '{"name":"write","arguments":{"path":"demo.txt","content":"hello"}}',
      new Set(["oc_write"]),
      {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
      },
    );

    expect(toolCall?.function.name).toBe("oc_write");
    expect(toolCall?.function.arguments).toBe('{"path":"demo.txt","content":"hello"}');
  });

  it("appends bridge instructions unless the runtime env opts out", () => {
    const prompt = applyBridgeJsonPrompt("USER: update demo.txt", {
      allowedToolNames: new Set(["write"]),
      env: {},
    });
    const disabled = applyBridgeJsonPrompt("USER: update demo.txt", {
      allowedToolNames: new Set(["write"]),
      env: { CURSOR_ACP_BRIDGE_JSON: "0" },
    });

    expect(prompt).toContain("opencode bridge mode");
    expect(disabled).toBe("USER: update demo.txt");
    expect(isBridgeJsonEnabled({ CURSOR_ACP_BRIDGE_JSON: "false" })).toBe(false);
  });

  it("adds task bridge instructions only when task is offered", () => {
    const basePrompt =
      "SYSTEM: respond with a tool_call in the standard OpenAI format.\nUSER: delegate";
    const taskPrompt = applyBridgeJsonPrompt(basePrompt, {
      allowedToolNames: new Set(["task"]),
      env: {},
    });
    const readPrompt = applyBridgeJsonPrompt(basePrompt, {
      allowedToolNames: new Set(["read"]),
      env: {},
    });
    const disabled = applyBridgeJsonPrompt(basePrompt, {
      allowedToolNames: new Set(["task"]),
      env: { CURSOR_ACP_BRIDGE_JSON: "0" },
    });

    expect(taskPrompt).toContain("Do not invoke Cursor's built-in Task tool");
    expect(taskPrompt).toContain('"name":"task"');
    expect(taskPrompt).toContain("overrides the earlier generic");
    expect(taskPrompt.indexOf("standard OpenAI")).toBeLessThan(
      taskPrompt.indexOf("overrides the earlier generic"),
    );
    expect(taskPrompt).toContain("Do not add id, type, or function fields");
    expect(taskPrompt).toContain("do not stringify arguments");
    expect(readPrompt).toBe(basePrompt);
    expect(disabled).toBe(basePrompt);
  });

  it("appends bridge instructions when only oc_write is available", () => {
    const prompt = applyBridgeJsonPrompt("USER: update demo.txt", {
      allowedToolNames: new Set(["oc_write"]),
      env: {},
    });

    expect(prompt).toContain("opencode bridge mode");
  });

  describe("BridgeJsonStreamDetector", () => {
    it("reassembles split Task JSON without leaking fragments", () => {
      const detector = new BridgeJsonStreamDetector(new Set(["task"]));

      expect(detector.push(delta('{"name":"task",'))).toEqual({ action: "buffer" });
      expect(detector.push(delta('"arguments":{"description":"Run project proof",'))).toEqual({
        action: "buffer",
      });
      expect(detector.push(delta('"prompt":"Follow your configured instructions.",'))).toEqual({
        action: "buffer",
      });

      const decision = detector.push(delta('"subagent_type":"project-proof"}}'));
      expect(decision.action).toBe("tool_call");
      if (decision.action === "tool_call") {
        expect(decision.toolCall.function.name).toBe("task");
      }
      expect(detector.flush()).toBe("");
    });

    it("passes ordinary text through immediately", () => {
      const detector = new BridgeJsonStreamDetector(new Set(["task"]));

      expect(detector.push(delta("Ordinary answer."))).toEqual({ action: "passthrough" });
    });

    it("deduplicates cumulative snapshots", () => {
      const detector = new BridgeJsonStreamDetector(new Set(["task"]));

      expect(detector.push(snapshot('{"name":"task",'))).toEqual({ action: "buffer" });
      const decision = detector.push(snapshot(TASK_JSON));

      expect(decision.action).toBe("tool_call");
      if (decision.action === "tool_call") {
        expect(JSON.parse(decision.toolCall.function.arguments)).toEqual(
          JSON.parse(TASK_JSON).arguments,
        );
      }
    });

    it("flushes malformed JSON exactly once", () => {
      const detector = new BridgeJsonStreamDetector(new Set(["task"]));

      expect(detector.push(delta("{not "))).toEqual({ action: "buffer" });
      expect(detector.push(delta("json"))).toEqual({ action: "buffer" });
      expect(detector.flush()).toBe("{not json");
      expect(detector.flush()).toBe("");
    });

    it("preserves held whitespace before ordinary text", () => {
      const detector = new BridgeJsonStreamDetector(new Set(["task"]));

      expect(detector.push(delta("  "))).toEqual({ action: "buffer" });
      expect(detector.push(delta("answer"))).toEqual({
        action: "passthrough",
        text: "  answer",
      });
    });

    it("resets between assistant phases", () => {
      const detector = new BridgeJsonStreamDetector(new Set(["task"]));

      expect(detector.push(delta("{incomplete"))).toEqual({ action: "buffer" });
      detector.reset();
      expect(detector.push(delta("later answer"))).toEqual({ action: "passthrough" });
      expect(detector.flush()).toBe("");
    });

    it("releases a non-JSON fence when its info line completes", () => {
      const detector = new BridgeJsonStreamDetector(new Set(["task"]));

      expect(detector.push(delta("```py"))).toEqual({ action: "buffer" });
      expect(detector.push(delta("thon\n"))).toEqual({
        action: "passthrough",
        text: "```python\n",
      });
      expect(detector.push(delta("print('ok')\n```"))).toEqual({ action: "passthrough" });
      expect(detector.flush()).toBe("");
    });

    it("releases complete non-envelope JSON immediately", () => {
      const detector = new BridgeJsonStreamDetector(new Set(["task"]));

      expect(detector.push(delta('{"answer":42}'))).toEqual({
        action: "passthrough",
        text: '{"answer":42}',
      });
      expect(detector.flush()).toBe("");
    });

    it("releases a complete envelope for an unoffered tool", () => {
      const detector = new BridgeJsonStreamDetector(new Set(["task"]));
      const write = '{"name":"write","arguments":{"path":"demo.txt","content":"hello"}}';

      expect(detector.push(delta(write))).toEqual({
        action: "passthrough",
        text: write,
      });
    });
  });
});
