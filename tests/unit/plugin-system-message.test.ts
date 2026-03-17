import { describe, it, expect } from "bun:test";
import { buildAvailableToolsSystemMessage } from "../../src/plugin.js";

describe("buildAvailableToolsSystemMessage — subagentNames injection", () => {
  it("includes subagent names in task guidance", () => {
    const msg = buildAvailableToolsSystemMessage(
      ["task", "read"],
      [{ id: "task", name: "task" }],
      [],
      [],
      ["codemachine", "review"],
    );
    expect(msg).toContain("codemachine");
    expect(msg).toContain("review");
    expect(msg).toContain("subagent_type");
  });

  it("omits task guidance when subagentNames is empty", () => {
    const msg = buildAvailableToolsSystemMessage(
      ["task"],
      [],
      [],
      [],
      [],
    );
    expect(msg).not.toContain("subagent_type");
  });

  it("returns null when no tools and no subagentNames", () => {
    const msg = buildAvailableToolsSystemMessage([], [], [], [], []);
    expect(msg).toBeNull();
  });
});
