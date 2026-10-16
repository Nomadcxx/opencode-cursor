import { describe, expect, it } from "bun:test";
import { sdkMessageToStreamJson } from "../../../scripts/sdk-runner.mjs";
import { parseStreamJsonLine } from "../../../src/streaming/parser.js";
import {
  createToolCallCompletionResponse,
  createToolCallStreamChunks,
  extractAllowedToolNames,
  extractOpenAiToolCall,
} from "../../../src/proxy/tool-loop.js";

// Helper function to create tool call events
function createToolCallEvent(toolName: string, args: Record<string, unknown>, callId = "call_test_123") {
  return {
    type: "tool_call",
    tool_call: {
      [toolName]: { args },
    },
    call_id: callId,
  } as any;
}

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

    const result = extractOpenAiToolCall(event, new Set(["oc_read"]));
    expect(result.action).toBe("intercept");
    expect(result.toolCall).toBeDefined();
    expect(result.toolCall?.id).toBe("call_1");
    expect(result.toolCall?.function.name).toBe("oc_read");
    expect(result.toolCall?.function.arguments).toBe("{\"path\":\"/tmp/hello.txt\"}");
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

    const result = extractOpenAiToolCall(event, new Set(["read"]));
    expect(result.action).toBe("intercept");
    expect(result.toolCall?.function.name).toBe("read");
    expect(result.toolCall?.function.arguments).toBe("{\"path\":\"foo.txt\"}");
  });

  it("maps bare cursor edit calls to fallback oc_edit when native edit is absent", () => {
    const event: any = {
      type: "tool_call",
      call_id: "call_oc_edit",
      tool_call: {
        editToolCall: {
          args: { path: "foo.txt", streamContent: "body" },
        },
      },
    };

    const result = extractOpenAiToolCall(event, new Set(["oc_edit", "oc_write"]));
    expect(result.action).toBe("intercept");
    expect(result.toolCall?.function.name).toBe("oc_edit");
    expect(result.toolCall?.function.arguments).toBe("{\"path\":\"foo.txt\",\"streamContent\":\"body\"}");
  });

  it("keeps oc_edit until schema compatibility can check the native contract", () => {
    const event: any = {
      type: "tool_call",
      call_id: "call_alias_edit",
      name: "oc_edit",
      tool_call: {
        oc_edit: {
          args: { filePath: "foo.txt", oldString: "a", newString: "b" },
        },
      },
    };

    const result = extractOpenAiToolCall(event, new Set(["edit", "oc_edit", "write", "oc_write"]));
    expect(result.action).toBe("intercept");
    expect(result.toolCall?.function.name).toBe("oc_edit");
    expect(result.toolCall?.function.arguments).toBe("{\"filePath\":\"foo.txt\",\"oldString\":\"a\",\"newString\":\"b\"}");
  });

  it("keeps oc_write on its guarded handler when native write is exposed", () => {
    const event: any = {
      type: "tool_call",
      call_id: "call_alias_write",
      tool_call: {
        oc_write: {
          args: { filePath: "foo.txt", content: "body" },
        },
      },
    };

    const result = extractOpenAiToolCall(event, new Set(["write", "oc_write"]));
    expect(result.action).toBe("intercept");
    expect(result.toolCall?.function.name).toBe("oc_write");
  });

  it("keeps oc_edit when native edit is not exposed", () => {
    const event: any = {
      type: "tool_call",
      call_id: "call_alias_only",
      name: "oc_edit",
      tool_call: {
        oc_edit: {
          args: { filePath: "foo.txt", oldString: "a", newString: "b" },
        },
      },
    };

    const result = extractOpenAiToolCall(event, new Set(["oc_edit", "oc_write"]));
    expect(result.toolCall?.function.name).toBe("oc_edit");
  });

  it("preserves exact custom tool names when an unprefixed tool also exists", () => {
    const event = createToolCallEvent("oc_custom", { query: "test" });
    const result = extractOpenAiToolCall(event, new Set(["oc_custom", "custom"]));
    expect(result.toolCall?.function.name).toBe("oc_custom");
  });

  it("extracts args from flat payload without args wrapper", () => {
    const event: any = {
      type: "tool_call",
      call_id: "call_flat",
      tool_call: {
        editToolCall: {
          path: "test.md",
          streamContent: "hello",
        },
      },
    };

    const result = extractOpenAiToolCall(event, new Set(["edit"]));
    expect(result.action).toBe("intercept");
    expect(result.toolCall?.function.name).toBe("edit");
    expect(result.toolCall?.function.arguments).toBe("{\"path\":\"test.md\",\"streamContent\":\"hello\"}");
  });

  it("extracts args from Cursor native Write tool_use input payload", () => {
    const event: any = {
      type: "tool_call",
      call_id: "call_write_input",
      tool_call: {
        WriteToolCall: {
          input: { filePath: "test.md", content: "hello" },
        },
      },
    };

    const result = extractOpenAiToolCall(event, new Set(["write"]));
    expect(result.action).toBe("intercept");
    expect(result.toolCall?.function.name).toBe("write");
    expect(result.toolCall?.function.arguments).toBe('{"filePath":"test.md","content":"hello"}');
  });

  it("extracts args from input payload and normalizes contents alias", () => {
    const event: any = {
      type: "tool_call",
      call_id: "call_write_input_contents",
      tool_call: {
        WriteToolCall: {
          input: { filePath: "test.md", contents: "hello" },
        },
      },
    };

    const result = extractOpenAiToolCall(event, new Set(["write"]));
    expect(result.action).toBe("intercept");
    expect(result.toolCall?.function.name).toBe("write");
    const args = JSON.parse(result.toolCall?.function.arguments ?? "{}");
    expect(args.filePath).toBe("test.md");
    expect(args.contents).toBe("hello");
  });

  it("skips result-only tool_call payloads without args", () => {
    const event: any = {
      type: "tool_call",
      subtype: "completed",
      call_id: "call_completed",
      tool_call: {
        editToolCall: {
          result: {
            success: true,
          },
        },
      },
    };

    const result = extractOpenAiToolCall(event, new Set(["edit"]));
    expect(result.action).toBe("skip");
    expect(result.skipReason).toBe("event_skipped");
  });

  it("returns passthrough for tool calls not present in allowed names", () => {
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

    const result = extractOpenAiToolCall(event, new Set(["oc_other"]));
    expect(result.action).toBe("passthrough");
    expect(result.passthroughName).toBe("oc_brainstorm");
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

    const result = extractOpenAiToolCall(event, new Set(["todowrite"]));
    expect(result.action).toBe("intercept");
    expect(result.toolCall?.function.name).toBe("todowrite");
  });

  it("maps executeCommand alias to allowed bash tool name", () => {
    const event: any = {
      type: "tool_call",
      call_id: "call_bash_alias",
      name: "executeCommand",
      tool_call: {
        executeCommand: {
          args: { command: "pwd" },
        },
      },
    };

    const result = extractOpenAiToolCall(event, new Set(["bash"]));
    expect(result.action).toBe("intercept");
    expect(result.toolCall?.function.name).toBe("bash");
  });

  it("maps shell alias to allowed bash tool name", () => {
    const event: any = {
      type: "tool_call",
      call_id: "call_shell_alias",
      name: "shell",
      tool_call: {
        shell: {
          args: { cmd: "pwd" },
        },
      },
    };

    const result = extractOpenAiToolCall(event, new Set(["bash"]));
    expect(result.action).toBe("intercept");
    expect(result.toolCall?.function.name).toBe("bash");
  });

  it("maps bash and its aliases to the OpenCode 2.0 shell tool", () => {
    for (const name of ["bash", "executeCommand"]) {
      const event: any = {
        type: "tool_call",
        call_id: `call_${name}`,
        name,
        tool_call: { [name]: { args: { command: "pwd" } } },
      };

      const result = extractOpenAiToolCall(event, new Set(["shell", "read"]));
      expect(result.action).toBe("intercept");
      expect(result.toolCall?.function.name).toBe("shell");
    }
  });

  it("maps Cursor's native Task to the OpenCode 2.0 subagent tool", () => {
    const event: any = {
      type: "tool_call",
      subtype: "started",
      call_id: "call_task",
      tool_call: {
        taskToolCall: { args: { description: "List files", prompt: "List them.", subagentType: { explore: {} } } },
      },
    };

    expect(extractOpenAiToolCall(event, new Set(["subagent", "read"])).toolCall?.function.name).toBe("subagent");
    expect(extractOpenAiToolCall(event, new Set(["task", "subagent"])).toolCall?.function.name).toBe("task");
  });

  it("maps mcp__<server>__<tool> to OpenCode 2.0 host MCP naming", () => {
    const event: any = {
      type: "tool_call",
      call_id: "call_mcp",
      name: "mcp__my_docs__search",
      tool_call: { mcp__my_docs__search: { args: { q: "x" } } },
    };

    const result = extractOpenAiToolCall(event, new Set(["my-docs_search"]));
    expect(result.action).toBe("intercept");
    expect(result.toolCall?.function.name).toBe("my-docs_search");
  });

  it("maps createDirectory alias to allowed mkdir tool name", () => {
    const event: any = {
      type: "tool_call",
      call_id: "call_mkdir_alias",
      name: "createDirectory",
      tool_call: {
        createDirectory: {
          args: { path: "tmp/dir" },
        },
      },
    };

    const result = extractOpenAiToolCall(event, new Set(["mkdir"]));
    expect(result.action).toBe("intercept");
    expect(result.toolCall?.function.name).toBe("mkdir");
  });

  it("maps deleteFile alias to allowed rm tool name", () => {
    const event: any = {
      type: "tool_call",
      call_id: "call_rm_alias",
      name: "deleteFile",
      tool_call: {
        deleteFile: {
          args: { path: "tmp/file.txt" },
        },
      },
    };

    const result = extractOpenAiToolCall(event, new Set(["rm"]));
    expect(result.action).toBe("intercept");
    expect(result.toolCall?.function.name).toBe("rm");
  });

  it("maps findFiles alias to allowed glob tool name", () => {
    const event: any = {
      type: "tool_call",
      call_id: "call_glob_alias",
      name: "findFiles",
      tool_call: {
        findFiles: {
          args: { pattern: "**/*.ts" },
        },
      },
    };

    const result = extractOpenAiToolCall(event, new Set(["glob"]));
    expect(result.action).toBe("intercept");
    expect(result.toolCall?.function.name).toBe("glob");
  });

  it("maps callOmoAgent alias to allowed call_omo_agent tool name", () => {
    const event: any = {
      type: "tool_call",
      call_id: "call_subagent_alias",
      name: "callOmoAgent",
      tool_call: {
        callOmoAgent: {
          args: { task: "summarize" },
        },
      },
    };

    const result = extractOpenAiToolCall(event, new Set(["call_omo_agent"]));
    expect(result.action).toBe("intercept");
    expect(result.toolCall?.function.name).toBe("call_omo_agent");
  });

  it("maps delegateTask alias to allowed task tool name", () => {
    const event: any = {
      type: "tool_call",
      call_id: "call_task_alias",
      name: "delegateTask",
      tool_call: {
        delegateTask: {
          args: { prompt: "analyze codebase" },
        },
      },
    };

    const result = extractOpenAiToolCall(event, new Set(["task"]));
    expect(result.action).toBe("intercept");
    expect(result.toolCall?.function.name).toBe("task");
  });

  it("maps runSkill alias to allowed skill tool name", () => {
    const event: any = {
      type: "tool_call",
      call_id: "call_skill_alias",
      name: "runSkill",
      tool_call: {
        runSkill: {
          args: { skill: "superpowers/brainstorming" },
        },
      },
    };

    const result = extractOpenAiToolCall(event, new Set(["skill"]));
    expect(result.action).toBe("intercept");
    expect(result.toolCall?.function.name).toBe("skill");
  });

  it("maps skillMcp alias to allowed skill_mcp tool name", () => {
    const event: any = {
      type: "tool_call",
      call_id: "call_skill_mcp_alias",
      name: "skillMcp",
      tool_call: {
        skillMcp: {
          args: { server: "context7", action: "list" },
        },
      },
    };

    const result = extractOpenAiToolCall(event, new Set(["skill_mcp"]));
    expect(result.action).toBe("intercept");
    expect(result.toolCall?.function.name).toBe("skill_mcp");
  });

  it("maps askQuestion alias to allowed question tool name", () => {
    const event: any = {
      type: "tool_call",
      call_id: "call_question_alias",
      name: "askQuestion",
      tool_call: {
        askQuestion: {
          args: { questions: [{ prompt: "Proceed?", options: [{ label: "Yes" }] }] },
        },
      },
    };

    const result = extractOpenAiToolCall(event, new Set(["question"]));
    expect(result.action).toBe("intercept");
    expect(result.toolCall?.function.name).toBe("question");
  });

  it("passes askQuestion through when question tool is not allowed", () => {
    const event: any = {
      type: "tool_call",
      call_id: "call_question_passthrough",
      name: "askQuestion",
      tool_call: {
        askQuestion: {
          args: { questions: [{ prompt: "Proceed?", options: [{ label: "Yes" }] }] },
        },
      },
    };

    const result = extractOpenAiToolCall(event, new Set(["bash"]));
    expect(result.action).toBe("passthrough");
    expect(result.passthroughName).toBe("askQuestion");
  });

  it("builds valid non-stream tool call response", () => {
    const response = createToolCallCompletionResponse(
      { id: "resp-1", created: 123, model: "cursor-acp/auto" },
      [{
        id: "call_9",
        type: "function",
        function: {
          name: "oc_read",
          arguments: "{\"path\":\"a.txt\"}",
        },
      }],
    );

    expect(response.object).toBe("chat.completion");
    expect(response.choices[0].finish_reason).toBe("tool_calls");
    expect(response.choices[0].message.role).toBe("assistant");
    expect(response.choices[0].message.tool_calls[0].function.name).toBe("oc_read");
  });

  it("builds valid stream chunks with tool_calls finish reason", () => {
    const chunks = createToolCallStreamChunks(
      { id: "resp-2", created: 456, model: "cursor-acp/auto" },
      [{
        id: "call_10",
        type: "function",
        function: {
          name: "oc_write",
          arguments: "{\"path\":\"b.txt\",\"content\":\"x\"}",
        },
      }],
    );

    expect(chunks).toHaveLength(2);
    expect(chunks[0].choices[0].delta.tool_calls[0].function.name).toBe("oc_write");
    expect(chunks[0].choices[0].finish_reason).toBeNull();
    expect(chunks[1].choices[0].finish_reason).toBe("tool_calls");
  });

  it("emits one indexed stream chunk per parallel tool call", () => {
    const calls = ["a", "b", "c"].map((name) => ({
      id: `call_${name}`,
      type: "function" as const,
      function: { name, arguments: "{}" },
    }));
    const meta = { id: "resp-3", created: 789, model: "cursor-acp/auto" };

    const chunks = createToolCallStreamChunks(meta, calls);
    expect(chunks.map((chunk) => chunk.choices[0].delta.tool_calls?.map((c: any) => [c.index, c.id])))
      .toEqual([[[0, "call_a"]], [[1, "call_b"]], [[2, "call_c"]], undefined]);
    expect(chunks.at(-1).choices[0].finish_reason).toBe("tool_calls");

    const response = createToolCallCompletionResponse(meta, calls);
    expect(response.choices[0].message.tool_calls.map((c) => c.id)).toEqual(["call_a", "call_b", "call_c"]);
  });
});

describe("extractOpenAiToolCall with pass-through", () => {
  const allowedTools = new Set(["bash", "read", "write"]);

  it("should return intercept action for known tools", () => {
    const event = createToolCallEvent("bash", { command: "ls" });

    const result = extractOpenAiToolCall(event, allowedTools);

    expect(result.action).toBe("intercept");
    expect(result.toolCall).toBeDefined();
    expect(result.toolCall!.function.name).toBe("bash");
  });

  it("should return intercept action for aliased tools", () => {
    const event = createToolCallEvent("runcommand", { command: "ls" });

    const result = extractOpenAiToolCall(event, allowedTools);

    expect(result.action).toBe("intercept");
    expect(result.toolCall!.function.name).toBe("bash");
  });

  it("should return passthrough action for unknown tools", () => {
    const event = createToolCallEvent("browser_navigate", { url: "https://example.com" });

    const result = extractOpenAiToolCall(event, allowedTools);

    expect(result.action).toBe("passthrough");
    expect(result.passthroughName).toBe("browser_navigate");
    expect(result.toolCall).toBeUndefined();
  });

  it("should return skip action when allowedToolNames is empty", () => {
    const event = createToolCallEvent("bash", { command: "ls" });

    const result = extractOpenAiToolCall(event, new Set());

    expect(result.action).toBe("skip");
    expect(result.skipReason).toBe("no_allowed_tools");
  });

  it("should return skip action when no name can be extracted", () => {
    const event = { tool_call: {} } as any;

    const result = extractOpenAiToolCall(event, allowedTools);

    expect(result.action).toBe("skip");
    expect(result.skipReason).toBe("no_name");
  });

  it("should return passthrough action when model tries to call 'mcp' directly", () => {
    const event = createToolCallEvent("mcp", { server: "engram", tool: "mem_save" });

    const result = extractOpenAiToolCall(event, new Set(["bash", "mcp__engram__mem_save"]));

    expect(result.action).toBe("passthrough");
    expect(result.passthroughName).toBe("mcp");
    expect(result.toolCall).toBeUndefined();
  });

  it("should intercept valid MCP tool calls with full namespaced name", () => {
    const event = createToolCallEvent("mcp__engram__mem_save", { memory: "test" });

    const result = extractOpenAiToolCall(event, new Set(["bash", "mcp__engram__mem_save"]));

    expect(result.action).toBe("intercept");
    expect(result.toolCall).toBeDefined();
    expect(result.toolCall!.function.name).toBe("mcp__engram__mem_save");
  });

  describe("body-less Cursor edit calls", () => {
    // OpenCode 2 host tool names
    const allowed = new Set(["edit", "write", "read"]);

    function sdkEdit(args: unknown, result?: unknown) {
      return parseStreamJsonLine(JSON.stringify(sdkMessageToStreamJson({
        type: "tool_call", name: "edit", call_id: "sdk-edit", args, result,
      }))) as any;
    }

    it("passes the Cursor SDK's path-only edit through to Cursor", () => {
      // sdk-runner shape: { tool_call: { edit: { args: { path }, result } } }
      const result = extractOpenAiToolCall(
        sdkEdit({ path: "C:/repo/combine_invoices.py" }),
        allowed,
      );
      expect(result.action).toBe("passthrough");
      expect(result.passthroughName).toBe("edit");
      expect(result.toolCall).toBeUndefined();
    });

    it("passes the completed SDK edit event (with result) through too", () => {
      const event = sdkEdit(
        { path: "combine_invoices.py" },
        { status: "success", value: { diffString: "+print('hi')" } },
      );
      expect(extractOpenAiToolCall(event, allowed).action).toBe("passthrough");
    });

    it("keeps CLI path-only edits on the validation path", () => {
      for (const name of ["edit", "editToolCall"]) {
        const result = extractOpenAiToolCall(createToolCallEvent(name, { path: "README.md" }), allowed);
        expect(result.action).toBe("intercept");
      }
    });

    it("keeps malformed SDK edits on the validation path", () => {
      for (const args of [{}, { path: null }, { path: 1 }, { path: "" }, { path: "  " }, { path: "a\0.ts" }, { filePath: "a.ts" }, { path: "a.ts", extra: true }]) {
        expect(extractOpenAiToolCall(sdkEdit(args), allowed).action).toBe("intercept");
      }
      expect(extractOpenAiToolCall({ type: "tool_call", source: "cursor-sdk", name: "edit", tool_call: {} } as any, allowed).action).toBe("intercept");
    });

    it("does not exempt SDK compatibility aliases", () => {
      const event = sdkMessageToStreamJson({ type: "tool_call", name: "oc_edit", args: { path: "a.ts" } });
      expect(extractOpenAiToolCall(event as any, new Set(["oc_edit"])).action).toBe("intercept");
    });

    it("still intercepts edits that carry a body", () => {
      const withStrings = extractOpenAiToolCall(
        sdkEdit({ path: "a.ts", old_string: "a", new_string: "b" }),
        allowed,
      );
      expect(withStrings.action).toBe("intercept");
      expect(withStrings.toolCall!.function.name).toBe("edit");

      const withStreamContent = extractOpenAiToolCall(
        sdkEdit({ path: "a.ts", streamContent: "full body" }),
        allowed,
      );
      expect(withStreamContent.action).toBe("intercept");
    });

    it("does not pass through other path-only tools", () => {
      const result = extractOpenAiToolCall(createToolCallEvent("read", { path: "a.ts" }), allowed);
      expect(result.action).toBe("intercept");
    });
  });
});
