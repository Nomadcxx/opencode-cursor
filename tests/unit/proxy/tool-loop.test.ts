import { describe, expect, it } from "bun:test";
import {
  createToolCallCompletionResponse,
  createToolCallStreamChunks,
  extractAllowedToolNames,
  extractOpenAiToolCall,
} from "../../../src/proxy/tool-loop.js";
import { rememberMcpCatalogFromTools, rememberMcpServers, resetRememberedMcpCatalog } from "../../../src/mcp/dynamic-catalog.js";

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
      { id: "resp-1", created: 123, model: "cursor-kilo/auto" },
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
      { id: "resp-2", created: 456, model: "cursor-kilo/auto" },
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

  it("should intercept bare mcp wrapper when provider/toolName resolve to Kilo tool", () => {
    const event = createToolCallEvent("mcp", {
      providerIdentifier: "context7",
      toolName: "search",
      args: { q: "react" },
    });

    const result = extractOpenAiToolCall(event, new Set(["context7_search", "mcp__context7__search"]));

    expect(result.action).toBe("intercept");
    expect(result.toolCall?.function.name).toBe("context7_search");
  });

  it("should passthrough bare mcp when provider/toolName cannot be resolved", () => {
    const event = createToolCallEvent("mcp", { server: "engram", tool: "mem_save" });

    const result = extractOpenAiToolCall(event, new Set(["bash", "mcp__engram__mem_save"]));

    expect(result.action).toBe("passthrough");
    expect(result.passthroughName).toBe("mcp");
    expect(result.toolCall).toBeUndefined();
  });

  it("should intercept mcp__ calls and return the Kilo native name", () => {
    const event = createToolCallEvent("mcp__context7__resolve_library_id", { library: "react" });

    const result = extractOpenAiToolCall(
      event,
      new Set(["context7_resolve-library-id", "mcp__context7__resolve_library_id"]),
    );

    expect(result.action).toBe("intercept");
    expect(result.toolCall?.function.name).toBe("context7_resolve-library-id");
  });

  it("should intercept GetMcpTools as GetDynamicTools catalog", () => {
    const event = createToolCallEvent("GetMcpTools", {});

    const result = extractOpenAiToolCall(event, new Set(["context7_search", "GetDynamicTools"]));

    expect(result.action).toBe("intercept");
    expect(result.toolCall?.function.name).toBe("GetDynamicTools");
  });

  it("should remap CallDynamicTool to the Kilo MCP name", () => {
    const event = createToolCallEvent("CallDynamicTool", {
      namespace: "openviking",
      toolName: "search",
      arguments: { query: "test" },
    });

    const result = extractOpenAiToolCall(
      event,
      new Set(["openviking_search", "GetDynamicTools"]),
    );

    expect(result.action).toBe("intercept");
    expect(result.toolCall?.function.name).toBe("openviking_search");
    expect(JSON.parse(result.toolCall?.function.arguments ?? "{}")).toEqual({ query: "test" });
  });

  it("should remap CallDynamicTool for hyphenated servers missing from the allowlist", () => {
    const event = createToolCallEvent("CallDynamicTool", {
      namespace: "browser-harness",
      toolName: "browser_list_tabs",
      arguments: { include_chrome: false },
    });

    const result = extractOpenAiToolCall(event, new Set(["read", "GetDynamicTools"]));

    expect(result.action).toBe("intercept");
    expect(result.toolCall?.function.name).toBe("browser-harness_browser_list_tabs");
    expect(JSON.parse(result.toolCall?.function.arguments ?? "{}")).toEqual({ include_chrome: false });
  });

  it("remaps CallDynamicTool kilo/skill even when skill is missing from the allowlist", () => {
    const event = createToolCallEvent("CallDynamicTool", {
      namespace: "kilo",
      toolName: "skill",
      arguments: { name: "bmad-spec" },
    });

    const result = extractOpenAiToolCall(event, new Set(["read", "GetDynamicTools"]));

    expect(result.action).toBe("intercept");
    expect(result.toolCall?.function.name).toBe("skill");
    expect(JSON.parse(result.toolCall?.function.arguments ?? "{}")).toEqual({ name: "bmad-spec" });
  });

  it("intercepts unknown skill tool calls and forwards them to Kilo", () => {
    const event = {
      type: "tool_call",
      call_id: "call_unknown_skill",
      name: "skill",
      tool_call: {
        unknownToolCall: {
          args: { name: "bmad-spec" },
        },
      },
    } as any;

    const result = extractOpenAiToolCall(event, new Set(["read"]));

    expect(result.action).toBe("intercept");
    expect(result.toolCall?.function.name).toBe("skill");
    expect(JSON.parse(result.toolCall?.function.arguments ?? "{}")).toEqual({ name: "bmad-spec" });
  });

  it("fills skill.name when the model passes CallDynamicTool-shaped skill args", () => {
    const event = {
      type: "tool_call",
      call_id: "call_skill_shaped",
      name: "skill",
      tool_call: {
        skill: {
          args: { namespace: "kilo", toolName: "bmad-spec" },
        },
      },
    } as any;

    const result = extractOpenAiToolCall(event, new Set(["read"]));

    expect(result.action).toBe("intercept");
    expect(result.toolCall?.function.name).toBe("skill");
    expect(JSON.parse(result.toolCall?.function.arguments ?? "{}")).toEqual({
      namespace: "kilo",
      toolName: "bmad-spec",
      name: "bmad-spec",
    });
  });

  it("lifts CallDynamicTool top-level name onto skill arguments", () => {
    const event = createToolCallEvent("CallDynamicTool", {
      namespace: "kilo",
      toolName: "skill",
      name: "bmad-spec",
    });

    const result = extractOpenAiToolCall(event, new Set(["read", "GetDynamicTools"]));

    expect(result.action).toBe("intercept");
    expect(result.toolCall?.function.name).toBe("skill");
    expect(JSON.parse(result.toolCall?.function.arguments ?? "{}")).toEqual({ name: "bmad-spec" });
  });

  it("should intercept GetDynamicToolsToolCall events as the Kilo catalog", () => {
    const event = {
      type: "tool_call",
      tool_call: {
        GetDynamicToolsToolCall: { args: { namespace: "openviking" } },
      },
      call_id: "call_gdt",
    } as any;

    const result = extractOpenAiToolCall(event, new Set(["openviking_health", "GetDynamicTools"]));

    expect(result.action).toBe("intercept");
    expect(result.toolCall?.function.name).toBe("GetDynamicTools");
    expect(JSON.parse(result.toolCall?.function.arguments ?? "{}")).toEqual({ namespace: "openviking" });
  });

  it("should intercept a remembered MCP tool even if it is missing from this request allowlist", () => {
    resetRememberedMcpCatalog();
    rememberMcpCatalogFromTools([
      { function: { name: "openviking_search", description: "search" } },
    ]);

    const event = createToolCallEvent("openviking_health", {});
    const result = extractOpenAiToolCall(event, new Set(["read", "GetDynamicTools"]));

    expect(result.action).toBe("intercept");
    expect(result.toolCall?.function.name).toBe("openviking_health");
    resetRememberedMcpCatalog();
  });

  it("should intercept MCP tools for a server listed by mcp.status even without tool defs", () => {
    resetRememberedMcpCatalog();
    rememberMcpServers(["openviking", "browser-harness"]);

    const viking = extractOpenAiToolCall(
      createToolCallEvent("openviking_health", {}),
      new Set(["read", "GetDynamicTools"]),
    );
    const harness = extractOpenAiToolCall(
      createToolCallEvent("browser-harness_browser_list_tabs", { include_chrome: false }),
      new Set(["read", "GetDynamicTools"]),
    );

    expect(viking.action).toBe("intercept");
    expect(viking.toolCall?.function.name).toBe("openviking_health");
    expect(harness.action).toBe("intercept");
    expect(harness.toolCall?.function.name).toBe("browser-harness_browser_list_tabs");
    resetRememberedMcpCatalog();
  });

  it("should passthrough CallDynamicTool for the cursor namespace", () => {
    const event = createToolCallEvent("CallDynamicTool", {
      namespace: "cursor",
      toolName: "CreateGoal",
      arguments: { title: "x" },
    });

    const result = extractOpenAiToolCall(event, new Set(["openviking_search", "GetDynamicTools"]));

    expect(result.action).toBe("passthrough");
    expect(result.passthroughName).toBe("CallDynamicTool");
  });

  it("intercepts GetDynamicTools from tool_call.function (Cursor other-tools envelope)", () => {
    const event = {
      type: "tool_call",
      subtype: "started",
      call_id: "call_gdt_fn",
      tool_call: {
        function: {
          name: "GetDynamicTools",
          arguments: JSON.stringify({ namespace: "cursor" }),
        },
      },
    } as any;

    const result = extractOpenAiToolCall(event, new Set(["openviking_search", "GetDynamicTools"]));

    expect(result.action).toBe("intercept");
    expect(result.toolCall?.function.name).toBe("GetDynamicTools");
    expect(JSON.parse(result.toolCall?.function.arguments ?? "{}")).toEqual({ namespace: "cursor" });
  });

  it("remaps CallDynamicTool from tool_call.function to the Kilo MCP name", () => {
    const event = {
      type: "tool_call",
      subtype: "started",
      call_id: "call_cdt_fn",
      tool_call: {
        function: {
          name: "CallDynamicTool",
          arguments: JSON.stringify({
            namespace: "openviking",
            toolName: "find",
            arguments: { query: "openviking health", limit: 3 },
          }),
        },
      },
    } as any;

    const result = extractOpenAiToolCall(
      event,
      new Set(["openviking_find", "GetDynamicTools"]),
    );

    expect(result.action).toBe("intercept");
    expect(result.toolCall?.function.name).toBe("openviking_find");
    expect(JSON.parse(result.toolCall?.function.arguments ?? "{}")).toEqual({
      query: "openviking health",
      limit: 3,
    });
  });

  it("remaps unknownToolCall CallDynamicTool payloads for hyphenated servers", () => {
    const event = {
      type: "tool_call",
      subtype: "started",
      call_id: "call_unknown_cdt",
      tool_call: {
        unknownToolCall: {
          args: {
            namespace: "browser-harness",
            toolName: "browser_list_tabs",
            arguments: { include_chrome: false },
          },
        },
      },
    } as any;

    const result = extractOpenAiToolCall(event, new Set(["read", "GetDynamicTools"]));

    expect(result.action).toBe("intercept");
    expect(result.toolCall?.function.name).toBe("browser-harness_browser_list_tabs");
    expect(JSON.parse(result.toolCall?.function.arguments ?? "{}")).toEqual({
      include_chrome: false,
    });
  });

  it("unwraps CallDynamicTool nested inside unknownToolCall.args.name", () => {
    const event = {
      type: "tool_call",
      subtype: "started",
      call_id: "call_nested_cdt",
      tool_call: {
        unknownToolCall: {
          args: {
            name: "CallDynamicTool",
            arguments: {
              namespace: "openviking",
              toolName: "list",
              arguments: { uri: "viking://user/raphael/memories" },
            },
          },
        },
      },
    } as any;

    const result = extractOpenAiToolCall(event, new Set(["openviking_list", "GetDynamicTools"]));

    expect(result.action).toBe("intercept");
    expect(result.toolCall?.function.name).toBe("openviking_list");
    expect(JSON.parse(result.toolCall?.function.arguments ?? "{}")).toEqual({
      uri: "viking://user/raphael/memories",
    });
  });

  it("intercepts GetDynamicTools inferred from unknownToolCall catalog args", () => {
    const event = {
      type: "tool_call",
      subtype: "started",
      call_id: "call_unknown_gdt",
      tool_call: {
        unknownToolCall: {
          args: { namespace: "openviking" },
        },
      },
    } as any;

    const result = extractOpenAiToolCall(event, new Set(["openviking_health", "GetDynamicTools"]));

    expect(result.action).toBe("intercept");
    expect(result.toolCall?.function.name).toBe("GetDynamicTools");
    expect(JSON.parse(result.toolCall?.function.arguments ?? "{}")).toEqual({
      namespace: "openviking",
    });
  });
});
