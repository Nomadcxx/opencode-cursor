import { describe, expect, it } from "bun:test";
import {
  formatKiloMcpDynamicCatalog,
  getRememberedMcpCatalog,
  isCallDynamicToolName,
  isGetDynamicToolsName,
  parseCallDynamicToolArgs,
  rememberCoreToolsFromTools,
  rememberMcpCatalogFromTools,
  resetRememberedMcpCatalog,
  resolveCallDynamicToolToKiloName,
  shouldPassthroughCursorDynamicTool,
} from "../../../src/mcp/dynamic-catalog.js";

describe("mcp/dynamic-catalog", () => {
  it("detects GetDynamicTools and GetMcpTools catalog names", () => {
    expect(isGetDynamicToolsName("GetDynamicTools")).toBe(true);
    expect(isGetDynamicToolsName("GetMcpTools")).toBe(true);
    expect(isGetDynamicToolsName("openviking_search")).toBe(false);
  });

  it("passthroughs cursor namespace dynamic tools", () => {
    expect(shouldPassthroughCursorDynamicTool({
      namespace: "cursor",
      toolName: "CreateGoal",
      arguments: { title: "x" },
    })).toBe(true);
    expect(shouldPassthroughCursorDynamicTool({
      namespace: "kilo",
      toolName: "openviking_search",
      arguments: { query: "q" },
    })).toBe(false);
  });

  it("resolves CallDynamicTool args to the Kilo MCP name", () => {
    const allowed = new Set(["openviking_search", "context7_query-docs"]);
    expect(resolveCallDynamicToolToKiloName(
      { namespace: "openviking", toolName: "search", arguments: { query: "q" } },
      allowed,
    )).toEqual({ name: "openviking_search", args: { query: "q" } });
    expect(resolveCallDynamicToolToKiloName(
      { namespace: "context7", toolName: "query_docs", arguments: { library: "react" } },
      allowed,
    )).toEqual({ name: "context7_query-docs", args: { library: "react" } });
    expect(parseCallDynamicToolArgs({
      providerIdentifier: "context7",
      toolName: "query-docs",
      args: { library: "react" },
    })).toEqual({
      namespace: "context7",
      toolName: "query-docs",
      innerArgs: { library: "react" },
    });
    expect(isCallDynamicToolName("CallDynamicTool")).toBe(true);
    expect(parseCallDynamicToolArgs(JSON.stringify({
      namespace: "openviking",
      toolName: "find",
      arguments: "{\"query\":\"openviking health\",\"limit\":3}",
    }))).toEqual({
      namespace: "openviking",
      toolName: "find",
      innerArgs: { query: "openviking health", limit: 3 },
    });
  });

  it("remaps CallDynamicTool even when the tool is missing from the allowlist", () => {
    expect(resolveCallDynamicToolToKiloName(
      { namespace: "openviking", toolName: "health", arguments: {} },
      new Set(["read", "GetDynamicTools"]),
    )).toEqual({ name: "openviking_health", args: {} });
    expect(resolveCallDynamicToolToKiloName(
      { namespace: "browser-harness", toolName: "browser_list_tabs", arguments: { include_chrome: false } },
      new Set(),
    )).toEqual({
      name: "browser-harness_browser_list_tabs",
      args: { include_chrome: false },
    });
  });

  it("remembers Kilo MCP names from request tools when mcp.tool.list is empty", async () => {
    resetRememberedMcpCatalog();
    rememberMcpCatalogFromTools([
      { function: { name: "read", description: "read file" } },
      { function: { name: "openviking_search", description: "semantic search" } },
      { function: { name: "mcp__openviking__search", description: "alias" } },
      { function: { name: "context7_query-docs", description: "docs" } },
      { function: { name: "browser-harness_browser_list_tabs", description: "list tabs" } },
    ]);
    expect(getRememberedMcpCatalog().map((entry) => entry.name)).toEqual([
      "browser-harness_browser_list_tabs",
      "context7_query-docs",
      "openviking_search",
    ]);

    const text = await formatKiloMcpDynamicCatalog({ mcp: { tool: { list: async () => ({ data: { tools: [] } }) } } });
    expect(text).toContain("openviking_search");
    expect(text).toContain("context7_query-docs");
    expect(text).toContain("browser-harness_browser_list_tabs");
    expect(text).toContain("- openviking");
    expect(text).toContain("- browser-harness");
    expect(text).toContain("not the full catalog");
    expect(text).not.toContain("mcp__openviking__search");
    expect(text).not.toContain("- read");
  });

  it("omits Kilo natives and viking wrappers, and keeps hyphenated Kilo names", async () => {
    resetRememberedMcpCatalog();
    rememberMcpCatalogFromTools([
      { function: { name: "agent_manager", description: "agent manager" } },
      { function: { name: "agent_manager_models", description: "models" } },
      { function: { name: "background_process", description: "bg" } },
      { function: { name: "kilo_local_recall", description: "recall" } },
      { function: { name: "viking_search", description: "legacy wrapper" } },
      { function: { name: "context7_query-docs", description: "hyphen docs" } },
      { function: { name: "context7_query_docs", description: "underscore docs" } },
      { function: { name: "openviking_search", description: "search" } },
    ]);

    const names = getRememberedMcpCatalog().map((entry) => entry.name);
    expect(names).toEqual(["context7_query-docs", "openviking_search"]);

    const text = await formatKiloMcpDynamicCatalog({ mcp: { tool: { list: async () => ({ data: { tools: [] } }) } } });
    expect(text).toContain("- openviking_search");
    expect(text).toContain("- context7_query-docs");
    expect(text).not.toContain("context7_query_docs");
    expect(text).not.toContain("- agent_manager");
    expect(text).not.toContain("- viking_search");
    expect(text).not.toContain("- kilo_local_recall");
    expect(text).not.toContain("- background_process");
  });

  it("lists sibling Kilo namespaces when GetDynamicTools asks for cursor", async () => {
    resetRememberedMcpCatalog();
    rememberMcpCatalogFromTools([
      { function: { name: "openviking_health", description: "health" } },
      { function: { name: "context7_query-docs", description: "docs" } },
    ]);
    rememberCoreToolsFromTools([
      { function: { name: "skill", description: "load skill" } },
      { function: { name: "skill_mcp", description: "skill mcp" } },
    ]);

    const text = await formatKiloMcpDynamicCatalog(
      { mcp: { tool: { list: async () => ({ data: { tools: [] } }) } } },
      "cursor",
    );
    expect(text).toContain("CreateGoal");
    expect(text).toContain("openviking");
    expect(text).toContain("context7");
    expect(text).toContain("not the full catalog");
    expect(text).toContain("Kilo core tools");
    expect(text).toContain("- skill");
    expect(text).toContain("CallDynamicTool");
    expect(text).toContain("available_skills");
    expect(text).not.toContain("not CallDynamicTool");
  });

  it("remaps CallDynamicTool kilo/skill to the native skill tool", () => {
    expect(resolveCallDynamicToolToKiloName(
      { namespace: "kilo", toolName: "skill", arguments: { name: "bmad-spec" } },
      new Set(),
    )).toEqual({ name: "skill", args: { name: "bmad-spec" } });
    expect(resolveCallDynamicToolToKiloName(
      { namespace: "kilo", toolName: "skill", arguments: { skill: "bmad-spec" } },
      new Set(["read"]),
    )).toEqual({ name: "skill", args: { skill: "bmad-spec", name: "bmad-spec" } });
    expect(resolveCallDynamicToolToKiloName(
      { namespace: "skill", toolName: "bmad-spec", arguments: {} },
      new Set(),
    )).toEqual({ name: "skill", args: { name: "bmad-spec" } });
    expect(resolveCallDynamicToolToKiloName(
      { namespace: "kilo", toolName: "bmad-spec" },
      new Set(),
    )).toEqual({ name: "skill", args: { name: "bmad-spec" } });
    expect(resolveCallDynamicToolToKiloName(
      { namespace: "kilo", toolName: "skill", name: "bmad-spec" },
      new Set(),
    )).toEqual({ name: "skill", args: { name: "bmad-spec" } });
  });

  it("lists skill via CallDynamicTool when GetDynamicTools asks for kilo", async () => {
    resetRememberedMcpCatalog();
    const text = await formatKiloMcpDynamicCatalog(
      { mcp: { tool: { list: async () => ({ data: { tools: [] } }) } } },
      { namespace: "kilo", toolName: "skill" },
    );
    expect(text).toContain("skill");
    expect(text).toContain("CallDynamicTool");
    expect(text).toContain("available_skills");
    expect(text).toContain("Never call skill() with empty arguments");
  });

  it("filters GetDynamicTools by MCP server namespace", async () => {
    resetRememberedMcpCatalog();
    rememberMcpCatalogFromTools([
      { function: { name: "openviking_health", description: "health" } },
      { function: { name: "openviking_search", description: "search" } },
      { function: { name: "context7_query-docs", description: "docs" } },
    ]);

    const text = await formatKiloMcpDynamicCatalog(
      { mcp: { tool: { list: async () => ({ data: { tools: [] } }) } } },
      { namespace: "openviking" },
    );
    expect(text).toContain("openviking_health");
    expect(text).toContain("openviking_search");
    expect(text).not.toContain("context7_query-docs");
  });
});
