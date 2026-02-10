import { describe, expect, it } from "bun:test";
import {
  createToolLoopGuard,
  parseToolLoopMaxRepeat,
} from "../../src/provider/tool-loop-guard";

describe("tool loop guard", () => {
  it("parses max repeat env with default fallback", () => {
    expect(parseToolLoopMaxRepeat(undefined)).toEqual({ value: 3, valid: true });
    expect(parseToolLoopMaxRepeat("4")).toEqual({ value: 4, valid: true });
    expect(parseToolLoopMaxRepeat("0")).toEqual({ value: 3, valid: false });
    expect(parseToolLoopMaxRepeat("abc")).toEqual({ value: 3, valid: false });
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

  it("does not track successful tool results", () => {
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

    const decision = guard.evaluate({
      id: "c1",
      type: "function",
      function: {
        name: "read",
        arguments: JSON.stringify({ path: "foo.txt" }),
      },
    });

    expect(decision.tracked).toBe(false);
    expect(decision.triggered).toBe(false);
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
});
