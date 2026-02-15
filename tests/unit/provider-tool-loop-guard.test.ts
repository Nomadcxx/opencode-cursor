import { describe, expect, it } from "bun:test";
import {
  createToolLoopGuard,
  parseToolLoopMaxRepeat,
} from "../../src/provider/tool-loop-guard";

describe("tool loop guard", () => {
  it("parses max repeat env with default fallback", () => {
    expect(parseToolLoopMaxRepeat(undefined)).toEqual({ value: 2, valid: true });
    expect(parseToolLoopMaxRepeat("4")).toEqual({ value: 4, valid: true });
    expect(parseToolLoopMaxRepeat("0")).toEqual({ value: 2, valid: false });
    expect(parseToolLoopMaxRepeat("abc")).toEqual({ value: 2, valid: false });
  });

  it("tracks repeated failures using fingerprint and triggers after threshold", () => {
    const guard = createToolLoopGuard(
      [
        {
          role: "tool",
          tool_call_id: "c1",
          content: "Invalid arguments: missing required field path",
        },
      ],
      2,
    );

    const call = {
      id: "c1",
      type: "function" as const,
      function: {
        name: "read",
        arguments: JSON.stringify({ path: "foo.txt" }),
      },
    };

    const first = guard.evaluate(call);
    const second = guard.evaluate(call);
    const third = guard.evaluate(call);

    expect(first.triggered).toBe(false);
    expect(second.triggered).toBe(false);
    expect(third.triggered).toBe(true);
    expect(third.repeatCount).toBe(3);
  });

  it("triggers on repeated failures even when argument shapes vary", () => {
    const guard = createToolLoopGuard(
      [
        {
          role: "tool",
          tool_call_id: "seed",
          content: "Invalid arguments: missing required field path",
        },
      ],
      2,
    );

    const first = guard.evaluate({
      id: "c2",
      type: "function",
      function: {
        name: "edit",
        arguments: JSON.stringify({ path: "TODO.md", content: "rewrite" }),
      },
    });
    const second = guard.evaluate({
      id: "c3",
      type: "function",
      function: {
        name: "edit",
        arguments: JSON.stringify({ path: "TODO.md", old_string: "A", new_string: "B" }),
      },
    });
    const third = guard.evaluate({
      id: "c4",
      type: "function",
      function: {
        name: "edit",
        arguments: JSON.stringify({ path: "TODO.md", streamContent: "rewrite again" }),
      },
    });

    expect(first.triggered).toBe(false);
    expect(second.triggered).toBe(false);
    expect(third.triggered).toBe(true);
    expect(third.fingerprint).toBe("edit|validation");
    expect(third.repeatCount).toBe(3);
  });

  it("tracks repeated identical successful tool calls and triggers after threshold", () => {
    const guard = createToolLoopGuard(
      [
        {
          role: "tool",
          tool_call_id: "c1",
          content: "{\"success\":true}",
        },
      ],
      2,
    );

    const call = {
      id: "c1",
      type: "function",
      function: {
        name: "read",
        arguments: JSON.stringify({ path: "foo.txt" }),
      },
    } as const;

    const first = guard.evaluate(call);
    const second = guard.evaluate(call);
    const third = guard.evaluate(call);

    expect(first.tracked).toBe(true);
    expect(first.triggered).toBe(false);
    expect(second.triggered).toBe(false);
    expect(third.triggered).toBe(true);
    expect(third.errorClass).toBe("success");
  });

  it("does not trigger success guard when successful args differ", () => {
    const guard = createToolLoopGuard(
      [
        {
          role: "tool",
          tool_call_id: "c1",
          content: "{\"success\":true}",
        },
      ],
      2,
    );

    const first = guard.evaluate({
      id: "c1",
      type: "function",
      function: {
        name: "read",
        arguments: JSON.stringify({ path: "foo.txt" }),
      },
    });
    const second = guard.evaluate({
      id: "c1",
      type: "function",
      function: {
        name: "read",
        arguments: JSON.stringify({ path: "bar.txt" }),
      },
    });
    const third = guard.evaluate({
      id: "c1",
      type: "function",
      function: {
        name: "read",
        arguments: JSON.stringify({ path: "baz.txt" }),
      },
    });

    expect(first.triggered).toBe(false);
    expect(second.triggered).toBe(false);
    expect(third.triggered).toBe(false);
  });

  it("treats todowrite markdown output as success for loop tracking", () => {
    const guard = createToolLoopGuard(
      [
        {
          role: "tool",
          tool_call_id: "todo1",
          content: "# Todos\n[ ] smoke",
        },
      ],
      1,
    );

    const first = guard.evaluate({
      id: "todo1",
      type: "function",
      function: {
        name: "todowrite",
        arguments: JSON.stringify({
          todos: [
            {
              id: "smoke",
              content: "smoke",
              status: "pending",
              priority: "medium",
            },
          ],
        }),
      },
    });
    const second = guard.evaluate({
      id: "todo1",
      type: "function",
      function: {
        name: "todowrite",
        arguments: JSON.stringify({
          todos: [
            {
              id: "smoke",
              content: "smoke",
              status: "pending",
              priority: "medium",
            },
          ],
        }),
      },
    });

    expect(first.errorClass).toBe("success");
    expect(first.triggered).toBe(false);
    expect(second.triggered).toBe(true);
  });

  it("treats unknown bash output as success for loop tracking", () => {
    const guard = createToolLoopGuard(
      [
        {
          role: "tool",
          tool_call_id: "bash-1",
          content: "bash-ok",
        },
      ],
      1,
    );

    const first = guard.evaluate({
      id: "bash-1",
      type: "function",
      function: {
        name: "bash",
        arguments: JSON.stringify({ command: "printf bash-ok" }),
      },
    });
    const second = guard.evaluate({
      id: "bash-1",
      type: "function",
      function: {
        name: "bash",
        arguments: JSON.stringify({ command: "printf bash-ok" }),
      },
    });

    expect(first.errorClass).toBe("success");
    expect(first.triggered).toBe(false);
    expect(second.triggered).toBe(true);
  });

  it("seeds success-loop history across requests for identical successful calls", () => {
    const guard = createToolLoopGuard(
      [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "prev-success",
              type: "function",
              function: {
                name: "edit",
                arguments: JSON.stringify({
                  path: "TODO.md",
                  old_string: "",
                  new_string: "ok",
                }),
              },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "prev-success",
          content: "File edited successfully: TODO.md",
        },
      ],
      1,
    );

    const decision = guard.evaluate({
      id: "next-success",
      type: "function",
      function: {
        name: "edit",
        arguments: JSON.stringify({
          path: "TODO.md",
          old_string: "",
          new_string: "ok",
        }),
      },
    });

    expect(decision.errorClass).toBe("success");
    expect(decision.triggered).toBe(true);
    expect(decision.repeatCount).toBe(2);
  });

  it("stops repeated successful full-replace edits even when new_string varies", () => {
    const guard = createToolLoopGuard(
      [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "prev-edit",
              type: "function",
              function: {
                name: "edit",
                arguments: JSON.stringify({
                  path: "TODO.md",
                  old_string: "",
                  new_string: "seed",
                }),
              },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "prev-edit",
          content: "File edited successfully: TODO.md",
        },
      ],
      3,
    );

    const d1 = guard.evaluate({
      id: "e1",
      type: "function",
      function: {
        name: "edit",
        arguments: JSON.stringify({ path: "TODO.md", old_string: "", new_string: "a" }),
      },
    });
    const d2 = guard.evaluate({
      id: "e2",
      type: "function",
      function: {
        name: "edit",
        arguments: JSON.stringify({ path: "TODO.md", old_string: "", new_string: "b" }),
      },
    });
    const d3 = guard.evaluate({
      id: "e3",
      type: "function",
      function: {
        name: "edit",
        arguments: JSON.stringify({ path: "TODO.md", old_string: "", new_string: "c" }),
      },
    });
    const d4 = guard.evaluate({
      id: "e4",
      type: "function",
      function: {
        name: "edit",
        arguments: JSON.stringify({ path: "TODO.md", old_string: "", new_string: "d" }),
      },
    });

    expect(d1.errorClass).toBe("success");
    expect(d1.triggered).toBe(false);
    expect(d2.triggered).toBe(false);
    expect(d3.triggered).toBe(true);
    expect(d4.triggered).toBe(true);
    expect(d4.fingerprint.includes("|path:")).toBe(true);
    expect(d4.fingerprint.endsWith("|success")).toBe(true);
  });

  it("resets fingerprint counts", () => {
    const guard = createToolLoopGuard(
      [
        {
          role: "tool",
          content: "invalid schema",
        },
      ],
      1,
    );

    const call = {
      id: "cx",
      type: "function" as const,
      function: {
        name: "edit",
        arguments: JSON.stringify({ path: "foo.txt", content: "bar" }),
      },
    };

    const first = guard.evaluate(call);
    const second = guard.evaluate(call);
    expect(second.triggered).toBe(true);

    guard.resetFingerprint(first.fingerprint);
    const third = guard.evaluate(call);
    expect(third.triggered).toBe(false);
  });

  it("tracks repeated schema-validation failures independent of tool result parsing", () => {
    const guard = createToolLoopGuard([], 2);
    const call = {
      id: "e1",
      type: "function" as const,
      function: {
        name: "edit",
        arguments: JSON.stringify({ path: "TODO.md", content: "rewrite" }),
      },
    };

    const first = guard.evaluateValidation(call, "missing:old_string,new_string");
    const second = guard.evaluateValidation(call, "missing:old_string,new_string");
    const third = guard.evaluateValidation(call, "missing:old_string,new_string");

    expect(first.triggered).toBe(false);
    expect(second.triggered).toBe(false);
    expect(third.triggered).toBe(true);
    expect(third.errorClass).toBe("validation");
  });

  it("seeds validation guard history for repeated malformed edit calls", () => {
    const guard = createToolLoopGuard(
      [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "prev-edit",
              type: "function",
              function: {
                name: "edit",
                arguments: "{\"path\":\"TODO.md\",\"content\":\"full rewrite\"}",
              },
            },
          ],
        },
      ],
      1,
    );

    const decision = guard.evaluateValidation(
      {
        id: "next-edit",
        type: "function",
        function: {
          name: "edit",
          arguments: "{\"path\":\"TODO.md\",\"content\":\"rewrite again\"}",
        },
      },
      "missing:old_string,new_string",
    );

    expect(decision.triggered).toBe(true);
    expect(decision.errorClass).toBe("validation");
  });

  it("classifies edit as success in multi-tool turn where context_info is unknown", () => {
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
                name: "edit",
                arguments: JSON.stringify({
                  path: "TODO.md",
                  old_string: "",
                  new_string: "ok",
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
          content: "Here is some context about the project.",
        },
      ],
      1,
    );

    const decision = guard.evaluate({
      id: "edit-2",
      type: "function",
      function: {
        name: "edit",
        arguments: JSON.stringify({
          path: "TODO.md",
          old_string: "",
          new_string: "ok",
        }),
      },
    });

    expect(decision.errorClass).toBe("success");
    expect(decision.triggered).toBe(true);
    expect(decision.repeatCount).toBe(2);
  });

  it("seeds per-tool-name errorClass independently in multi-tool history", () => {
    const guard = createToolLoopGuard(
      [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "edit-a",
              type: "function",
              function: {
                name: "edit",
                arguments: JSON.stringify({
                  path: "A.md",
                  old_string: "",
                  new_string: "a",
                }),
              },
            },
            {
              id: "read-a",
              type: "function",
              function: {
                name: "read",
                arguments: JSON.stringify({ path: "missing.txt" }),
              },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "edit-a",
          content: "File edited successfully: A.md",
        },
        {
          role: "tool",
          tool_call_id: "read-a",
          content: "Error: ENOENT: no such file or directory",
        },
      ],
      1,
    );

    const editDecision = guard.evaluate({
      id: "edit-b",
      type: "function",
      function: {
        name: "edit",
        arguments: JSON.stringify({
          path: "A.md",
          old_string: "",
          new_string: "a",
        }),
      },
    });
    expect(editDecision.errorClass).toBe("success");
    expect(editDecision.triggered).toBe(true);

    const readDecision = guard.evaluate({
      id: "read-b",
      type: "function",
      function: {
        name: "read",
        arguments: JSON.stringify({ path: "missing.txt" }),
      },
    });
    expect(readDecision.errorClass).toBe("not_found");
    expect(readDecision.triggered).toBe(true);
  });
});
