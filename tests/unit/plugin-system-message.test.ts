import { describe, it, expect } from "bun:test";
import { buildAvailableToolsSystemMessage } from "../../src/plugin.js";

describe("buildAvailableToolsSystemMessage", () => {
  it("does not add a filesystem-derived subagent list", () => {
    const msg = buildAvailableToolsSystemMessage(
      ["task", "read"],
      [{ id: "task", name: "task" }],
      [],
      [],
    );
    expect(msg).not.toContain("subagent_type");
  });

  it("returns null when no tools are available", () => {
    const msg = buildAvailableToolsSystemMessage([], [], [], []);
    expect(msg).toBeNull();
  });
});
