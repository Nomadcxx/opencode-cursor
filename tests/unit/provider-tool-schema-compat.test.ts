import { describe, expect, it } from "bun:test";
import {
  applyToolSchemaCompat,
  buildToolSchemaMap,
} from "../../src/provider/tool-schema-compat";

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
  });

  it("repairs edit content payloads into old/new string arguments", () => {
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
    expect(args.old_string).toBe("");
    expect(args.new_string).toBe("new full content");
    expect(args.content).toBeUndefined();
    expect(result.validation.ok).toBe(true);
    expect(result.validation.missing).toEqual([]);
    expect(result.validation.typeErrors).toEqual([]);
  });

  it("repairs edit content into old/new even when path is missing", () => {
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
    expect(args.old_string).toBe("");
    expect(result.validation.ok).toBe(false);
    expect(result.validation.missing).toEqual(["path"]);
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
    expect(args.old_string).toBe("");
    expect(args.new_string).toBe("updated body");
    expect(result.validation.ok).toBe(true);
  });

  it("coerces array streamContent chunks into edit old/new strings", () => {
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
    expect(args.old_string).toBe("");
    expect(args.new_string).toBe("# Travel Plan\n- Flight\n- Hotel\n");
    expect(args.streamContent).toBeUndefined();
    expect(args.content).toBeUndefined();
    expect(result.validation.ok).toBe(true);
    expect(result.validation.missing).toEqual([]);
  });

  it("coerces object-wrapped content into edit old/new strings", () => {
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
    expect(args.old_string).toBe("");
    expect(typeof args.new_string).toBe("string");
    expect(args.new_string.length).toBeGreaterThan(0);
    expect(result.validation.ok).toBe(true);
  });

  it("coerces nested array of {text} chunk objects for edit", () => {
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
    expect(args.old_string).toBe("");
    expect(args.new_string).toBe("# Plan\n- Step 1\n- Step 2\n");
    expect(result.validation.ok).toBe(true);
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
});
