import { describe, it, expect } from "bun:test";
import { buildPromptFromMessages } from "../../src/proxy/prompt-builder.js";

describe("buildPromptFromMessages — subagent_type injection", () => {
  const taskTool = { function: { name: "task", description: "spawn a subagent", parameters: {} } };
  const otherTool = { function: { name: "read", description: "read a file", parameters: {} } };

  it("injects guidance when tools include task and subagentNames provided", () => {
    const prompt = buildPromptFromMessages(
      [{ role: "user", content: "analyze this repo" }],
      [taskTool],
      ["general-purpose", "codemachine"],
    );
    expect(prompt).toContain("general-purpose");
    expect(prompt).toContain("codemachine");
    expect(prompt).toContain("subagent_type");
  });

  it("does not inject guidance when tools do not include task", () => {
    const prompt = buildPromptFromMessages(
      [{ role: "user", content: "read a file" }],
      [otherTool],
      ["general-purpose"],
    );
    expect(prompt).not.toContain("subagent_type");
  });

  it("does not inject guidance when subagentNames is empty", () => {
    const prompt = buildPromptFromMessages(
      [{ role: "user", content: "analyze" }],
      [taskTool],
      [],
    );
    expect(prompt).not.toContain("subagent_type");
  });

  it("works without third parameter (backwards compat)", () => {
    expect(() => buildPromptFromMessages(
      [{ role: "user", content: "hello" }],
      [otherTool],
    )).not.toThrow();
  });
});
