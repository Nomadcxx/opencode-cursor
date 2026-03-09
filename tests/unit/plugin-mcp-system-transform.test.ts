import { buildAvailableToolsSystemMessage } from "../../src/plugin";

describe("Plugin MCP system transform", () => {
  it("includes bridged MCP tools in the system tool guidance", () => {
    const systemMessage = buildAvailableToolsSystemMessage(
      ["read", "write"],
      [{ id: "skill_search", name: "search" }],
      [
        {
          type: "function",
          function: {
            name: "mcp__hybrid_memory__memory_search",
          },
        },
      ],
    );

    expect(systemMessage).toContain("read, write, mcp__hybrid_memory__memory_search");
    expect(systemMessage).toContain("skill_search -> search");
  });
});
