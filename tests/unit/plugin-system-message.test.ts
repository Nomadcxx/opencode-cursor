import { describe, it, expect } from "bun:test";
import { buildAvailableToolsSystemMessage } from "../../src/plugin.js";

describe("buildAvailableToolsSystemMessage", () => {
  it("includes Kilo subagents from the task tool roster when provided", () => {
    const msg = buildAvailableToolsSystemMessage(
      ["task", "read"],
      [{ id: "task", name: "task" }],
      [],
      [],
      [
        { name: "adversarial", description: "Red-team reviewer for risky changes" },
        { name: "image-describer", description: "Describes images for non-vision models" },
      ],
    );

    expect(msg).toContain("Registered Kilo subagents:");
    expect(msg).toContain("- adversarial: Red-team reviewer for risky changes");
    expect(msg).toContain("- image-describer: Describes images for non-vision models");
    expect(msg).toContain("Never use subagentType");
    expect(msg).toContain('{ custom: "name" }');
  });

  it("includes skill invocation guidance even when no tools are listed yet", () => {
    const msg = buildAvailableToolsSystemMessage([], [], [], []);
    expect(msg).toContain('skill({ name: "<id-from-available_skills>" })');
    expect(msg).toContain("name argument is required");
    expect(msg).toContain("available_skills");
  });
});
