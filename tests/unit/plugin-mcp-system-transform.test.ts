import { buildAvailableToolsSystemMessage } from "../../src/plugin";

describe("Plugin MCP system transform", () => {
  it("includes OpenCode tools in the system message", () => {
    const systemMessage = buildAvailableToolsSystemMessage(
      ["read", "write"],
      [{ id: "skill_search", name: "search" }],
      [],
    );

    expect(systemMessage).toContain("read, write");
    expect(systemMessage).toContain("skill_search -> search");
  });

  it("includes direct MCP tool call instructions when summaries provided", () => {
    const systemMessage = buildAvailableToolsSystemMessage(
      ["read", "write"],
      [],
      [
        {
          type: "function",
          function: { name: "mcp__hybrid_memory__memory_search" },
        },
      ],
      [
        {
          serverName: "hybrid-memory",
          toolName: "memory_search",
          description: "Search memories",
          params: ["query", "limit"],
        },
        {
          serverName: "hybrid-memory",
          toolName: "memory_stats",
          description: "Get stats",
        },
      ],
    );

    expect(systemMessage).toContain("direct tool calls");
    expect(systemMessage).toContain("mcp__");
    expect(systemMessage).toContain("mcp__hybrid_memory__memory_search");
    expect(systemMessage).toContain("hybrid-memory");
    expect(systemMessage).toContain("memory_search");
    expect(systemMessage).toContain("memory_stats");
    expect(systemMessage).toContain("query, limit");
  });

  it("prints exact callable MCP tool names when server or tool names are sanitized", () => {
    const systemMessage = buildAvailableToolsSystemMessage(
      [],
      [],
      [
        {
          type: "function",
          function: { name: "mcp__test_filesystem__list_directory" },
        },
      ],
      [
        {
          serverName: "test-filesystem",
          toolName: "list-directory",
          description: "List dir",
          params: ["path"],
        },
      ],
    );

    expect(systemMessage).toContain("mcp__test_filesystem__list_directory");
    expect(systemMessage).toContain("server: test-filesystem");
    expect(systemMessage).toContain("tool: list-directory");
  });

  it("includes multiple servers in MCP tool instructions", () => {
    const systemMessage = buildAvailableToolsSystemMessage(
      [],
      [],
      [],
      [
        {
          serverName: "hybrid-memory",
          toolName: "memory_stats",
          description: "Get stats",
        },
        {
          serverName: "test-filesystem",
          toolName: "list_directory",
          description: "List dir",
          params: ["path"],
        },
      ],
    );

    expect(systemMessage).toContain("hybrid-memory");
    expect(systemMessage).toContain("test-filesystem");
    expect(systemMessage).toContain("list_directory");
  });

  it("returns null when no tools at all", () => {
    const result = buildAvailableToolsSystemMessage([], [], []);
    expect(result).toBeNull();
  });
});
