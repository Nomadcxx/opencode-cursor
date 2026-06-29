import { describe, expect, it } from "bun:test";
import type { OpenAiToolCall } from "../../src/proxy/tool-loop";
import {
  applyToolSchemaCompat,
  buildToolSchemaMap,
  isFullFileShapedEditValidationFailure,
  tryRerouteEditToWrite,
} from "../../src/provider/tool-schema-compat";

function buildEditWriteSchemaMap(writeUsesFilePath = false): Map<string, unknown> {
  return new Map([
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
      writeUsesFilePath
        ? {
            type: "object",
            properties: {
              filePath: { type: "string" },
              content: { type: "string" },
            },
            required: ["filePath", "content"],
          }
        : {
            type: "object",
            properties: {
              path: { type: "string" },
              content: { type: "string" },
            },
            required: ["path", "content"],
          },
    ],
  ]);
}

function buildOpencodeEditWriteSchemaMap(): Map<string, unknown> {
  return new Map([
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
}

function buildQuestionSchemaMap(): Map<string, unknown> {
  return new Map([
    [
      "question",
      {
        type: "object",
        properties: {
          questions: {
            type: "array",
            items: {
              type: "object",
              properties: {
                question: { type: "string" },
                header: { type: "string" },
                multiple: { type: "boolean" },
                custom: { type: "boolean" },
                options: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      label: { type: "string" },
                      description: { type: "string" },
                    },
                    required: ["label", "description"],
                  },
                },
              },
              required: ["question", "header", "options"],
            },
          },
        },
        required: ["questions"],
        additionalProperties: false,
      },
    ],
  ]);
}

function editToolCall(args: Record<string, unknown>, id = "c_edit"): OpenAiToolCall {
  return {
    id,
    type: "function",
    function: {
      name: "edit",
      arguments: JSON.stringify(args),
    },
  };
}

describe("tool schema compatibility", () => {
  it("normalizes common argument aliases to canonical keys", () => {
    const result = applyToolSchemaCompat(
      {
        id: "c1",
        type: "function",
        function: {
          name: "write",
          arguments: JSON.stringify({
            filePath: "/tmp/a.txt",
            contents: "hello",
          }),
        },
      },
      new Map([
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
    );

    expect(result.normalizedArgs.path).toBe("/tmp/a.txt");
    expect(result.normalizedArgs.content).toBe("hello");
    expect(result.normalizedArgs.filePath).toBeUndefined();
    expect(result.normalizedArgs.contents).toBeUndefined();
    expect(result.validation.ok).toBe(true);
  });

  it("normalizes write path to filePath when schema requires filePath", () => {
    const result = applyToolSchemaCompat(
      {
        id: "c1",
        type: "function",
        function: {
          name: "write",
          arguments: JSON.stringify({
            path: "/tmp/a.txt",
            content: "hello",
          }),
        },
      },
      new Map([
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
      ]),
    );

    expect(result.normalizedArgs.filePath).toBe("/tmp/a.txt");
    expect(result.normalizedArgs.content).toBe("hello");
    expect(result.normalizedArgs.path).toBeUndefined();
    expect(result.validation.ok).toBe(true);
  });

  it("normalizes filename alias to path", () => {
    const result = applyToolSchemaCompat(
      {
        id: "c1",
        type: "function",
        function: {
          name: "write",
          arguments: JSON.stringify({
            filename: "/tmp/b.txt",
            content: "hello",
          }),
        },
      },
      new Map([
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
    );

    expect(result.normalizedArgs.path).toBe("/tmp/b.txt");
    expect(result.normalizedArgs.filename).toBeUndefined();
    expect(result.validation.ok).toBe(true);
  });

  it("normalizes glob aliases targetDirectory/globPattern", () => {
    const result = applyToolSchemaCompat(
      {
        id: "g1",
        type: "function",
        function: {
          name: "glob",
          arguments: JSON.stringify({
            targetDirectory: "TOOL_SMOKE_DIR",
            globPattern: "**/*.txt",
          }),
        },
      },
      new Map([
        [
          "glob",
          {
            type: "object",
            properties: {
              path: { type: "string" },
              pattern: { type: "string" },
            },
            required: ["pattern"],
            additionalProperties: false,
          },
        ],
      ]),
    );

    expect(result.normalizedArgs.path).toBe("TOOL_SMOKE_DIR");
    expect(result.normalizedArgs.pattern).toBe("**/*.txt");
    expect(result.normalizedArgs.targetDirectory).toBeUndefined();
    expect(result.normalizedArgs.globPattern).toBeUndefined();
    expect(result.validation.ok).toBe(true);
  });

  it("normalizes grep aliases searchPattern/includePattern", () => {
    const result = applyToolSchemaCompat(
      {
        id: "g2",
        type: "function",
        function: {
          name: "grep",
          arguments: JSON.stringify({
            searchPattern: "beta",
            filePath: "TOOL_SMOKE_DIR/src/grep.txt",
            includePattern: "*.txt",
          }),
        },
      },
      new Map([
        [
          "grep",
          {
            type: "object",
            properties: {
              pattern: { type: "string" },
              path: { type: "string" },
              include: { type: "string" },
            },
            required: ["pattern", "path"],
            additionalProperties: false,
          },
        ],
      ]),
    );

    expect(result.normalizedArgs.pattern).toBe("beta");
    expect(result.normalizedArgs.path).toBe("TOOL_SMOKE_DIR/src/grep.txt");
    expect(result.normalizedArgs.include).toBe("*.txt");
    expect(result.normalizedArgs.searchPattern).toBeUndefined();
    expect(result.validation.ok).toBe(true);
  });

  it("normalizes bash aliases command/cwd", () => {
    const result = applyToolSchemaCompat(
      {
        id: "b1",
        type: "function",
        function: {
          name: "bash",
          arguments: JSON.stringify({
            cmd: "pwd",
            workdir: "/tmp",
          }),
        },
      },
      new Map([
        [
          "bash",
          {
            type: "object",
            properties: {
              command: { type: "string" },
              cwd: { type: "string" },
            },
            required: ["command"],
            additionalProperties: false,
          },
        ],
      ]),
    );

    expect(result.normalizedArgs.command).toBe("pwd");
    expect(result.normalizedArgs.cwd).toBe("/tmp");
    expect(result.normalizedArgs.cmd).toBeUndefined();
    expect(result.normalizedArgs.workdir).toBeUndefined();
    expect(result.validation.ok).toBe(true);
  });

  it("normalizes rm recursive string alias into boolean force", () => {
    const result = applyToolSchemaCompat(
      {
        id: "r1",
        type: "function",
        function: {
          name: "rm",
          arguments: JSON.stringify({
            targetPath: "/tmp/to-delete",
            recursive: "true",
          }),
        },
      },
      new Map([
        [
          "rm",
          {
            type: "object",
            properties: {
              path: { type: "string" },
              force: { type: "boolean" },
            },
            required: ["path"],
            additionalProperties: false,
          },
        ],
      ]),
    );

    expect(result.normalizedArgs.path).toBe("/tmp/to-delete");
    expect(result.normalizedArgs.force).toBe(true);
    expect(result.validation.ok).toBe(true);
  });

  it("keeps canonical keys when aliases collide", () => {
    const result = applyToolSchemaCompat(
      {
        id: "c1",
        type: "function",
        function: {
          name: "read",
          arguments: JSON.stringify({
            path: "/canonical.txt",
            filePath: "/alias.txt",
          }),
        },
      },
      new Map(),
    );

    expect(result.normalizedArgs.path).toBe("/canonical.txt");
    expect(result.normalizedArgs.filePath).toBeUndefined();
    expect(result.collisionKeys).toContain("filePath");
  });

  it("normalizes todowrite statuses and default priority", () => {
    const result = applyToolSchemaCompat(
      {
        id: "c1",
        type: "function",
        function: {
          name: "todowrite",
          arguments: JSON.stringify({
            todos: [
              { content: "Book flights", status: "todo" },
              { content: "Reserve hotel", status: "in-progress", priority: "high" },
              { content: "Buy adapter", status: "done" },
              { content: "Pack", status: "TODO_STATUS_IN_PROGRESS" },
              { content: "Land", status: "TODO_STATUS_COMPLETED" },
            ],
          }),
        },
      },
      new Map(),
    );

    const todos = result.normalizedArgs.todos as Array<any>;
    expect(todos[0].status).toBe("pending");
    expect(todos[0].priority).toBe("medium");
    expect(todos[1].status).toBe("in_progress");
    expect(todos[1].priority).toBe("high");
    expect(todos[2].status).toBe("completed");
    expect(todos[2].priority).toBe("medium");
    expect(todos[3].status).toBe("in_progress");
    expect(todos[3].priority).toBe("medium");
    expect(todos[4].status).toBe("completed");
    expect(todos[4].priority).toBe("medium");
  });

  it("regression: does not synthesize old_string for path+content edit", () => {
    const result = applyToolSchemaCompat(
      {
        id: "c1",
        type: "function",
        function: {
          name: "edit",
          arguments: JSON.stringify({
            path: "/tmp/todo.md",
            content: "new full content",
          }),
        },
      },
      new Map([
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
    );

    const args = JSON.parse(result.toolCall.function.arguments);
    expect(args.path).toBe("/tmp/todo.md");
    expect(args.old_string).toBeUndefined();
    expect(args.new_string).toBe("new full content");
    expect(args.content).toBeUndefined();
    expect(result.validation.ok).toBe(false);
    expect(result.validation.missing).toEqual(["old_string"]);
    expect(result.validation.repairHint).toContain("write");
  });

  it("repairs edit content into new_string even when path is missing", () => {
    const result = applyToolSchemaCompat(
      {
        id: "c_missing_path",
        type: "function",
        function: {
          name: "edit",
          arguments: JSON.stringify({
            content: "new full content",
          }),
        },
      },
      new Map([
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
    );

    const args = JSON.parse(result.toolCall.function.arguments);
    expect(args.new_string).toBe("new full content");
    expect(args.old_string).toBeUndefined();
    expect(result.validation.ok).toBe(false);
    expect(result.validation.missing).toEqual(["path", "old_string"]);
  });

  it("strips unsupported fields when schema disallows additional properties", () => {
    const result = applyToolSchemaCompat(
      {
        id: "c1",
        type: "function",
        function: {
          name: "todowrite",
          arguments: JSON.stringify({
            todos: [{ content: "Book flights", status: "pending" }],
            merge: true,
          }),
        },
      },
      new Map([
        [
          "todowrite",
          {
            type: "object",
            properties: {
              todos: { type: "array" },
            },
            required: ["todos"],
            additionalProperties: false,
          },
        ],
      ]),
    );

    const args = JSON.parse(result.toolCall.function.arguments);
    expect(args.todos).toBeDefined();
    expect(args.merge).toBeUndefined();
    expect(result.validation.ok).toBe(true);
    expect(result.validation.unexpected).toEqual(["merge"]);
  });

  it("repairs edit streamContent aliases into new_string", () => {
    const result = applyToolSchemaCompat(
      {
        id: "c2",
        type: "function",
        function: {
          name: "edit",
          arguments: JSON.stringify({
            path: "TODO.md",
            streamContent: "updated body",
          }),
        },
      },
      new Map([
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
    );

    const args = JSON.parse(result.toolCall.function.arguments);
    expect(args.path).toBe("TODO.md");
    expect(args.old_string).toBeUndefined();
    expect(args.new_string).toBe("updated body");
    expect(result.validation.ok).toBe(false);
    expect(result.validation.missing).toEqual(["old_string"]);
    expect(result.validation.repairHint).toContain("write");
  });

  it("coerces array streamContent chunks into edit new_string", () => {
    const result = applyToolSchemaCompat(
      {
        id: "c3",
        type: "function",
        function: {
          name: "edit",
          arguments: JSON.stringify({
            path: "TODO.md",
            streamContent: ["# Travel Plan\n", "- Flight\n", "- Hotel\n"],
          }),
        },
      },
      new Map([
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
    );

    const args = JSON.parse(result.toolCall.function.arguments);
    expect(args.path).toBe("TODO.md");
    expect(args.old_string).toBeUndefined();
    expect(args.new_string).toBe("# Travel Plan\n- Flight\n- Hotel\n");
    expect(args.streamContent).toBeUndefined();
    expect(args.content).toBeUndefined();
    expect(result.validation.ok).toBe(false);
    expect(result.validation.missing).toEqual(["old_string"]);
  });

  it("coerces object-wrapped content into edit new_string", () => {
    const result = applyToolSchemaCompat(
      {
        id: "c4",
        type: "function",
        function: {
          name: "edit",
          arguments: JSON.stringify({
            path: "SIMPLE_TEST.md",
            streamContent: { text: "ok", type: "full" },
          }),
        },
      },
      new Map([
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
    );

    const args = JSON.parse(result.toolCall.function.arguments);
    expect(args.path).toBe("SIMPLE_TEST.md");
    expect(args.old_string).toBeUndefined();
    expect(typeof args.new_string).toBe("string");
    expect(args.new_string.length).toBeGreaterThan(0);
    expect(result.validation.ok).toBe(false);
    expect(result.validation.missing).toEqual(["old_string"]);
  });

  it("coerces nested array of {text} chunk objects into edit new_string", () => {
    const result = applyToolSchemaCompat(
      {
        id: "c5",
        type: "function",
        function: {
          name: "edit",
          arguments: JSON.stringify({
            path: "TODO.md",
            streamContent: [
              { text: "# Plan\n" },
              { text: "- Step 1\n" },
              { text: "- Step 2\n" },
            ],
          }),
        },
      },
      new Map([
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
    );

    const args = JSON.parse(result.toolCall.function.arguments);
    expect(args.path).toBe("TODO.md");
    expect(args.old_string).toBeUndefined();
    expect(args.new_string).toBe("# Plan\n- Step 1\n- Step 2\n");
    expect(result.validation.ok).toBe(false);
    expect(result.validation.missing).toEqual(["old_string"]);
  });

  it("rejects explicit empty edit old_string instead of preserving a full-file replacement", () => {
    const result = applyToolSchemaCompat(
      {
        id: "c_empty_old",
        type: "function",
        function: {
          name: "edit",
          arguments: JSON.stringify({
            path: "TODO.md",
            old_string: "",
            new_string: "-- test\nreturn {",
          }),
        },
      },
      new Map([
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
    );

    const args = JSON.parse(result.toolCall.function.arguments);
    expect(args.path).toBe("TODO.md");
    expect(args.old_string).toBeUndefined();
    expect(args.new_string).toBe("-- test\nreturn {");
    expect(result.validation.ok).toBe(false);
    expect(result.validation.missing).toEqual(["old_string"]);
  });

  it("regression: does not synthesize old_string for path+new_string only", () => {
    const result = applyToolSchemaCompat(
      {
        id: "c_path_new_only",
        type: "function",
        function: {
          name: "edit",
          arguments: JSON.stringify({
            path: "/tmp/out.txt",
            new_string: "entire body",
          }),
        },
      },
      new Map([
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
    );

    const args = JSON.parse(result.toolCall.function.arguments);
    expect(args.path).toBe("/tmp/out.txt");
    expect(args.old_string).toBeUndefined();
    expect(args.new_string).toBe("entire body");
    expect(result.validation.ok).toBe(false);
    expect(result.validation.missing).toEqual(["old_string"]);
    expect(result.validation.repairHint).toContain("write");
  });

  describe("edit to write reroute", () => {
    it("full-file hint uses filePath when write schema requires filePath", () => {
      const toolSchemaMap = buildEditWriteSchemaMap(true);
      const result = applyToolSchemaCompat(
        editToolCall({ path: "/tmp/out.txt", content: "entire body" }, "c_file_path_write_hint"),
        toolSchemaMap,
      );

      expect(result.validation.ok).toBe(false);
      expect(result.validation.repairHint).toContain("filePath");
      expect(result.validation.repairHint).toContain("write");
    });

    it("tryRerouteEditToWrite converts path+content edit to write", () => {
      const toolSchemaMap = buildEditWriteSchemaMap(false);
      const call = editToolCall({ path: "/tmp/x", content: "body" }, "c_reroute");
      const compat = applyToolSchemaCompat(call, toolSchemaMap);
      const rerouted = tryRerouteEditToWrite(
        call,
        compat,
        new Set(["edit", "write"]),
        toolSchemaMap,
      );
      expect(rerouted?.function.name).toBe("write");
      const args = JSON.parse(rerouted?.function.arguments ?? "{}");
      expect(args.path).toBe("/tmp/x");
      expect(args.content).toBe("body");
    });

    it("tryRerouteEditToWrite uses filePath when write schema requires filePath", () => {
      const toolSchemaMap = buildEditWriteSchemaMap(true);
      const call = editToolCall({ path: "/tmp/x", content: "body" });
      const compat = applyToolSchemaCompat(call, toolSchemaMap);
      const rerouted = tryRerouteEditToWrite(
        call,
        compat,
        new Set(["edit", "write"]),
        toolSchemaMap,
      );
      expect(rerouted?.function.name).toBe("write");
      const args = JSON.parse(rerouted?.function.arguments ?? "{}");
      expect(args.filePath).toBe("/tmp/x");
      expect(args.content).toBe("body");
      expect(args.path).toBeUndefined();
    });

    it("tryRerouteEditToWrite defaults to filePath when write schema is absent", () => {
      const toolSchemaMap = new Map([
        [
          "edit",
          {
            type: "object",
            properties: {
              filePath: { type: "string" },
              oldString: { type: "string" },
              newString: { type: "string" },
            },
            required: ["filePath", "oldString", "newString"],
          },
        ],
      ]);
      const call = editToolCall({ path: "/tmp/x", content: "body" });
      const compat = applyToolSchemaCompat(call, toolSchemaMap);
      const rerouted = tryRerouteEditToWrite(
        call,
        compat,
        new Set(["edit", "write"]),
        toolSchemaMap,
      );

      expect(rerouted?.function.name).toBe("write");
      const args = JSON.parse(rerouted?.function.arguments ?? "{}");
      expect(args.filePath).toBe("/tmp/x");
      expect(args.content).toBe("body");
      expect(args.path).toBeUndefined();
    });

    it("tryRerouteEditToWrite handles full-file edits when edit schema is absent", () => {
      const toolSchemaMap = new Map<string, unknown>();
      const call = editToolCall({ path: "/tmp/x", content: "body" });
      const compat = applyToolSchemaCompat(call, toolSchemaMap);
      const rerouted = tryRerouteEditToWrite(
        call,
        compat,
        new Set(["edit", "write"]),
        toolSchemaMap,
      );

      expect(rerouted?.function.name).toBe("write");
      const args = JSON.parse(rerouted?.function.arguments ?? "{}");
      expect(args.filePath).toBe("/tmp/x");
      expect(args.content).toBe("body");
      expect(args.path).toBeUndefined();
    });

    it("tryRerouteEditToWrite handles opencode path plus streamContent edit payloads", () => {
      const toolSchemaMap = buildOpencodeEditWriteSchemaMap();
      const call = editToolCall({
        path: "/tmp/x",
        streamContent: "49\ntest\n51",
      });
      const compat = applyToolSchemaCompat(call, toolSchemaMap);
      const rerouted = tryRerouteEditToWrite(
        call,
        compat,
        new Set(["edit", "write"]),
        toolSchemaMap,
      );

      expect(compat.validation.missing).toEqual(["oldString"]);
      expect(rerouted?.function.name).toBe("write");
      const args = JSON.parse(rerouted?.function.arguments ?? "{}");
      expect(args.filePath).toBe("/tmp/x");
      expect(args.content).toBe("49\ntest\n51");
      expect(args.path).toBeUndefined();
    });

    it("tryRerouteEditToWrite uses oc_write when fallback tools are active", () => {
      const toolSchemaMap = new Map([
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
      const call: OpenAiToolCall = {
        id: "c_oc_edit",
        type: "function",
        function: {
          name: "oc_edit",
          arguments: JSON.stringify({ path: "/tmp/x", streamContent: "body" }),
        },
      };
      const compat = applyToolSchemaCompat(call, toolSchemaMap);
      const rerouted = tryRerouteEditToWrite(
        call,
        compat,
        new Set(["oc_edit", "oc_write"]),
        toolSchemaMap,
      );

      expect(rerouted?.function.name).toBe("oc_write");
      const args = JSON.parse(rerouted?.function.arguments ?? "{}");
      expect(args.path).toBe("/tmp/x");
      expect(args.content).toBe("body");
      expect(args.filePath).toBeUndefined();
    });

    it("tryRerouteEditToWrite returns null when write not in allowedToolNames", () => {
      const toolSchemaMap = buildEditWriteSchemaMap(false);
      const call = editToolCall({ path: "/tmp/x", content: "body" });
      const compat = applyToolSchemaCompat(call, toolSchemaMap);
      const rerouted = tryRerouteEditToWrite(call, compat, new Set(["edit"]), toolSchemaMap);
      expect(rerouted).toBeNull();
      expect(compat.validation.ok).toBe(false);
    });

    it("tryRerouteEditToWrite still reroutes when write is allowed but missing from schema map", () => {
      const editOnlyMap = new Map([
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
          },
        ],
      ]);
      const call = editToolCall({ path: "/tmp/x", content: "body" });
      const compat = applyToolSchemaCompat(call, editOnlyMap);
      const rerouted = tryRerouteEditToWrite(
        call,
        compat,
        new Set(["edit", "write"]),
        editOnlyMap,
      );
      expect(rerouted?.function.name).toBe("write");
      const args = JSON.parse(rerouted?.function.arguments ?? "{}");
      expect(args.filePath).toBe("/tmp/x");
      expect(args.content).toBe("body");
    });

    it("tryRerouteEditToWrite returns null for explicit old_string empty", () => {
      const toolSchemaMap = buildEditWriteSchemaMap(false);
      const call = editToolCall({
        path: "TODO.md",
        old_string: "",
        new_string: "replacement",
      });
      const compat = applyToolSchemaCompat(call, toolSchemaMap);
      const rerouted = tryRerouteEditToWrite(
        call,
        compat,
        new Set(["edit", "write"]),
        toolSchemaMap,
      );
      expect(rerouted).toBeNull();
      expect(compat.validation.missing).toEqual(["old_string"]);
    });

    it("tryRerouteEditToWrite returns null when path missing", () => {
      const toolSchemaMap = buildEditWriteSchemaMap(false);
      const call = editToolCall({ content: "body only" });
      const compat = applyToolSchemaCompat(call, toolSchemaMap);
      const rerouted = tryRerouteEditToWrite(
        call,
        compat,
        new Set(["edit", "write"]),
        toolSchemaMap,
      );
      expect(rerouted).toBeNull();
    });

    it("tryRerouteEditToWrite reroutes after streamContent repair", () => {
      const toolSchemaMap = buildEditWriteSchemaMap(false);
      const call = editToolCall({ path: "TODO.md", streamContent: "updated body" });
      const compat = applyToolSchemaCompat(call, toolSchemaMap);
      const rerouted = tryRerouteEditToWrite(
        call,
        compat,
        new Set(["edit", "write"]),
        toolSchemaMap,
      );
      expect(rerouted?.function.name).toBe("write");
      const args = JSON.parse(rerouted?.function.arguments ?? "{}");
      expect(args.path).toBe("TODO.md");
      expect(args.content).toBe("updated body");
    });

    it("isFullFileShapedEditValidationFailure true only for full-file shape", () => {
      const toolSchemaMap = buildEditWriteSchemaMap(false);
      const fullFileCall = editToolCall({ path: "/tmp/x", content: "body" });
      const fullFileCompat = applyToolSchemaCompat(fullFileCall, toolSchemaMap);
      expect(
        isFullFileShapedEditValidationFailure(
          "edit",
          fullFileCompat.normalizedArgs,
          fullFileCompat.validation,
          fullFileCompat.originalArgs,
          toolSchemaMap.get("write"),
        ),
      ).toBe(true);

      const missingPathCall = editToolCall({ content: "body only" });
      const missingPathCompat = applyToolSchemaCompat(missingPathCall, toolSchemaMap);
      expect(
        isFullFileShapedEditValidationFailure(
          "edit",
          missingPathCompat.normalizedArgs,
          missingPathCompat.validation,
          missingPathCompat.originalArgs,
          toolSchemaMap.get("write"),
        ),
      ).toBe(false);
    });
  });

  it("preserves valid edit calls with explicit old/new strings", () => {
    const result = applyToolSchemaCompat(
      {
        id: "c6",
        type: "function",
        function: {
          name: "edit",
          arguments: JSON.stringify({
            path: "file.ts",
            old_string: "foo",
            new_string: "bar",
          }),
        },
      },
      new Map([
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
    );

    const args = JSON.parse(result.toolCall.function.arguments);
    expect(args.path).toBe("file.ts");
    expect(args.old_string).toBe("foo");
    expect(args.new_string).toBe("bar");
    expect(result.validation.ok).toBe(true);
  });

  it("builds schema map from request tools", () => {
    const map = buildToolSchemaMap([
      {
        type: "function",
        function: {
          name: "read",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        },
      },
      {
        name: "todowrite",
        parameters: {
          type: "object",
          properties: { todos: { type: "array" } },
          required: ["todos"],
        },
      },
    ]);

    expect(map.has("read")).toBe(true);
    expect(map.has("todowrite")).toBe(true);
  });

  it("coerces non-string write content into a string", () => {
    const result = applyToolSchemaCompat(
      {
        id: "w1",
        type: "function",
        function: {
          name: "write",
          arguments: JSON.stringify({
            path: "/tmp/a.txt",
            content: [{ text: "hello" }, { text: " world" }],
          }),
        },
      },
      new Map([
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
    );

    const args = JSON.parse(result.toolCall.function.arguments);
    expect(args.path).toBe("/tmp/a.txt");
    expect(args.content).toBe("hello world");
    expect(result.validation.ok).toBe(true);
  });

  it("repairs write new_string into content", () => {
    const result = applyToolSchemaCompat(
      {
        id: "w2",
        type: "function",
        function: {
          name: "write",
          arguments: JSON.stringify({
            path: "/tmp/b.txt",
            new_string: "hello",
          }),
        },
      },
      new Map([
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
    );

    const args = JSON.parse(result.toolCall.function.arguments);
    expect(args.path).toBe("/tmp/b.txt");
    expect(args.content).toBe("hello");
    expect(args.new_string).toBeUndefined();
    expect(result.validation.ok).toBe(true);
  });

  it("preserves OpenCode edit keys when schema is absent", () => {
    const result = applyToolSchemaCompat(
      editToolCall({
        filePath: "/tmp/native.txt",
        oldString: "before",
        newString: "after",
      }),
      new Map(),
    );

    expect(result.normalizedArgs.filePath).toBe("/tmp/native.txt");
    expect(result.normalizedArgs.oldString).toBe("before");
    expect(result.normalizedArgs.newString).toBe("after");
    expect(result.normalizedArgs.path).toBeUndefined();
    expect(result.normalizedArgs.old_string).toBeUndefined();
    expect(result.normalizedArgs.new_string).toBeUndefined();
    expect(result.validation.ok).toBe(true);
  });

  it("maps a Cursor AskQuestion payload onto the OpenCode question schema", () => {
    const longOption = "Apply the recommended fix and rerun the test suite";
    const result = applyToolSchemaCompat(
      {
        id: "q1",
        type: "function",
        function: {
          name: "question",
          arguments: JSON.stringify({
            title: "How should we proceed with the migration?",
            questions: [
              {
                id: "step",
                prompt: "Which approach do you want?",
                allow_multiple: true,
                options: [
                  { id: "a", label: longOption },
                  { id: "b", label: "Skip" },
                ],
              },
            ],
          }),
        },
      },
      buildQuestionSchemaMap(),
    );

    const args = JSON.parse(result.toolCall.function.arguments);
    expect(args.title).toBeUndefined();
    expect(args.questions).toHaveLength(1);

    const q = args.questions[0];
    expect(q.question).toBe("Which approach do you want?");
    expect(q.prompt).toBeUndefined();
    expect(q.id).toBeUndefined();
    expect(q.allow_multiple).toBeUndefined();
    expect(q.multiple).toBe(true);
    expect(q.header.length).toBeLessThanOrEqual(30);
    expect(q.header).toBe("How should we proceed with the".slice(0, 30));

    expect(q.options[0].label.length).toBeLessThanOrEqual(30);
    expect(q.options[0].description).toBe(longOption);
    expect(q.options[0].id).toBeUndefined();
    expect(q.options[1].label).toBe("Skip");
    expect(q.options[1].description).toBe("Skip");

    expect(result.validation.ok).toBe(true);
  });

  it("leaves an already OpenCode-shaped question payload valid", () => {
    const result = applyToolSchemaCompat(
      {
        id: "q2",
        type: "function",
        function: {
          name: "question",
          arguments: JSON.stringify({
            questions: [
              {
                question: "Pick one",
                header: "Pick",
                multiple: false,
                options: [{ label: "Yes", description: "Proceed now" }],
              },
            ],
          }),
        },
      },
      buildQuestionSchemaMap(),
    );

    const q = JSON.parse(result.toolCall.function.arguments).questions[0];
    expect(q.question).toBe("Pick one");
    expect(q.header).toBe("Pick");
    expect(q.options[0].label).toBe("Yes");
    expect(q.options[0].description).toBe("Proceed now");
    expect(result.validation.ok).toBe(true);
  });

  it("synthesizes a header from the question when none is provided", () => {
    const result = applyToolSchemaCompat(
      {
        id: "q3",
        type: "function",
        function: {
          name: "question",
          arguments: JSON.stringify({
            questions: [
              {
                prompt: "Do you want to continue with the deployment to production?",
                options: [{ label: "Confirm" }],
              },
            ],
          }),
        },
      },
      buildQuestionSchemaMap(),
    );

    const q = JSON.parse(result.toolCall.function.arguments).questions[0];
    expect(q.header.length).toBeLessThanOrEqual(30);
    expect(q.header.length).toBeGreaterThan(0);
    expect(result.validation.ok).toBe(true);
  });
});
