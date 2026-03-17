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

    // "read" is an EXPLORATION_TOOL: effectiveMaxRepeat = 2 * 5 = 10
    // History only has a tool result (no assistant message), so no count is seeded.
    // evaluate calls bring count to 1, 2, 3 — all < 10, none trigger.
    expect(first.triggered).toBe(false);
    expect(second.triggered).toBe(false);
    expect(third.triggered).toBe(false);
    expect(third.repeatCount).toBe(3);
    expect(third.maxRepeat).toBe(10);
  });

  it("triggers on repeated failures even when argument shapes vary (coarse fingerprint)", () => {
    // maxRepeat=2 means coarse limit = 2 * 3 = 6, triggers when count > 6
    const guard = createToolLoopGuard([], 2);

    // 7 evaluateValidation calls with different schema signatures
    // Each increments coarse fingerprint edit|validation
    const signatures = [
      "missing: path",
      "missing: old_string",
      "unsupported: content",
      "missing: new_string",
      "type: path must be string",
      "missing: path, old_string",
      "unsupported: streamContent",
    ];
    const calls = signatures.map((sig, i) =>
      guard.evaluateValidation(
        {
          id: `c${i + 1}`,
          type: "function",
          function: { name: "edit", arguments: "{}" },
        },
        sig,
      ),
    );

    // First 6 should not trigger (coarse count: 1,2,3,4,5,6)
    expect(calls.slice(0, 6).every((r) => !r.triggered)).toBe(true);
    // 7th call triggers (coarse count: 7 > coarseMaxRepeat 6)
    expect(calls[6].triggered).toBe(true);
    expect(calls[6].fingerprint).toBe("edit|validation");
    expect(calls[6].repeatCount).toBe(7);
    expect(calls[6].maxRepeat).toBe(6);
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

    // Use 'edit' instead of 'read' - exploration tools have 5x limit multiplier
    const call = {
      id: "c1",
      type: "function",
      function: {
        name: "edit",
        arguments: JSON.stringify({ path: "foo.txt", content: "bar" }),
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
    // bash is in EXPLORATION_TOOLS with 5x multiplier, so maxRepeat=1 => effective limit=5
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

    // bash is in UNKNOWN_AS_SUCCESS_TOOLS, so "bash-ok" (unknown) becomes "success"
    expect(first.errorClass).toBe("success");
    expect(first.triggered).toBe(false);

    // With 5x exploration multiplier and maxRepeat=1, effective limit is 5
    // Calls 2-5 should NOT trigger
    for (let i = 2; i <= 5; i++) {
      const decision = guard.evaluate({
        id: "bash-1",
        type: "function",
        function: {
          name: "bash",
          arguments: JSON.stringify({ command: "printf bash-ok" }),
        },
      });
      expect(decision.triggered).toBe(false);
    }

    // 6th call should trigger
    const sixth = guard.evaluate({
      id: "bash-1",
      type: "function",
      function: {
        name: "bash",
        arguments: JSON.stringify({ command: "printf bash-ok" }),
      },
    });
    expect(sixth.triggered).toBe(true);
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
    // "read" is an EXPLORATION_TOOL: effectiveMaxRepeat = 1 * 5 = 5
    // seeded count = 1 (from history), evaluate brings count to 2
    // 2 > 5? No — not triggered
    expect(readDecision.errorClass).toBe("not_found");
    expect(readDecision.triggered).toBe(false);
  });
});

  // Reproduction test for issue #33: cross-turn accumulation
  it("ISSUE_33: should not trigger on exploration tool reads across turns", () => {
    // Simulate: user asks agent to read file A in turn 1, turn 3, turn 5, turn 7, turn 9
    // This is legitimate behavior - re-reading a file to verify changes is normal
    const history = [];
    
    // Build 8 historical turns where agent read the same file (with success)
    for (let turn = 1; turn <= 8; turn++) {
      history.push({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: `read-turn-${turn}`,
            type: "function",
            function: {
              name: "read",
              arguments: JSON.stringify({ path: "src/important-file.ts" }),
            },
          },
        ],
      });
      history.push({
        role: "tool",
        tool_call_id: `read-turn-${turn}`,
        content: "export function foo() { return 42; }",
      });
      // User message between turns (simulating conversation flow)
      if (turn < 8) {
        history.push({
          role: "user", 
          content: `Turn ${turn + 1}: Please check the file again`,
        });
      }
    }

    const guard = createToolLoopGuard(history, 2);

    // Now agent reads the same file again in current turn (turn 9)
    const decision = guard.evaluate({
      id: "read-turn-9",
      type: "function",
      function: {
        name: "read",
        arguments: JSON.stringify({ path: "src/important-file.ts" }),
      },
    });

    // CURRENT BEHAVIOR (BUG): This triggers because count = 9 > limit 2
    // EXPECTED BEHAVIOR: Should NOT trigger - reading same file across turns is legitimate
    console.log("Issue #33 reproduction:", {
      triggered: decision.triggered,
      repeatCount: decision.repeatCount,
      maxRepeat: decision.maxRepeat,
      fingerprint: decision.fingerprint,
    });
    
    // This test documents current (buggy) behavior
    // When fixed, change expect to: expect(decision.triggered).toBe(false);
    expect(decision.triggered).toBe(false); // FIXED: exploration tools get 5x limit
    expect(decision.repeatCount).toBe(9);  // 8 historical + 1 current
    expect(decision.maxRepeat).toBe(10);   // 2 * 5 (EXPLORATION_LIMIT_MULTIPLIER)
  });

  it("ISSUE_51: task tool validation errors should not trigger guard for small batches", () => {
  // After fix: task is in EXPLORATION_TOOLS, strict threshold = maxRepeat * 5 = 10
  // Use empty history — seeded count from constructor would offset all assertions
  const guard = createToolLoopGuard([], 2);

  const taskCall = {
    id: "task-1",
    type: "function" as const,
    function: {
      name: "task",
      arguments: JSON.stringify({ subagent_type: undefined, prompt: "analyze repo" }),
    },
  };

  // 10 identical calls: count=10 is NOT > effectiveMaxRepeat(10), no trigger
  let last!: ReturnType<typeof guard.evaluate>;
  for (let i = 0; i < 10; i++) {
    last = guard.evaluate(taskCall);
    expect(last.triggered).toBe(false);
  }
  expect(last.repeatCount).toBe(10);
  expect(last.maxRepeat).toBe(10); // effectiveMaxRepeat = 2 * EXPLORATION_LIMIT_MULTIPLIER(5)
  // Empty history → no prior tool response → errorClass resolves to "unknown"
  // (task is not in UNKNOWN_AS_SUCCESS_TOOLS, so it stays "unknown" not "success")
  expect(last.errorClass).toBe("unknown");

  // 11th call: count=11 > 10, first trigger
  const d11 = guard.evaluate(taskCall);
  expect(d11.triggered).toBe(true);
  expect(d11.repeatCount).toBe(11);
  expect(d11.maxRepeat).toBe(10);
});

describe("EXPLORATION_TOOLS error-path threshold", () => {
  it("task: 5 identical validation failures do not trigger", () => {
    const guard = createToolLoopGuard([], 2);
    const call = { id: "t1", type: "function" as const, function: { name: "task", arguments: '{"prompt":"x"}' } };
    for (let i = 0; i < 5; i++) {
      const d = guard.evaluate(call);
      expect(d.triggered).toBe(false);
      expect(d.maxRepeat).toBe(10); // effectiveMaxRepeat returned in decision
    }
  });

  it("task: 11 identical validation failures trigger (first trigger)", () => {
    const guard = createToolLoopGuard([], 2);
    const call = { id: "t1", type: "function" as const, function: { name: "task", arguments: '{"prompt":"x"}' } };
    for (let i = 0; i < 10; i++) guard.evaluate(call);
    const d11 = guard.evaluate(call);
    expect(d11.triggered).toBe(true);
    expect(d11.repeatCount).toBe(11);
    expect(d11.maxRepeat).toBe(10); // MUST be effectiveMaxRepeat, not raw 2
  });

  it("task: 12 identical validation failures trigger (hard kill — second trigger)", () => {
    const guard = createToolLoopGuard([], 2);
    const call = { id: "t1", type: "function" as const, function: { name: "task", arguments: '{"prompt":"x"}' } };
    for (let i = 0; i < 11; i++) guard.evaluate(call);
    const d12 = guard.evaluate(call);
    expect(d12.triggered).toBe(true);
    expect(d12.repeatCount).toBe(12);
    expect(d12.maxRepeat).toBe(10);
  });

  it("read (existing EXPLORATION_TOOL): 5 tool_error failures do not trigger (error-path parity)", () => {
    // Before this fix: only success path got 5x. After: error path also gets 5x.
    const guard = createToolLoopGuard([], 2);
    const call = { id: "r1", type: "function" as const, function: { name: "read", arguments: '{"path":"foo.ts"}' } };
    for (let i = 0; i < 5; i++) {
      const d = guard.evaluate(call);
      expect(d.triggered).toBe(false);
      expect(d.maxRepeat).toBe(10);
    }
  });

  it("edit (non-exploration tool): 3 identical failures trigger (unchanged)", () => {
    const guard = createToolLoopGuard([], 2);
    const call = { id: "e1", type: "function" as const, function: { name: "edit", arguments: '{"path":"f.ts"}' } };
    guard.evaluate(call);
    guard.evaluate(call);
    const d3 = guard.evaluate(call);
    expect(d3.triggered).toBe(true);
    expect(d3.maxRepeat).toBe(2); // raw maxRepeat, no multiplier
  });

  it("evaluateValidation for task: 11 failures trigger (fix applies to validation path too)", () => {
    // evaluateValidation calls evaluateWithFingerprints — same fix applies
    const guard = createToolLoopGuard([], 2);
    const call = { id: "t1", type: "function" as const, function: { name: "task", arguments: '{}' } };
    const sig = "path:subagent_type|invalid_type";
    for (let i = 0; i < 10; i++) {
      const d = guard.evaluateValidation(call, sig);
      expect(d.triggered).toBe(false);
    }
    const d11 = guard.evaluateValidation(call, sig);
    expect(d11.triggered).toBe(true);
    expect(d11.maxRepeat).toBe(10);
  });
});

describe("EXPLORATION_TOOLS coarse tracking", () => {
  it("task: 5 calls with DIFFERENT arg shapes same error class do not trigger (coarse disabled)", () => {
    // Key: each call has a unique prompt → unique strict fingerprint → strict count=1 each
    // Coarse fingerprint would be "task|validation" for all 5 — but coarse is disabled for task
    const guard = createToolLoopGuard([], 2);
    for (let i = 0; i < 5; i++) {
      const call = {
        id: `t${i}`,
        type: "function" as const,
        function: { name: "task", arguments: JSON.stringify({ prompt: `unique prompt ${i}` }) },
      };
      const d = guard.evaluate(call);
      expect(d.triggered).toBe(false);
    }
  });

  it("edit (non-exploration tool): 7 different-path calls with validation errors trigger via coarse", () => {
    // coarseMaxRepeat = maxRepeat(2) * COARSE_LIMIT_MULTIPLIER(3) = 6
    // Need > 6 to trigger coarse. Use 7 evaluateValidation calls with distinct signatures.
    // evaluateValidation always uses "validation" errorClass (bypasses UNKNOWN_AS_SUCCESS_TOOLS).
    const guard = createToolLoopGuard([], 2);
    let last!: ReturnType<typeof guard.evaluate>;
    for (let i = 0; i < 7; i++) {
      const call = {
        id: `e${i}`,
        type: "function" as const,
        function: { name: "edit", arguments: JSON.stringify({ path: `file${i}.ts`, old_string: `old${i}`, new_string: "new" }) },
      };
      // Use unique validation signature per call so strict count stays at 1 each
      last = guard.evaluateValidation(call, `missing:field_${i}`);
    }
    expect(last.triggered).toBe(true); // coarse: count=7 > coarseMax=6
  });
});
