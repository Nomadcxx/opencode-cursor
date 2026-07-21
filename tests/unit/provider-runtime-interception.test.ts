import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { OpenAiToolCall } from "../../src/proxy/tool-loop";
import { createProviderBoundary } from "../../src/provider/boundary";
import { createToolLoopGuard } from "../../src/provider/tool-loop-guard";
import {
  handleToolLoopEventLegacy,
  handleToolLoopEventV1,
  handleToolLoopEventWithFallback,
} from "../../src/provider/runtime-interception";

type EventOptions = Parameters<typeof handleToolLoopEventLegacy>[0];

function createBaseOptions(overrides: Partial<EventOptions> = {}): EventOptions {
  const updates: any[] = [];
  const toolResults: any[] = [];
  const intercepted: any[] = [];

  const event: any = {
    type: "tool_call",
    call_id: "c1",
    tool_call: {
      readToolCall: {
        args: { path: "foo.txt" },
      },
    },
  };

  const base: EventOptions = {
    event,
    toolLoopMode: "opencode",
    allowedToolNames: new Set(["read"]),
    toolSchemaMap: new Map(),
    toolLoopGuard: createToolLoopGuard([], 3),
    toolMapper: {
      mapCursorEventToAcp: async () => updates,
    } as any,
    toolSessionId: "session-1",
    shouldEmitToolUpdates: false,
    proxyExecuteToolCalls: false,
    suppressConverterToolEvents: false,
    responseMeta: { id: "resp-1", created: 123, model: "auto" },
    onToolUpdate: async (update) => {
      updates.push(update);
    },
    onToolResult: async (toolResult) => {
      toolResults.push(toolResult);
    },
    onInterceptedToolCall: async (toolCall) => {
      intercepted.push(toolCall);
    },
  };

  return { ...base, ...overrides };
}

const EDIT_WRITE_SCHEMA_MAP = new Map([
  [
    "edit",
    {
      type: "object",
      properties: {
        path: { type: "string" },
        old_string: { type: "string" },
        new_string: { type: "string" },
      },
      required: ["path", "old_string", "new_string"],
      additionalProperties: false,
    },
  ],
  [
    "write",
    {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
    },
  ],
]);

const OPENCODE_EDIT_WRITE_SCHEMA_MAP = new Map([
  [
    "edit",
    {
      type: "object",
      properties: {
        filePath: { type: "string" },
        oldString: { type: "string" },
        newString: { type: "string" },
        replaceAll: { type: "boolean" },
      },
      required: ["filePath", "oldString", "newString"],
      additionalProperties: false,
    },
  ],
  [
    "write",
    {
      type: "object",
      properties: {
        filePath: { type: "string" },
        content: { type: "string" },
      },
      required: ["filePath", "content"],
      additionalProperties: false,
    },
  ],
]);

const OC_EDIT_WRITE_SCHEMA_MAP = new Map([
  [
    "oc_edit",
    {
      type: "object",
      properties: {
        path: { type: "string" },
        old_string: { type: "string" },
        new_string: { type: "string" },
        streamContent: { type: "string" },
      },
      required: ["path", "old_string", "new_string"],
    },
  ],
  [
    "oc_write",
    {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
    },
  ],
]);

function createEditPathContentRerouteOverrides(
  overrides: Partial<EventOptions> = {},
): Partial<EventOptions> {
  return {
    event: {
      type: "tool_call",
      call_id: "c_edit_reroute",
      tool_call: {
        editToolCall: {
          args: { path: "TODO.md", content: "full rewrite" },
        },
      },
    } as any,
    allowedToolNames: new Set(["edit", "write"]),
    toolSchemaMap: EDIT_WRITE_SCHEMA_MAP,
    ...overrides,
  };
}

describe("provider runtime interception parity", () => {
  it("produces equivalent interception results for legacy and v1 in opencode mode", async () => {
    const legacyOptions = createBaseOptions();
    const v1Options = {
      ...createBaseOptions(),
      boundary: createProviderBoundary("v1", "cursor-acp"),
    };

    const legacyResult = await handleToolLoopEventLegacy(legacyOptions);
    const v1Result = await handleToolLoopEventV1(v1Options);

    expect(legacyResult).toEqual({ intercepted: true, skipConverter: true });
    expect(v1Result).toEqual(legacyResult);
  });

  it("legacy and v1 agree on edit path+content reroute to write", async () => {
    const interceptedLegacy: OpenAiToolCall[] = [];
    const interceptedV1: OpenAiToolCall[] = [];
    const rerouteOverrides = createEditPathContentRerouteOverrides();

    const legacyResult = await handleToolLoopEventLegacy(
      createBaseOptions({
        ...rerouteOverrides,
        onInterceptedToolCall: async (toolCall) => {
          interceptedLegacy.push(toolCall);
        },
      }),
    );
    const v1Result = await handleToolLoopEventV1({
      ...createBaseOptions({
        ...rerouteOverrides,
        onInterceptedToolCall: async (toolCall) => {
          interceptedV1.push(toolCall);
        },
      }),
      boundary: createProviderBoundary("v1", "cursor-acp"),
    });

    expect(legacyResult).toEqual({ intercepted: true, skipConverter: true });
    expect(v1Result).toEqual(legacyResult);
    expect(interceptedLegacy).toHaveLength(1);
    expect(interceptedV1).toHaveLength(1);
    expect(interceptedLegacy[0]?.function.name).toBe("write");
    expect(interceptedV1[0]?.function.name).toBe("write");
    const legacyArgs = JSON.parse(interceptedLegacy[0]?.function.arguments ?? "{}");
    const v1Args = JSON.parse(interceptedV1[0]?.function.arguments ?? "{}");
    expect(legacyArgs).toEqual(v1Args);
    expect(legacyArgs.path).toBe("TODO.md");
    expect(legacyArgs.content).toBe("full rewrite");
  });

  it("produces equivalent proxy-exec passthrough behavior in legacy and v1", async () => {
    const updatesLegacy: any[] = [];
    const updatesV1: any[] = [];
    const resultsLegacy: any[] = [];
    const resultsV1: any[] = [];
    const toolResult = { id: "tool-result" };

    const event: any = {
      type: "tool_call",
      call_id: "c2",
      tool_call: {
        bashToolCall: {
          args: { command: "echo ok" },
        },
      },
    };

    const createOptions = (updates: any[], results: any[]): EventOptions => ({
      event,
      toolLoopMode: "proxy-exec",
      allowedToolNames: new Set(["read"]),
      toolSchemaMap: new Map(),
      toolLoopGuard: createToolLoopGuard([], 3),
      toolMapper: {
        mapCursorEventToAcp: async () => [{ toolCallId: "u1", status: "pending" }],
      } as any,
      toolSessionId: "session-2",
      shouldEmitToolUpdates: true,
      proxyExecuteToolCalls: true,
      suppressConverterToolEvents: true,
      toolRouter: {
        handleToolCall: async () => toolResult,
      } as any,
      responseMeta: { id: "resp-2", created: 456, model: "auto" },
      onToolUpdate: async (update) => {
        updates.push(update);
      },
      onToolResult: async (result) => {
        results.push(result);
      },
      onInterceptedToolCall: async () => {
        throw new Error("should not intercept");
      },
    });

    const legacyResult = await handleToolLoopEventLegacy(createOptions(updatesLegacy, resultsLegacy));
    const v1Result = await handleToolLoopEventV1({
      ...createOptions(updatesV1, resultsV1),
      boundary: createProviderBoundary("v1", "cursor-acp"),
    });

    expect(legacyResult).toEqual({ intercepted: false, skipConverter: true });
    expect(v1Result).toEqual(legacyResult);
    expect(updatesLegacy.length).toBe(1);
    expect(updatesV1.length).toBe(1);
    expect(resultsLegacy).toEqual([toolResult]);
    expect(resultsV1).toEqual([toolResult]);
  });

  it("suppresses converter output for passthrough tool calls when requested", async () => {
    const event: any = {
      type: "tool_call",
      call_id: "c2",
      tool_call: {
        browserNavigateToolCall: {
          args: { url: "https://example.com" },
        },
      },
    };

    const legacyResult = await handleToolLoopEventLegacy(
      createBaseOptions({
        event,
        allowedToolNames: new Set(["read"]),
        suppressConverterToolEvents: true,
      }),
    );
    const v1Result = await handleToolLoopEventV1({
      ...createBaseOptions({
        event,
        allowedToolNames: new Set(["read"]),
        suppressConverterToolEvents: true,
      }),
      boundary: createProviderBoundary("v1", "cursor-acp"),
    });

    expect(legacyResult).toEqual({ intercepted: false, skipConverter: true });
    expect(v1Result).toEqual(legacyResult);
  });
});

describe("provider runtime interception fallback", () => {
  it("falls back from v1 to legacy when boundary extraction throws", async () => {
    let fallbackCalled = false;
    let mapperCalls = 0;
    let interceptedName = "";

    const boundary = createProviderBoundary("v1", "cursor-acp");
    const brokenBoundary = {
      ...boundary,
      maybeExtractToolCall() {
        throw new Error("boundary extraction failed");
      },
    };

    const result = await handleToolLoopEventWithFallback({
      ...createBaseOptions({
        toolMapper: {
          mapCursorEventToAcp: async () => {
            mapperCalls += 1;
            return [];
          },
        } as any,
        onInterceptedToolCall: async (toolCall) => {
          interceptedName = toolCall.function.name;
        },
      }),
      boundary: brokenBoundary as any,
      boundaryMode: "v1",
      autoFallbackToLegacy: true,
      onFallbackToLegacy: () => {
        fallbackCalled = true;
      },
    });

    expect(fallbackCalled).toBe(true);
    expect(mapperCalls).toBe(0);
    expect(interceptedName).toBe("read");
    expect(result).toEqual({ intercepted: true, skipConverter: true });
  });

  it("does not fallback for non-boundary errors", async () => {
    let fallbackCalled = false;
    const promise = handleToolLoopEventWithFallback({
      ...createBaseOptions({
        toolLoopMode: "proxy-exec",
        toolMapper: {
          mapCursorEventToAcp: async () => {
            throw new Error("mapper failure");
          },
        } as any,
      }),
      boundary: createProviderBoundary("v1", "cursor-acp"),
      boundaryMode: "v1",
      autoFallbackToLegacy: true,
      onFallbackToLegacy: () => {
        fallbackCalled = true;
      },
    });

    await expect(promise).rejects.toThrow("mapper failure");
    expect(fallbackCalled).toBe(false);
  });

  it("uses legacy path directly when boundary mode is legacy", async () => {
    const result = await handleToolLoopEventWithFallback({
      ...createBaseOptions(),
      boundary: createProviderBoundary("legacy", "cursor-acp"),
      boundaryMode: "legacy",
      autoFallbackToLegacy: true,
    });

    expect(result).toEqual({ intercepted: true, skipConverter: true });
  });

  it("normalizes v1 arguments using schema compatibility before intercept", async () => {
    let interceptedArgs = "";
    const result = await handleToolLoopEventV1({
      ...createBaseOptions({
        event: {
          type: "tool_call",
          call_id: "c3",
          tool_call: {
            writeToolCall: {
              args: { filePath: "foo.txt", contents: "hello" },
            },
          },
        } as any,
        allowedToolNames: new Set(["write"]),
        toolSchemaMap: new Map([
          [
            "write",
            {
              type: "object",
              properties: {
                path: { type: "string" },
                content: { type: "string" },
              },
              required: ["path", "content"],
            },
          ],
        ]),
        onInterceptedToolCall: async (toolCall) => {
          interceptedArgs = toolCall.function.arguments;
        },
      }),
      boundary: createProviderBoundary("v1", "cursor-acp"),
    });

    expect(result).toEqual({ intercepted: true, skipConverter: true });
    expect(interceptedArgs).toContain("\"path\":\"foo.txt\"");
    expect(interceptedArgs).toContain("\"content\":\"hello\"");
  });

  it("normalizes legacy arguments using schema compatibility before intercept", async () => {
    let interceptedArgs = "";
    const result = await handleToolLoopEventLegacy(
      createBaseOptions({
        event: {
          type: "tool_call",
          call_id: "c3-legacy",
          tool_call: {
            writeToolCall: {
              args: { filePath: "foo.txt", contents: "hello" },
            },
          },
        } as any,
        allowedToolNames: new Set(["write"]),
        toolSchemaMap: new Map([
          [
            "write",
            {
              type: "object",
              properties: {
                path: { type: "string" },
                content: { type: "string" },
              },
              required: ["path", "content"],
            },
          ],
        ]),
        onInterceptedToolCall: async (toolCall) => {
          interceptedArgs = toolCall.function.arguments;
        },
      }),
    );

    expect(result).toEqual({ intercepted: true, skipConverter: true });
    expect(interceptedArgs).toContain("\"path\":\"foo.txt\"");
    expect(interceptedArgs).toContain("\"content\":\"hello\"");
  });

  it("reroutes path+content edit missing old_string to write in v1", async () => {
    const intercepted: OpenAiToolCall[] = [];
    const toolResults: any[] = [];
    const result = await handleToolLoopEventV1({
      ...createBaseOptions({
        ...createEditPathContentRerouteOverrides(),
        onToolResult: async (toolResult) => {
          toolResults.push(toolResult);
        },
        onInterceptedToolCall: async (toolCall) => {
          intercepted.push(toolCall);
        },
      }),
      boundary: createProviderBoundary("v1", "cursor-acp"),
    });

    expect(result).toEqual({ intercepted: true, skipConverter: true });
    expect(toolResults).toHaveLength(0);
    expect(intercepted).toHaveLength(1);
    expect(intercepted[0]?.function.name).toBe("write");
    const args = JSON.parse(intercepted[0]?.function.arguments ?? "{}");
    expect(args.path).toBe("TODO.md");
    expect(args.content).toBe("full rewrite");
  });

  it("reroutes opencode-style filePath+content edit payloads to write in v1", async () => {
    const intercepted: OpenAiToolCall[] = [];
    const result = await handleToolLoopEventV1({
      ...createBaseOptions({
        event: {
          type: "tool_call",
          call_id: "c_edit_file_path_content",
          tool_call: {
            editToolCall: {
              args: { filePath: "/tmp/project/test.txt", content: "full rewrite" },
            },
          },
        } as any,
        allowedToolNames: new Set(["edit", "write"]),
        toolSchemaMap: OPENCODE_EDIT_WRITE_SCHEMA_MAP,
        onInterceptedToolCall: async (toolCall) => {
          intercepted.push(toolCall);
        },
      }),
      boundary: createProviderBoundary("v1", "cursor-acp"),
    });

    expect(result).toEqual({ intercepted: true, skipConverter: true });
    expect(intercepted).toHaveLength(1);
    expect(intercepted[0]?.function.name).toBe("write");
    const args = JSON.parse(intercepted[0]?.function.arguments ?? "{}");
    expect(args.filePath).toBe("/tmp/project/test.txt");
    expect(args.content).toBe("full rewrite");
    expect(args.path).toBeUndefined();
  });

  it("reroutes opencode path+streamContent edit payloads to write in v1", async () => {
    const intercepted: OpenAiToolCall[] = [];
    const result = await handleToolLoopEventV1({
      ...createBaseOptions({
        event: {
          type: "tool_call",
          call_id: "c_edit_path_stream_content",
          tool_call: {
            editToolCall: {
              args: {
                path: "/tmp/project/test.txt",
                streamContent: "49\ntest\n51",
              },
            },
          },
        } as any,
        allowedToolNames: new Set(["edit", "write"]),
        toolSchemaMap: OPENCODE_EDIT_WRITE_SCHEMA_MAP,
        onInterceptedToolCall: async (toolCall) => {
          intercepted.push(toolCall);
        },
      }),
      boundary: createProviderBoundary("v1", "cursor-acp"),
    });

    expect(result).toEqual({ intercepted: true, skipConverter: true });
    expect(intercepted).toHaveLength(1);
    expect(intercepted[0]?.function.name).toBe("write");
    const args = JSON.parse(intercepted[0]?.function.arguments ?? "{}");
    expect(args.filePath).toBe("/tmp/project/test.txt");
    expect(args.content).toBe("49\ntest\n51");
    expect(args.path).toBeUndefined();
  });

  it("reroutes bare cursor editToolCall to oc_write when fallback tools are active", async () => {
    const intercepted: OpenAiToolCall[] = [];
    const result = await handleToolLoopEventV1({
      ...createBaseOptions({
        event: {
          type: "tool_call",
          call_id: "c_oc_edit_stream_content",
          tool_call: {
            editToolCall: {
              args: {
                path: "/tmp/project/test.txt",
                streamContent: "body",
              },
            },
          },
        } as any,
        allowedToolNames: new Set(["oc_edit", "oc_write"]),
        toolSchemaMap: OC_EDIT_WRITE_SCHEMA_MAP,
        onInterceptedToolCall: async (toolCall) => {
          intercepted.push(toolCall);
        },
      }),
      boundary: createProviderBoundary("v1", "cursor-acp"),
    });

    expect(result).toEqual({ intercepted: true, skipConverter: true });
    expect(intercepted).toHaveLength(1);
    expect(intercepted[0]?.function.name).toBe("oc_write");
    const args = JSON.parse(intercepted[0]?.function.arguments ?? "{}");
    expect(args.path).toBe("/tmp/project/test.txt");
    expect(args.content).toBe("body");
    expect(args.filePath).toBeUndefined();
  });

  it("reroutes full-file edit payloads before schema validation when schemas are absent", async () => {
    const intercepted: OpenAiToolCall[] = [];
    const result = await handleToolLoopEventV1({
      ...createBaseOptions({
        event: {
          type: "tool_call",
          call_id: "c_edit_no_schema",
          tool_call: {
            editToolCall: {
              args: {
                path: "/home/nomadx/SOVIET_SPACE_TRUE_BASELINE.md",
                content: "body",
              },
            },
          },
        } as any,
        allowedToolNames: new Set(["edit", "write"]),
        toolSchemaMap: new Map(),
        onInterceptedToolCall: async (toolCall) => {
          intercepted.push(toolCall);
        },
      }),
      boundary: createProviderBoundary("v1", "cursor-acp"),
    });

    expect(result).toEqual({ intercepted: true, skipConverter: true });
    expect(intercepted).toHaveLength(1);
    expect(intercepted[0]?.function.name).toBe("write");
    const args = JSON.parse(intercepted[0]?.function.arguments ?? "{}");
    expect(args.filePath).toBe("/home/nomadx/SOVIET_SPACE_TRUE_BASELINE.md");
    expect(args.content).toBe("body");
    expect(args.path).toBeUndefined();
  });

  it("skips schema-absent edit payloads that cannot execute", async () => {
    const intercepted: OpenAiToolCall[] = [];
    const toolResults: any[] = [];
    const result = await handleToolLoopEventV1({
      ...createBaseOptions({
        event: {
          type: "tool_call",
          call_id: "c_edit_path_only_no_schema",
          tool_call: {
            editToolCall: {
              args: {
                path: "/home/nomadx/SOVIET_SPACE_TRUE_BASELINE.md",
              },
            },
          },
        } as any,
        allowedToolNames: new Set(["edit", "write"]),
        toolSchemaMap: new Map(),
        onInterceptedToolCall: async (toolCall) => {
          intercepted.push(toolCall);
        },
        onToolResult: async (toolResult) => {
          toolResults.push(toolResult);
        },
      }),
      boundary: createProviderBoundary("v1", "cursor-acp"),
    });

    expect(result).toEqual({ intercepted: false, skipConverter: true });
    expect(intercepted).toHaveLength(0);
    expect(toolResults).toHaveLength(1);
    const hint = toolResults[0]?.choices?.[0]?.delta?.content ?? "";
    expect(hint).toContain("Skipped malformed tool call");
    expect(hint).toContain("oldString");
    expect(hint).toContain("newString");
  });

  it("skips suspicious streamContent write reroutes that would shrink an existing file", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "runtime-stream-content-shrink-"));
    const target = join(projectDir, "test.txt");
    writeFileSync(target, Array.from({ length: 100 }, (_, index) => String(index + 1)).join("\n") + "\n");
    const toolResults: any[] = [];
    let interceptedCount = 0;
    const result = await handleToolLoopEventV1({
      ...createBaseOptions({
        event: {
          type: "tool_call",
          call_id: "c_edit_path_stream_content_shrink",
          tool_call: {
            editToolCall: {
              args: {
                path: target,
                streamContent: "49\ntest\n51",
              },
            },
          },
        } as any,
        allowedToolNames: new Set(["edit", "write"]),
        toolSchemaMap: OPENCODE_EDIT_WRITE_SCHEMA_MAP,
        onToolResult: async (toolResult) => {
          toolResults.push(toolResult);
        },
        onInterceptedToolCall: async () => {
          interceptedCount += 1;
        },
      }),
      boundary: createProviderBoundary("v1", "cursor-acp"),
    });

    expect(result).toEqual({ intercepted: false, skipConverter: true });
    expect(interceptedCount).toBe(0);
    expect(toolResults).toHaveLength(0);
    expect(readFileSync(target, "utf-8").split("\n").slice(47, 52)).toEqual(["48", "49", "50", "51", "52"]);
  });

  it("skips suspicious fileText write reroutes that would shrink an existing file", async () => {
    // cursor-agent 2026.07.17 renamed the full-file body field to fileText;
    // the overwrite guard must apply to those payloads too.
    const projectDir = mkdtempSync(join(tmpdir(), "runtime-file-text-shrink-"));
    const target = join(projectDir, "test.txt");
    writeFileSync(target, Array.from({ length: 100 }, (_, index) => String(index + 1)).join("\n") + "\n");
    const toolResults: any[] = [];
    let interceptedCount = 0;
    const result = await handleToolLoopEventV1({
      ...createBaseOptions({
        event: {
          type: "tool_call",
          call_id: "c_edit_path_file_text_shrink",
          tool_call: {
            editToolCall: {
              args: {
                path: target,
                fileText: "49\ntest\n51",
              },
            },
          },
        } as any,
        allowedToolNames: new Set(["edit", "write"]),
        toolSchemaMap: OPENCODE_EDIT_WRITE_SCHEMA_MAP,
        onToolResult: async (toolResult) => {
          toolResults.push(toolResult);
        },
        onInterceptedToolCall: async () => {
          interceptedCount += 1;
        },
      }),
      boundary: createProviderBoundary("v1", "cursor-acp"),
    });

    expect(result).toEqual({ intercepted: false, skipConverter: true });
    expect(interceptedCount).toBe(0);
    expect(toolResults).toHaveLength(0);
    expect(readFileSync(target, "utf-8").split("\n").slice(47, 52)).toEqual(["48", "49", "50", "51", "52"]);
  });

  it("records completed Cursor-owned edits when skipping suspicious streamContent reroutes", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "runtime-cursor-owned-edit-"));
    const target = join(projectDir, "test.txt");
    writeFileSync(target, Array.from({ length: 100 }, (_, index) => index === 49 ? "test" : String(index + 1)).join("\n") + "\n");
    let interceptedCount = 0;
    const result = await handleToolLoopEventV1({
      ...createBaseOptions({
        event: {
          type: "tool_call",
          subtype: "completed",
          call_id: "c_cursor_owned_edit",
          tool_call: {
            editToolCall: {
              args: {
                path: target,
                streamContent: "49\ntest\n51",
              },
              result: {
                success: {
                  path: target,
                  linesAdded: 1,
                  linesRemoved: 1,
                },
              },
            },
          },
        } as any,
        allowedToolNames: new Set(["edit", "write"]),
        toolSchemaMap: OPENCODE_EDIT_WRITE_SCHEMA_MAP,
        onInterceptedToolCall: async () => {
          interceptedCount += 1;
        },
      }),
      boundary: createProviderBoundary("v1", "cursor-acp"),
    });

    expect(result).toEqual({
      intercepted: false,
      skipConverter: true,
      cursorOwnedMutation: {
        tool: "edit",
        path: target,
        status: "completed",
        source: "cursor-agent",
        reason: "completed_cursor_edit_success",
      },
    });
    expect(interceptedCount).toBe(0);
  });

  it("reroutes path+content edit missing old_string to write in legacy", async () => {
    const intercepted: OpenAiToolCall[] = [];
    const toolResults: any[] = [];
    const result = await handleToolLoopEventLegacy(
      createBaseOptions({
        ...createEditPathContentRerouteOverrides(),
        onToolResult: async (toolResult) => {
          toolResults.push(toolResult);
        },
        onInterceptedToolCall: async (toolCall) => {
          intercepted.push(toolCall);
        },
      }),
    );

    expect(result).toEqual({ intercepted: true, skipConverter: true });
    expect(toolResults).toHaveLength(0);
    expect(intercepted).toHaveLength(1);
    expect(intercepted[0]?.function.name).toBe("write");
  });

  it("falls back to hint when write unavailable for path+content edit", async () => {
    const toolResults: any[] = [];
    let interceptedCount = 0;
    const result = await handleToolLoopEventV1({
      ...createBaseOptions({
        ...createEditPathContentRerouteOverrides({
          allowedToolNames: new Set(["edit"]),
        }),
        onToolResult: async (toolResult) => {
          toolResults.push(toolResult);
        },
        onInterceptedToolCall: async () => {
          interceptedCount += 1;
        },
      }),
      boundary: createProviderBoundary("v1", "cursor-acp"),
      schemaValidationFailureMode: "pass_through",
    });

    expect(result).toEqual({ intercepted: false, skipConverter: true });
    expect(interceptedCount).toBe(0);
    expect(toolResults).toHaveLength(1);
    const hint = toolResults[0]?.choices?.[0]?.delta?.content ?? "";
    expect(hint).toContain("Skipped malformed tool call");
    expect(hint).toContain("write");
    expect(hint.match(/missing required: old_string/g)?.length).toBe(1);
    expect(hint).not.toContain("missing required: old_string. missing required: old_string");
  });

  it("emits a non-fatal hint for explicit empty edit old_string in v1", async () => {
    let interceptedCount = 0;
    const toolResults: any[] = [];
    const result = await handleToolLoopEventV1({
      ...createBaseOptions({
        event: {
          type: "tool_call",
          call_id: "c_empty_old",
          tool_call: {
            editToolCall: {
              args: {
                path: "TODO.md",
                old_string: "",
                new_string: "-- test\nreturn {",
              },
            },
          },
        } as any,
        allowedToolNames: new Set(["edit"]),
        toolSchemaMap: new Map([
          [
            "edit",
            {
              type: "object",
              properties: {
                path: { type: "string" },
                old_string: { type: "string" },
                new_string: { type: "string" },
              },
              required: ["path", "old_string", "new_string"],
              additionalProperties: false,
            },
          ],
        ]),
        onToolResult: async (toolResult) => {
          toolResults.push(toolResult);
        },
        onInterceptedToolCall: async () => {
          interceptedCount += 1;
        },
      }),
      boundary: createProviderBoundary("v1", "cursor-acp"),
    });

    expect(result).toEqual({ intercepted: false, skipConverter: true });
    expect(interceptedCount).toBe(0);
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]?.choices?.[0]?.delta?.content).toContain("Skipped malformed tool call");
    expect(toolResults[0]?.choices?.[0]?.delta?.content).toContain("old_string");
  });

  it("emits a non-fatal hint and skips malformed edit execution in v1 pass-through mode", async () => {
    const toolResults: any[] = [];
    let interceptedCount = 0;
    const result = await handleToolLoopEventV1({
      ...createBaseOptions({
        event: {
          type: "tool_call",
          call_id: "c4",
          tool_call: {
            editToolCall: {
              args: { path: "TODO.md" },
            },
          },
        } as any,
        allowedToolNames: new Set(["edit"]),
        toolSchemaMap: new Map([
          [
            "edit",
            {
              type: "object",
              properties: {
                path: { type: "string" },
                old_string: { type: "string" },
                new_string: { type: "string" },
              },
              required: ["path", "old_string", "new_string"],
              additionalProperties: false,
            },
          ],
        ]),
        onToolResult: async (toolResult) => {
          toolResults.push(toolResult);
        },
        onInterceptedToolCall: async () => {
          interceptedCount += 1;
        },
      }),
      boundary: createProviderBoundary("v1", "cursor-acp"),
      schemaValidationFailureMode: "pass_through",
    });

    expect(result).toEqual({ intercepted: false, skipConverter: true });
    expect(interceptedCount).toBe(0);
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]?.choices?.[0]?.delta?.content).toContain("Skipped malformed tool call");
  });

  it("emits non-fatal hint for edit payloads missing path", async () => {
    const toolResults: any[] = [];
    let interceptedCount = 0;
    const result = await handleToolLoopEventV1({
      ...createBaseOptions({
        event: {
          type: "tool_call",
          call_id: "c4",
          tool_call: {
            editToolCall: {
              args: { content: "full rewrite" },
            },
          },
        } as any,
        allowedToolNames: new Set(["edit"]),
        toolSchemaMap: new Map([
          [
            "edit",
            {
              type: "object",
              properties: {
                path: { type: "string" },
                old_string: { type: "string" },
                new_string: { type: "string" },
              },
              required: ["path", "old_string", "new_string"],
              additionalProperties: false,
            },
          ],
        ]),
        onToolResult: async (toolResult) => {
          toolResults.push(toolResult);
        },
        onInterceptedToolCall: async () => {
          interceptedCount += 1;
        },
      }),
      boundary: createProviderBoundary("v1", "cursor-acp"),
      schemaValidationFailureMode: "pass_through",
    });

    expect(result).toEqual({ intercepted: false, skipConverter: true });
    expect(interceptedCount).toBe(0);
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]?.choices?.[0]?.delta?.content).toContain("Skipped malformed tool call");
  });

  it("still returns terminal schema validation error for edit type errors", async () => {
    const toolResults: any[] = [];
    let interceptedCount = 0;
    const result = await handleToolLoopEventV1({
      ...createBaseOptions({
        event: {
          type: "tool_call",
          call_id: "c4",
          tool_call: {
            editToolCall: {
              args: { path: 123, content: "full rewrite" },
            },
          },
        } as any,
        allowedToolNames: new Set(["edit"]),
        toolSchemaMap: new Map([
          [
            "edit",
            {
              type: "object",
              properties: {
                path: { type: "string" },
                old_string: { type: "string" },
                new_string: { type: "string" },
              },
              required: ["path", "old_string", "new_string"],
              additionalProperties: false,
            },
          ],
        ]),
        onToolResult: async (toolResult) => {
          toolResults.push(toolResult);
        },
        onInterceptedToolCall: async () => {
          interceptedCount += 1;
        },
      }),
      boundary: createProviderBoundary("v1", "cursor-acp"),
      schemaValidationFailureMode: "pass_through",
    });

    expect(result.intercepted).toBe(false);
    expect(result.skipConverter).toBe(true);
    expect(result.terminate?.reason).toBe("schema_validation");
    expect(result.terminate?.message).toContain("type errors");
    expect(interceptedCount).toBe(0);
    expect(toolResults).toHaveLength(0);
  });

  it("does not fallback for edit missing-path validation; emits hint instead", async () => {
    let fallbackCalled = false;
    const toolResults: any[] = [];
    const result = await handleToolLoopEventWithFallback({
      ...createBaseOptions({
        event: {
          type: "tool_call",
          call_id: "c4",
          tool_call: {
            editToolCall: {
              args: { content: "full rewrite" },
            },
          },
        } as any,
        allowedToolNames: new Set(["edit"]),
        toolSchemaMap: new Map([
          [
            "edit",
            {
              type: "object",
              properties: {
                path: { type: "string" },
                old_string: { type: "string" },
                new_string: { type: "string" },
              },
              required: ["path", "old_string", "new_string"],
              additionalProperties: false,
            },
          ],
        ]),
        onToolResult: async (toolResult) => {
          toolResults.push(toolResult);
        },
      }),
      boundary: createProviderBoundary("v1", "cursor-acp"),
      boundaryMode: "v1",
      autoFallbackToLegacy: true,
      onFallbackToLegacy: () => {
        fallbackCalled = true;
      },
    });

    expect(fallbackCalled).toBe(false);
    expect(result).toEqual({ intercepted: false, skipConverter: true });
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]?.choices?.[0]?.delta?.content).toContain("Skipped malformed tool call");
  });

  it("returns terminal result when loop guard threshold is reached without fallback", async () => {
    const guard = createToolLoopGuard(
      [{ role: "tool", tool_call_id: "c1", content: "invalid schema: missing path" }],
      1,
    );
    // "read" is an EXPLORATION_TOOL: effectiveMaxRepeat = 1 * 5 = 5.
    // Six pre-evaluations bring count=6 (soft trigger at 6). Runtime call = count=7 (hard, not first trigger).
    for (let i = 0; i < 6; i++) {
      guard.evaluate({
        id: "c1",
        type: "function",
        function: { name: "read", arguments: "{\"path\":\"foo.txt\"}" },
      });
    }

    const result = await handleToolLoopEventWithFallback({
      ...createBaseOptions({
        toolLoopGuard: guard,
      }),
      boundary: createProviderBoundary("v1", "cursor-acp"),
      boundaryMode: "v1",
      autoFallbackToLegacy: false,
    });

    expect(result.intercepted).toBe(false);
    expect(result.skipConverter).toBe(true);
    expect(result.terminate?.reason).toBe("loop_guard");
  });

  it("does not fallback on validation loop-guard termination; returns terminal response", async () => {
    let fallbackCalled = false;
    const guard = createToolLoopGuard(
      [{ role: "tool", tool_call_id: "c1", content: "invalid schema: missing path" }],
      1,
    );
    // "read" is an EXPLORATION_TOOL: effectiveMaxRepeat = 1 * 5 = 5.
    // Six pre-evaluations push past soft threshold. Runtime call = count=7 (hard terminate).
    for (let i = 0; i < 6; i++) {
      guard.evaluate({
        id: "c1",
        type: "function",
        function: { name: "read", arguments: "{\"path\":\"foo.txt\"}" },
      });
    }

    const result = await handleToolLoopEventWithFallback({
      ...createBaseOptions({
        toolLoopGuard: guard,
      }),
      boundary: createProviderBoundary("v1", "cursor-acp"),
      boundaryMode: "v1",
      autoFallbackToLegacy: true,
      onFallbackToLegacy: () => {
        fallbackCalled = true;
      },
    });

    expect(fallbackCalled).toBe(false);
    expect(result.intercepted).toBe(false);
    expect(result.skipConverter).toBe(true);
    expect(result.terminate?.reason).toBe("loop_guard");
    expect(result.terminate?.errorClass).toBe("validation");
  });

  it("does not fallback on success loop-guard termination; returns terminal response", async () => {
    let fallbackCalled = false;
    // Use 'edit' instead of 'read' - exploration tools have 5x limit multiplier
    const editArgs = "{\"filePath\":\"foo.txt\",\"oldString\":\"a\",\"newString\":\"b\"}";
    const guard = createToolLoopGuard(
      [{ role: "tool", tool_call_id: "c1", content: "{\"success\":true}" }],
      1,
    );
    // Pre-trigger guard: repeatCount=2 > maxRepeat=1
    guard.evaluate({
      id: "c1",
      type: "function",
      function: { name: "edit", arguments: editArgs },
    });
    guard.evaluate({
      id: "c2",
      type: "function",
      function: { name: "edit", arguments: editArgs },
    });

    const result = await handleToolLoopEventWithFallback({
      ...createBaseOptions({
        toolLoopGuard: guard,
        event: {
          type: "tool_call",
          call_id: "c3",
          tool_call: {
            editToolCall: {
              args: { filePath: "foo.txt", oldString: "a", newString: "b" },
            },
          },
        } as any,
        allowedToolNames: new Set(["edit"]),
      }),
      boundary: createProviderBoundary("v1", "cursor-acp"),
      boundaryMode: "v1",
      autoFallbackToLegacy: true,
      onFallbackToLegacy: () => {
        fallbackCalled = true;
      },
    });

    expect(fallbackCalled).toBe(false);
    expect(result.intercepted).toBe(false);
    expect(result.skipConverter).toBe(true);
    expect(result.terminate?.reason).toBe("loop_guard");
    expect(result.terminate?.errorClass).toBe("success");
  });

  it("emits a non-silent loop hint for repeated refused write calls", async () => {
    let fallbackCalled = false;
    const toolResults: any[] = [];
    const guard = createToolLoopGuard(
      [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "write-1",
              type: "function",
              function: {
                name: "write",
                arguments: JSON.stringify({
                  path: "test.txt",
                  content: "test",
                }),
              },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "write-1",
          content:
            "The write tool refused to overwrite test.txt because the new content is much smaller than the existing file.",
        },
      ],
      1,
    );

    const result = await handleToolLoopEventWithFallback({
      ...createBaseOptions({
        toolLoopGuard: guard,
        event: {
          type: "tool_call",
          call_id: "write-2",
          tool_call: {
            writeToolCall: {
              args: { path: "test.txt", content: "test" },
            },
          },
        } as any,
        allowedToolNames: new Set(["write"]),
        toolSchemaMap: new Map([
          [
            "write",
            {
              type: "object",
              properties: {
                path: { type: "string" },
                content: { type: "string" },
              },
              required: ["path", "content"],
              additionalProperties: false,
            },
          ],
        ]),
        onToolResult: async (toolResult) => {
          toolResults.push(toolResult);
        },
      }),
      boundary: createProviderBoundary("v1", "cursor-acp"),
      boundaryMode: "v1",
      autoFallbackToLegacy: true,
      onFallbackToLegacy: () => {
        fallbackCalled = true;
      },
    });

    expect(fallbackCalled).toBe(false);
    expect(result).toEqual({ intercepted: false, skipConverter: true });
    expect(toolResults).toHaveLength(1);
    const hint = toolResults[0]?.choices?.[0]?.delta?.content ?? "";
    expect(hint).toContain("Tool \"write\" has been temporarily blocked");
    expect(hint).toContain("tool_error");
  });

  it("does not fallback on multi-tool success loop-guard termination (write + context_info history)", async () => {
    let fallbackCalled = false;
    const guard = createToolLoopGuard(
      [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "edit-1",
              type: "function",
              function: {
                name: "write",
                arguments: JSON.stringify({
                  path: "TODO.md",
                  content: "ok",
                }),
              },
            },
            {
              id: "ctx-1",
              type: "function",
              function: {
                name: "context_info",
                arguments: JSON.stringify({ query: "project" }),
              },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "edit-1",
          content: "File edited successfully: TODO.md",
        },
        {
          role: "tool",
          tool_call_id: "ctx-1",
          content: "Here is some context.",
        },
      ],
      1,
    );

    const result = await handleToolLoopEventWithFallback({
      ...createBaseOptions({
        event: {
          type: "tool_call",
          call_id: "edit-2",
          tool_call: {
            writeToolCall: {
              args: { path: "TODO.md", content: "ok" },
            },
          },
        } as any,
        allowedToolNames: new Set(["write"]),
        toolSchemaMap: new Map([
          [
            "write",
            {
              type: "object",
              properties: {
                path: { type: "string" },
                content: { type: "string" },
              },
              required: ["path", "content"],
              additionalProperties: false,
            },
          ],
        ]),
        toolLoopGuard: guard,
      }),
      boundary: createProviderBoundary("v1", "cursor-acp"),
      boundaryMode: "v1",
      autoFallbackToLegacy: true,
      onFallbackToLegacy: () => {
        fallbackCalled = true;
      },
    });

    expect(fallbackCalled).toBe(false);
    expect(result.intercepted).toBe(false);
    expect(result.skipConverter).toBe(true);
    expect(result.terminate?.reason).toBe("loop_guard");
    expect(result.terminate?.errorClass).toBe("success");
  });

  it("falls back on non-validation loop-guard termination when auto-fallback is enabled", async () => {
    let fallbackCalled = false;
    let interceptedName = "";
    const guard = createToolLoopGuard(
      [{ role: "tool", tool_call_id: "c1", content: "timeout while running tool" }],
      1,
    );
    // "read" is an EXPLORATION_TOOL: effectiveMaxRepeat = 1 * 5 = 5.
    // Six pre-evaluations push past soft threshold. Runtime call = count=7 (hard terminate → fallback).
    for (let i = 0; i < 6; i++) {
      guard.evaluate({
        id: "c1",
        type: "function",
        function: { name: "read", arguments: "{\"path\":\"foo.txt\"}" },
      });
    }

    const result = await handleToolLoopEventWithFallback({
      ...createBaseOptions({
        toolLoopGuard: guard,
        onInterceptedToolCall: async (toolCall) => {
          interceptedName = toolCall.function.name;
        },
      }),
      boundary: createProviderBoundary("v1", "cursor-acp"),
      boundaryMode: "v1",
      autoFallbackToLegacy: true,
      onFallbackToLegacy: () => {
        fallbackCalled = true;
      },
    });

    expect(fallbackCalled).toBe(true);
    expect(interceptedName).toBe("read");
    expect(result).toEqual({ intercepted: true, skipConverter: true });
  });
});

describe("graduated response (soft/hard termination)", () => {
  it("returns soft termination on first loop guard trigger", async () => {
    const guard = createToolLoopGuard(
      [{ role: "tool", tool_call_id: "c1", content: "invalid arguments" }],
      1,
    );
    // "task" is now an EXPLORATION_TOOL: effectiveMaxRepeat = 1 * 5 = 5.
    // Five pre-evaluations: count=5, not yet triggered. Runtime call = count=6 = effectiveMaxRepeat+1 → first (soft) trigger.
    for (let i = 0; i < 5; i++) {
      guard.evaluate({
        id: "c1",
        type: "function",
        function: { name: "task", arguments: '{"prompt":"analyze"}' },
      });
    }

    const toolResults: any[] = [];
    const result = await handleToolLoopEventWithFallback({
      ...createBaseOptions({
        event: {
          type: "tool_call",
          call_id: "c2",
          tool_call: {
            taskToolCall: {
              args: { prompt: "analyze" },
            },
          },
        } as any,
        allowedToolNames: new Set(["task"]),
        toolSchemaMap: new Map(),
        toolLoopGuard: guard,
        onToolResult: async (toolResult) => {
          toolResults.push(toolResult);
        },
      }),
      boundary: createProviderBoundary("v1", "cursor-acp"),
      boundaryMode: "v1",
      autoFallbackToLegacy: false,
    });

    expect(result.terminate).toBeUndefined();
    expect(result.intercepted).toBe(false);
    expect(result.skipConverter).toBe(true);
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]?.choices?.[0]?.delta?.content).toContain("task");
    expect(toolResults[0]?.choices?.[0]?.delta?.content).toContain("blocked");
  });

  it("returns hard termination on second loop guard trigger", async () => {
    const guard = createToolLoopGuard(
      [{ role: "tool", tool_call_id: "c1", content: "invalid arguments" }],
      1,
    );
    // "task" is now an EXPLORATION_TOOL: effectiveMaxRepeat = 1 * 5 = 5.
    // Six pre-evaluations: count=6 = effectiveMaxRepeat+1 (soft trigger, but discarded by test).
    // Runtime call = count=7, 7 != effectiveMaxRepeat+1 (6) → NOT first trigger → hard termination.
    for (let i = 0; i < 6; i++) {
      guard.evaluate({
        id: "c1",
        type: "function",
        function: { name: "task", arguments: '{"prompt":"analyze"}' },
      });
    }

    const result = await handleToolLoopEventWithFallback({
      ...createBaseOptions({
        event: {
          type: "tool_call",
          call_id: "c3",
          tool_call: {
            taskToolCall: {
              args: { prompt: "analyze" },
            },
          },
        } as any,
        allowedToolNames: new Set(["task"]),
        toolSchemaMap: new Map(),
        toolLoopGuard: guard,
      }),
      boundary: createProviderBoundary("v1", "cursor-acp"),
      boundaryMode: "v1",
      autoFallbackToLegacy: false,
    });

    expect(result.terminate).toBeDefined();
    expect(result.terminate?.reason).toBe("loop_guard");
  });

  it("soft-blocks schema validation guard on first trigger", async () => {
    // Use edit with only path (no old_string, new_string, or content) so schema
    // compat can't repair it — validation actually fails, hitting the guard.
    const guard = createToolLoopGuard([], 1);
    guard.evaluateValidation(
      {
        id: "e1",
        type: "function",
        function: { name: "edit", arguments: '{"path":"TODO.md"}' },
      },
      "missing:old_string,new_string",
    );

    const toolResults: any[] = [];
    const result = await handleToolLoopEventV1({
      ...createBaseOptions({
        event: {
          type: "tool_call",
          call_id: "e2",
          tool_call: {
            editToolCall: {
              args: { path: "TODO.md" },
            },
          },
        } as any,
        allowedToolNames: new Set(["edit"]),
        toolSchemaMap: new Map([
          [
            "edit",
            {
              type: "object",
              properties: {
                path: { type: "string" },
                old_string: { type: "string" },
                new_string: { type: "string" },
              },
              required: ["path", "old_string", "new_string"],
              additionalProperties: false,
            },
          ],
        ]),
        toolLoopGuard: guard,
        onToolResult: async (toolResult) => {
          toolResults.push(toolResult);
        },
      }),
      boundary: createProviderBoundary("v1", "cursor-acp"),
    });

    // Soft block for schema validation: hint emitted, no termination
    expect(result.terminate).toBeUndefined();
    expect(result.intercepted).toBe(false);
    expect(result.skipConverter).toBe(true);
    expect(toolResults.length).toBeGreaterThanOrEqual(1);
  });

  it("success loop termination remains silent (not soft)", async () => {
    const guard = createToolLoopGuard(
      [{ role: "tool", tool_call_id: "c1", content: '{"success":true}' }],
      1,
    );
    guard.evaluate({
      id: "c1",
      type: "function",
      function: { name: "edit", arguments: '{"filePath":"foo.txt","oldString":"a","newString":"b"}' },
    });

    const result = await handleToolLoopEventWithFallback({
      ...createBaseOptions({
        event: {
          type: "tool_call",
          call_id: "c2",
          tool_call: {
            editToolCall: {
              args: { filePath: "foo.txt", oldString: "a", newString: "b" },
            },
          },
        } as any,
        allowedToolNames: new Set(["edit"]),
        toolLoopGuard: guard,
      }),
      boundary: createProviderBoundary("v1", "cursor-acp"),
      boundaryMode: "v1",
      autoFallbackToLegacy: false,
    });

    expect(result.terminate).toBeDefined();
    expect(result.terminate?.reason).toBe("loop_guard");
    expect(result.terminate?.errorClass).toBe("success");
    expect((result.terminate as any)?.silent).toBe(true);
  });

  it("soft-blocks in legacy path on first loop guard trigger", async () => {
    const guard = createToolLoopGuard(
      [{ role: "tool", tool_call_id: "c1", content: "invalid arguments" }],
      1,
    );
    // "task" is now an EXPLORATION_TOOL: effectiveMaxRepeat = 1 * 5 = 5.
    // Five pre-evaluations: count=5. Runtime call = count=6 = effectiveMaxRepeat+1 → soft block.
    for (let i = 0; i < 5; i++) {
      guard.evaluate({
        id: "c1",
        type: "function",
        function: { name: "task", arguments: '{"prompt":"analyze"}' },
      });
    }

    const toolResults: any[] = [];
    const result = await handleToolLoopEventLegacy(
      createBaseOptions({
        event: {
          type: "tool_call",
          call_id: "c2",
          tool_call: {
            taskToolCall: {
              args: { prompt: "analyze" },
            },
          },
        } as any,
        allowedToolNames: new Set(["task"]),
        toolSchemaMap: new Map(),
        toolLoopGuard: guard,
        onToolResult: async (toolResult) => {
          toolResults.push(toolResult);
        },
      }),
    );

    expect(result.terminate).toBeUndefined();
    expect(result.intercepted).toBe(false);
    expect(result.skipConverter).toBe(true);
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]?.choices?.[0]?.delta?.content).toContain("task");
  });

  it("soft block passes through fallback handler without triggering legacy fallback", async () => {
    let fallbackCalled = false;
    const guard = createToolLoopGuard(
      [{ role: "tool", tool_call_id: "c1", content: "invalid arguments" }],
      1,
    );
    // "task" is now an EXPLORATION_TOOL: effectiveMaxRepeat = 1 * 5 = 5.
    // Five pre-evaluations: count=5. Runtime call = count=6 = effectiveMaxRepeat+1 → soft block.
    for (let i = 0; i < 5; i++) {
      guard.evaluate({
        id: "c1",
        type: "function",
        function: { name: "task", arguments: '{"prompt":"analyze"}' },
      });
    }

    const toolResults: any[] = [];
    const result = await handleToolLoopEventWithFallback({
      ...createBaseOptions({
        event: {
          type: "tool_call",
          call_id: "c2",
          tool_call: {
            taskToolCall: {
              args: { prompt: "analyze" },
            },
          },
        } as any,
        allowedToolNames: new Set(["task"]),
        toolSchemaMap: new Map(),
        toolLoopGuard: guard,
        onToolResult: async (toolResult) => {
          toolResults.push(toolResult);
        },
      }),
      boundary: createProviderBoundary("v1", "cursor-acp"),
      boundaryMode: "v1",
      autoFallbackToLegacy: true,
      onFallbackToLegacy: () => {
        fallbackCalled = true;
      },
    });

    expect(fallbackCalled).toBe(false);
    expect(result.terminate).toBeUndefined();
    expect(result.intercepted).toBe(false);
    expect(toolResults).toHaveLength(1);
  });
});
