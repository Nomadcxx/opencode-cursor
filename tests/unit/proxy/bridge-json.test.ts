import { describe, expect, it } from "bun:test";
import {
  applyBridgeJsonPrompt,
  BridgeJsonStreamDetector,
  extractBridgeToolCallsFromStreamOutput,
  extractBridgeToolCallsFromText,
  isBridgeJsonEnabled,
} from "../../../src/proxy/bridge-json.js";
import { createToolCallCompletionResponse, createToolCallStreamChunks } from "../../../src/proxy/tool-loop.js";

const extractBridgeToolCallFromText = (...args: Parameters<typeof extractBridgeToolCallsFromText>) =>
  extractBridgeToolCallsFromText(...args)?.[0] ?? null;
const extractBridgeToolCallFromStreamOutput = (
  ...args: Parameters<typeof extractBridgeToolCallsFromStreamOutput>
) => extractBridgeToolCallsFromStreamOutput(...args)?.[0] ?? null;

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

  it("extracts a JSON array of task envelopes as parallel tool calls", () => {
    const second = JSON.parse(TASK_JSON);
    second.arguments.subagent_type = "explore";
    const calls = extractBridgeToolCallsFromText(
      `[${TASK_JSON}, ${JSON.stringify(second)}, ${TASK_JSON}]`,
      new Set(["task"]),
    );

    expect(calls?.map((call) => JSON.parse(call.function.arguments).subagent_type)).toEqual([
      "project-proof",
      "explore",
      "project-proof",
    ]);
    expect(new Set(calls?.map((call) => call.id)).size).toBe(3);

    const chunks = createToolCallStreamChunks({ id: "x", created: 0, model: "m" }, calls!);
    expect(chunks.flatMap((chunk) => chunk.choices[0].delta.tool_calls ?? []).map((call: any) => call.index))
      .toEqual([0, 1, 2]);
  });

  describe("OpenCode 2.0 subagent tool", () => {
    const SUBAGENT = new Set(["subagent"]);
    const subagent = (args: Record<string, unknown>) => JSON.stringify({ name: "subagent", arguments: args });
    const base = { description: "Count files", prompt: "Count the files." };

    it("prompts with the subagent name and agent field", () => {
      const prompt = applyBridgeJsonPrompt("USER: delegate", { allowedToolNames: SUBAGENT, env: {} });

      expect(prompt).toContain('{"name":"subagent","arguments":{"description":"3-5 words"');
      expect(prompt).toContain('"agent":"explore"');
      expect(prompt).not.toContain("subagent_type");
      expect(prompt).not.toContain('"name":"task"');
    });

    it("extracts a subagent array with agent arguments", () => {
      const calls = extractBridgeToolCallsFromText(
        `[${subagent({ ...base, agent: "explore" })},${subagent({ ...base, agent: "general", background: true })}]`,
        SUBAGENT,
      );

      expect(calls?.map((call) => call.function.name)).toEqual(["subagent", "subagent"]);
      expect(calls?.map((call) => JSON.parse(call.function.arguments))).toEqual([
        { ...base, agent: "explore" },
        { ...base, agent: "general", background: true },
      ]);
    });

    it("maps a v1 task envelope onto subagent when only subagent is offered", () => {
      const call = extractBridgeToolCallFromText(TASK_JSON, SUBAGENT);

      expect(call?.function.name).toBe("subagent");
      expect(JSON.parse(call?.function.arguments ?? "{}")).toEqual({
        description: "Run project proof",
        prompt: "Follow your configured instructions.",
        agent: "project-proof",
      });
    });

    it("maps agent onto subagent_type when only task is offered", () => {
      const call = extractBridgeToolCallFromText(subagent({ ...base, agent: "explore" }), new Set(["task"]));

      expect(call?.function.name).toBe("task");
      expect(JSON.parse(call?.function.arguments ?? "{}")).toEqual({ ...base, subagent_type: "explore" });
    });

    it("drops a bare runtime model id but keeps an OpenCode provider/model", () => {
      const parse = (model: string) => JSON.parse(
        extractBridgeToolCallFromText(subagent({ ...base, agent: "explore", model }), SUBAGENT)?.function.arguments ?? "{}",
      );

      expect(parse("composer-2.5").model).toBeUndefined();
      expect(parse("cursor-acp/composer-2.5").model).toBe("cursor-acp/composer-2.5");
    });

    it("rejects subagent envelopes without agent or with a non-boolean background", () => {
      expect(extractBridgeToolCallFromText(subagent(base), SUBAGENT)).toBeNull();
      expect(
        extractBridgeToolCallFromText(subagent({ ...base, agent: "explore", background: "yes" }), SUBAGENT),
      ).toBeNull();
    });
  });

  it("does not reuse ids when an identical envelope is retried", () => {
    const first = extractBridgeToolCallsFromText(`[${TASK_JSON}]`, new Set(["task"]));
    const retry = extractBridgeToolCallsFromText(`[${TASK_JSON}]`, new Set(["task"]));

    expect(first?.[0].id).not.toBe(retry?.[0].id);
  });

  it("extracts a write array as parallel write calls", () => {
    const calls = extractBridgeToolCallsFromText(
      JSON.stringify(["a.txt", "b.txt"].map((path) => ({ name: "write", arguments: { path, content: path } }))),
      new Set(["write"]),
    );

    expect(calls?.map((call) => JSON.parse(call.function.arguments).path)).toEqual(["a.txt", "b.txt"]);
  });

  it("extracts every envelope of a streamed array from non-stream output", () => {
    const array = `[${TASK_JSON},${TASK_JSON},${TASK_JSON}]`;
    const output = [delta(array.slice(0, 60)), delta(array.slice(60))].map(JSON.stringify).join("\n");

    const calls = extractBridgeToolCallsFromStreamOutput(output, new Set(["task"]));

    expect(calls).toHaveLength(3);
    expect(new Set(calls?.map((call) => call.id)).size).toBe(3);
    const response = createToolCallCompletionResponse({ id: "x", created: 0, model: "m" }, calls!);
    expect(response.choices[0].message.tool_calls).toHaveLength(3);
  });

  it("rejects an array when any envelope is invalid or the array is empty", () => {
    const invalid = JSON.parse(TASK_JSON);
    delete invalid.arguments.prompt;

    expect(
      extractBridgeToolCallsFromText(`[${TASK_JSON},${JSON.stringify(invalid)}]`, new Set(["task"])),
    ).toBeNull();
    expect(extractBridgeToolCallsFromText("[]", new Set(["task"]))).toBeNull();
  });

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

  // #114: models usually write a sentence before the envelope.
  it("extracts a bridge envelope on its own line after prose", () => {
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

    expect(toolCall?.function.name).toBe("write");
    expect(JSON.parse(toolCall?.function.arguments ?? "{}")).toEqual({ path: "demo.txt", content: "after prose" });
  });

  it("does not extract an envelope that shares a line with prose", () => {
    const toolCall = extractBridgeToolCallFromText(
      'Use {"name":"write","arguments":{"path":"demo.txt","content":"x"}} to write.',
      new Set(["write"]),
    );

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
      new Map([["write", {
        type: "object",
        properties: {
          filePath: { type: "string" },
          content: { type: "string" },
        },
        required: ["filePath", "content"],
      }]]),
    );

    expect(toolCall?.function.name).toBe("write");
    expect(toolCall?.function.arguments).toBe('{"filePath":"demo.txt","content":"hello"}');
  });

  it("uses oc_write when bridge mode runs with fallback tools", () => {
    const toolCall = extractBridgeToolCallFromText(
      '{"name":"write","arguments":{"path":"demo.txt","content":"hello"}}',
      new Set(["oc_write"]),
      new Map([["oc_write", {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
      }]]),
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
    expect(taskPrompt).toContain("one JSON array of those objects to dispatch several tasks in parallel");
    expect(taskPrompt).not.toContain("exactly one JSON object");
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
        expect(decision.toolCalls[0].function.name).toBe("task");
      }
      expect(detector.flush()).toBe("");
    });

    it("reassembles a split array of Task envelopes", () => {
      const detector = new BridgeJsonStreamDetector(new Set(["task"]));
      const array = `[${TASK_JSON},${TASK_JSON}]`;

      expect(detector.push(delta("["))).toEqual({ action: "buffer" });
      expect(detector.push(delta(array.slice(1, 40)))).toEqual({ action: "buffer" });
      const decision = detector.push(delta(array.slice(40)));

      expect(decision.action).toBe("tool_call");
      const calls = decision.action === "tool_call" ? decision.toolCalls : [];
      expect(calls.map((call) => call.function.name)).toEqual(["task", "task"]);
      expect(new Set(calls.map((call) => call.id)).size).toBe(2);
    });

    it("passes markdown that starts with a bracket through", () => {
      const detector = new BridgeJsonStreamDetector(new Set(["task"]));

      expect(detector.push(delta("["))).toEqual({ action: "buffer" });
      expect(detector.push(delta("docs](https://example.com)"))).toEqual({
        action: "passthrough",
        text: "[docs](https://example.com)",
      });
    });

    it("passes ordinary text through immediately", () => {
      const detector = new BridgeJsonStreamDetector(new Set(["task"]));

      expect(detector.push(delta("Ordinary answer."))).toEqual({ action: "passthrough", text: "Ordinary answer." });
    });

    it("deduplicates cumulative snapshots", () => {
      const detector = new BridgeJsonStreamDetector(new Set(["task"]));

      expect(detector.push(snapshot('{"name":"task",'))).toEqual({ action: "buffer" });
      const decision = detector.push(snapshot(TASK_JSON));

      expect(decision.action).toBe("tool_call");
      if (decision.action === "tool_call") {
        expect(JSON.parse(decision.toolCalls[0].function.arguments)).toEqual(
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
      expect(detector.push(delta("later answer"))).toEqual({ action: "passthrough", text: "later answer" });
      expect(detector.flush()).toBe("");
    });

    it("releases a non-JSON fence when its info line completes", () => {
      const detector = new BridgeJsonStreamDetector(new Set(["task"]));

      expect(detector.push(delta("```py"))).toEqual({ action: "buffer" });
      expect(detector.push(delta("thon\n"))).toEqual({
        action: "passthrough",
        text: "```python\n",
      });
      expect(detector.push(delta("print('ok')\n```"))).toEqual({ action: "passthrough", text: "print('ok')\n```" });
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

    // Holding it would stall the stream: more text cannot turn it into JSON.
    it("releases balanced non-JSON at once", () => {
      const detector = new BridgeJsonStreamDetector(new Set(["task"]));
      const response = '{"answer":42} followed by prose';

      expect(detector.push(delta(response))).toEqual({ action: "passthrough", text: response });
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

    it("parses a streamed envelope once, not on every delta", () => {
      const detector = new BridgeJsonStreamDetector(new Set(["write"]));
      const content = 'function f() {\n  return { a: "}]\\\\" };\n}\n'.repeat(200);
      const envelope = JSON.stringify({ name: "write", arguments: { path: "src/f.ts", content } });
      const originalParse = JSON.parse;
      let parseCalls = 0;
      JSON.parse = ((...args: Parameters<typeof JSON.parse>) => {
        parseCalls++;
        return originalParse(...args);
      }) as typeof JSON.parse;

      let decision;
      try {
        for (let i = 0; i < envelope.length; i += 7) {
          decision = detector.push(delta(envelope.slice(i, i + 7)));
          if (i + 7 < envelope.length) {
            expect(decision).toEqual({ action: "buffer" });
          }
        }
      } finally {
        JSON.parse = originalParse;
      }

      expect(decision?.action).toBe("tool_call");
      if (decision?.action === "tool_call") {
        expect(JSON.parse(decision.toolCalls[0].function.arguments).content).toBe(content);
      }
      expect(parseCalls).toBe(1);
    });

    it("extracts a streamed fenced envelope after the closing fence", () => {
      const detector = new BridgeJsonStreamDetector(new Set(["task"]));
      const fenced = `\`\`\`json\n${TASK_JSON}\n\`\`\``;

      for (let i = 0; i < fenced.length - 3; i += 5) {
        expect(detector.push(delta(fenced.slice(i, Math.min(i + 5, fenced.length - 3))))).toEqual({
          action: "buffer",
        });
      }
      expect(detector.push(delta("```")).action).toBe("tool_call");
    });
  });

  // #114: the reported failure, an edit envelope printed after a sentence of prose.
  describe("edit envelopes", () => {
    const EDIT_SCHEMA = new Map<string, unknown>([["edit", {
      type: "object",
      properties: {
        filePath: { type: "string" },
        oldString: { type: "string" },
        newString: { type: "string" },
        replaceAll: { type: "boolean" },
      },
      required: ["filePath", "oldString", "newString"],
      additionalProperties: false,
    }]]);
    const EDIT_JSON = '{"name":"edit","arguments":{"path":"notes.txt","oldString":"beta","newString":"BETA-EDITED"}}';

    it("maps an edit envelope onto the offered edit schema", () => {
      const toolCall = extractBridgeToolCallFromText(EDIT_JSON, new Set(["edit"]), EDIT_SCHEMA);

      expect(toolCall?.function.name).toBe("edit");
      expect(JSON.parse(toolCall?.function.arguments ?? "{}")).toEqual({
        filePath: "notes.txt",
        oldString: "beta",
        newString: "BETA-EDITED",
      });
    });

    it("rejects an edit envelope missing a required field", () => {
      const toolCall = extractBridgeToolCallFromText(
        '{"name":"edit","arguments":{"path":"notes.txt","newString":"BETA-EDITED"}}',
        new Set(["edit"]),
        EDIT_SCHEMA,
      );

      expect(toolCall).toBeNull();
    });

    it("ignores edit envelopes when no edit tool is offered", () => {
      expect(extractBridgeToolCallFromText(EDIT_JSON, new Set(["write"]), EDIT_SCHEMA)).toBeNull();
    });

    it("streams the prose, then turns the envelope into a tool call", () => {
      const detector = new BridgeJsonStreamDetector(new Set(["edit"]), EDIT_SCHEMA);

      expect(detector.push(delta("Need `notes.txt` first. One line change only.\n"))).toEqual({
        action: "passthrough",
        text: "Need `notes.txt` first. One line change only.\n",
      });
      expect(detector.push(delta(EDIT_JSON.slice(0, 30)))).toEqual({ action: "buffer" });
      const decision = detector.push(delta(EDIT_JSON.slice(30)));
      expect(decision.action).toBe("tool_call");
      expect(decision.action === "tool_call" && decision.text).toBeFalsy();
    });

    it("returns prose and the tool call together when one delta holds both", () => {
      const detector = new BridgeJsonStreamDetector(new Set(["edit"]), EDIT_SCHEMA);
      const decision = detector.push(delta(`Replacing the line.\n${EDIT_JSON}`));

      expect(decision.action).toBe("tool_call");
      expect(decision.action === "tool_call" && decision.text).toBe("Replacing the line.\n");
    });

    it("works the same from cumulative snapshots", () => {
      const detector = new BridgeJsonStreamDetector(new Set(["edit"]), EDIT_SCHEMA);
      const full = `Replacing the line.\n${EDIT_JSON}`;

      expect(detector.push(snapshot("Replacing the line.\n"))).toEqual({ action: "passthrough", text: "Replacing the line.\n" });
      expect(detector.push(snapshot(full)).action).toBe("tool_call");
    });

    it("leaves lines starting with { inside a code fence as text", () => {
      const detector = new BridgeJsonStreamDetector(new Set(["edit"]), EDIT_SCHEMA);
      const code = "```ts\n{\n  const x = 1;\n}\n```\n";

      const emitted: string[] = [];
      for (const ch of code) {
        const decision = detector.push(delta(ch));
        if (decision.action === "passthrough") emitted.push(decision.text);
        expect(decision.action).not.toBe("tool_call");
      }
      expect(emitted.join("") + detector.flush()).toBe(code);
    });

    it("adds the edit envelope to the bridge prompt only when edit is offered", () => {
      expect(applyBridgeJsonPrompt("USER: x", { allowedToolNames: new Set(["edit", "write"]), env: {} }))
        .toContain('{"name":"edit","arguments":{"path"');
      expect(applyBridgeJsonPrompt("USER: x", { allowedToolNames: new Set(["write"]), env: {} }))
        .not.toContain('"name":"edit"');
    });
  });
});
