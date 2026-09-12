import { describe, expect, it } from "bun:test";
import {
  buildCursorNativeTaskRetryMessage,
  buildKiloSubagentSystemMessage,
  buildKiloTaskBridgeContext,
  extractKiloSubagentsFromTools,
  isCursorNativeTaskMisuse,
  parseKiloSubagentsFromTaskDescription,
  rewriteCursorNativeTaskMisuse,
} from "../../../src/proxy/kilo-subagents.js";

const TASK_TOOL = {
  type: "function",
  function: {
    name: "task",
    description: [
      "Launch an OpenCode subagent.",
      "- explore: Fast codebase exploration",
      "- adversarial: Red-team reviewer for risky changes",
      "- image-describer: Describes images for non-vision models",
    ].join("\n"),
    parameters: {
      type: "object",
      properties: {
        description: { type: "string" },
        prompt: { type: "string" },
        subagent_type: { type: "string" },
      },
      required: ["description", "prompt", "subagent_type"],
    },
  },
};

describe("proxy/kilo-subagents", () => {
  it("parses subagent roster lines from the task tool description", () => {
    expect(parseKiloSubagentsFromTaskDescription(TASK_TOOL.function.description)).toEqual([
      { name: "explore", description: "Fast codebase exploration" },
      { name: "adversarial", description: "Red-team reviewer for risky changes" },
      { name: "image-describer", description: "Describes images for non-vision models" },
    ]);
  });

  it("extracts subagents from the active tools array", () => {
    expect(extractKiloSubagentsFromTools([{ type: "function", function: { name: "read" } }, TASK_TOOL]))
      .toEqual([
        { name: "explore", description: "Fast codebase exploration" },
        { name: "adversarial", description: "Red-team reviewer for risky changes" },
        { name: "image-describer", description: "Describes images for non-vision models" },
      ]);
  });

  it("builds a Kilo subagent system message with delegation rules", () => {
    const message = buildKiloSubagentSystemMessage([
      { name: "adversarial", description: "Red-team reviewer" },
    ]);

    expect(message).toContain("Registered Kilo subagents:");
    expect(message).toContain("- adversarial: Red-team reviewer");
    expect(message).toContain("Never use subagentType");
    expect(message).toContain('{ custom: "name" }');
  });

  it("builds task bridge context with the Kilo roster and prohibitions", () => {
    const context = buildKiloTaskBridgeContext([
      { name: "adversarial", description: "Red-team reviewer" },
    ]);

    expect(context).toContain("Allowed Kilo subagent_type values:");
    expect(context).toContain("- adversarial: Red-team reviewer");
    expect(context).toContain("Never use subagentType");
    expect(context).toContain('{ custom: "name" }');
  });

  it("detects cursor native task misuse and rewrites to Kilo retry guidance", () => {
    const original = "Unknown agent type: custom";
    expect(isCursorNativeTaskMisuse(original)).toBe(true);

    const rewritten = rewriteCursorNativeTaskMisuse(original, [
      { name: "adversarial", description: "Red-team reviewer" },
    ]);

    expect(rewritten).toContain("cursor-kilo:");
    expect(rewritten).toContain("Kilo's task tool");
    expect(rewritten).toContain("- adversarial: Red-team reviewer");
    expect(rewritten).toContain('"subagent_type":"<kilo-subagent>"');
    expect(buildCursorNativeTaskRetryMessage([], original)).toContain(original);
  });
});
