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

  it("keeps edit semantics and surfaces validation hints for missing fields", () => {
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
    expect(args.content).toBe("new full content");
    expect(result.validation.ok).toBe(false);
    expect(result.validation.missing).toEqual(["old_string", "new_string"]);
    expect(result.validation.repairHint).toContain("edit requires path, old_string, and new_string");
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
