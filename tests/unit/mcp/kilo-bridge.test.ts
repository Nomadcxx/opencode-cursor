import { describe, expect, it } from "bun:test";
import {
  buildKiloMcpAliasHint,
  buildKiloCoreBridgeToolFallbacks,
  buildProxyAllowedToolNames,
  discoverKiloNativeCoreToolDefs,
  discoverKiloNativeMcpToolDefs,
  enrichKiloToolsWithMcpAliases,
  isCursorNativeMcpDiscoveryTool,
  isKiloMcpCatalogToolName,
  isKiloMcpToolName,
  isKiloNativeCoreToolName,
  kiloCoreToolRecordToDef,
  kiloMcpToolRecordToDef,
  mcpCatalogAliasKey,
  remapBareMcpToolCall,
  resolveMcpToolName,
  splitKiloMcpToolName,
  normalizeKiloCoreToolArgs,
} from "../../../src/mcp/kilo-bridge.js";

describe("mcp/kilo-bridge", () => {
  it("splits Kilo MCP function names into server and tool", () => {
    expect(splitKiloMcpToolName("context7_resolve-library-id")).toEqual({
      server: "context7",
      toolName: "resolve-library-id",
    });
    expect(splitKiloMcpToolName("browser-harness_browser_list_tabs")).toEqual({
      server: "browser-harness",
      toolName: "browser_list_tabs",
    });
  });

  it("does not treat native Kilo tools as MCP splits", () => {
    expect(splitKiloMcpToolName("list_mcp_resources")).toBeNull();
    expect(splitKiloMcpToolName("skill_mcp")).toBeNull();
    expect(splitKiloMcpToolName("read")).toBeNull();
  });

  it("keeps natives and viking wrappers out of the GetDynamicTools catalog", () => {
    expect(isKiloMcpCatalogToolName("browser-harness_browser_list_tabs")).toBe(true);
    expect(isKiloMcpCatalogToolName("openviking_health")).toBe(true);
    expect(isKiloMcpCatalogToolName("context7_query-docs")).toBe(true);
    expect(isKiloMcpCatalogToolName("agent_manager")).toBe(false);
    expect(isKiloMcpCatalogToolName("background_process")).toBe(false);
    expect(isKiloMcpCatalogToolName("kilo_local_recall")).toBe(false);
    expect(isKiloMcpCatalogToolName("viking_search")).toBe(false);
    expect(mcpCatalogAliasKey("context7_query-docs")).toBe(mcpCatalogAliasKey("context7_query_docs"));
  });

  it("detects Kilo native core tools for skill bridge backfill", () => {
    expect(isKiloNativeCoreToolName("skill")).toBe(true);
    expect(isKiloNativeCoreToolName("skill_mcp")).toBe(true);
    expect(isKiloNativeCoreToolName("plan")).toBe(true);
    expect(isKiloNativeCoreToolName("openviking_search")).toBe(false);
    expect(isKiloNativeCoreToolName("agent_manager")).toBe(false);
    expect(isKiloNativeCoreToolName("read")).toBe(false);
    expect(kiloCoreToolRecordToDef("skill")?.function.name).toBe("skill");
    expect(kiloCoreToolRecordToDef("openviking_health")).toBeNull();
  });

  it("maps cursor-agent mcp__ names back to Kilo names", () => {
    const allowed = new Set(["context7_resolve-library-id", "read"]);
    expect(resolveMcpToolName("mcp__context7__resolve_library_id", allowed)).toBe(
      "context7_resolve-library-id",
    );
    expect(resolveMcpToolName("context7_query_docs", new Set(["context7_query-docs"]))).toBe(
      "context7_query-docs",
    );
    expect(resolveMcpToolName("mcp__browser_harness__browser_list_tabs", new Set([
      "browser-harness_browser_list_tabs",
    ]))).toBe("browser-harness_browser_list_tabs");
  });

  it("does not add mcp__ aliases to the visible catalog", () => {
    const tools = [
      {
        type: "function",
        function: {
          name: "context7_get_docs",
          description: "Fetch docs",
          parameters: { type: "object", properties: { query: { type: "string" } } },
        },
      },
    ];

    const enriched = enrichKiloToolsWithMcpAliases(tools);
    const names = enriched.map((t) => t.function.name);
    expect(names).toContain("context7_get_docs");
    expect(names.some((name) => name.startsWith("mcp__"))).toBe(false);
  });

  it("builds proxy allowlist with both Kilo and cursor-agent MCP names", () => {
    const allowed = buildProxyAllowedToolNames([
      { function: { name: "context7_search" } },
      { function: { name: "read" } },
    ]);

    expect(allowed.has("context7_search")).toBe(true);
    expect(allowed.has("mcp__context7__search")).toBe(true);
    expect(allowed.has("GetDynamicTools")).toBe(true);
    expect(buildProxyAllowedToolNames([
      { function: { name: "browser-harness_browser_list_tabs" } },
    ]).has("mcp__browser_harness__browser_list_tabs")).toBe(true);
  });

  it("remaps bare mcp wrapper calls to the Kilo tool name", () => {
    const allowed = buildProxyAllowedToolNames([
      { function: { name: "context7_search" } },
    ]);

    const remapped = remapBareMcpToolCall(
      { providerIdentifier: "context7", toolName: "search", args: { q: "react" } },
      allowed,
    );

    expect(remapped).toEqual({
      name: "context7_search",
      args: { q: "react" },
    });
  });

  it("builds alias hint for system prompt", () => {
    const hint = buildKiloMcpAliasHint(["read", "context7_search", "bash"]);
    expect(hint).toContain("context7_search");
    expect(hint).toContain("GetDynamicTools");
    expect(isKiloMcpToolName("context7_search")).toBe(true);
  });

  it("detects cursor native MCP discovery tools", () => {
    expect(isCursorNativeMcpDiscoveryTool("GetMcpTools")).toBe(true);
    expect(isCursorNativeMcpDiscoveryTool("CallMcpTool")).toBe(true);
    expect(isCursorNativeMcpDiscoveryTool("context7_search")).toBe(false);
  });

  it("builds MCP function defs from ids and server+name records", () => {
    expect(kiloMcpToolRecordToDef("openviking_health")?.function.name).toBe("openviking_health");
    expect(kiloMcpToolRecordToDef("read")).toBeNull();
    expect(kiloMcpToolRecordToDef("agent_manager")).toBeNull();
    expect(kiloMcpToolRecordToDef({
      server: "browser-harness",
      name: "browser_list_tabs",
      description: "list tabs",
    })?.function).toEqual({
      name: "browser-harness_browser_list_tabs",
      description: "list tabs",
      parameters: { type: "object", properties: {} },
    });
  });

  it("discovers dynamically registered MCP tools from tool.ids when mcp.tool.list is absent", async () => {
    const client = {
      tool: {
        ids: async () => ({
          data: [
            "read",
            "bash",
            "openviking_health",
            "openviking_search",
            "browser-harness_browser_list_tabs",
            "agent_manager",
          ],
        }),
      },
    };

    const names = (await discoverKiloNativeMcpToolDefs(client)).map((t) => t.function.name);
    expect(names).toEqual([
      "openviking_health",
      "openviking_search",
      "browser-harness_browser_list_tabs",
    ]);
  });

  it("discovers native core tools like skill from tool.list and tool.ids", async () => {
    const client = {
      tool: {
        list: async () => ({
          data: [{
            id: "skill",
            name: "skill",
            description: "Load an Agent Skill",
            parameters: {
              type: "object",
              properties: { name: { type: "string" } },
              required: ["name"],
            },
          }],
        }),
        ids: async () => ({ data: ["read", "skill", "skill_mcp", "openviking_search"] }),
      },
    };

    const defs = await discoverKiloNativeCoreToolDefs(client);
    const names = defs.map((t) => t.function.name);
    expect(names).toContain("skill");
    expect(names).toContain("skill_mcp");
    expect(names).not.toContain("read");
    expect(names).not.toContain("openviking_search");
    expect(defs.find((t) => t.function.name === "skill")?.function.description).toBe(
      "Load an Agent Skill",
    );
  });

  it("injects static skill fallbacks when tool.list and tool.ids omit core tools", async () => {
    const client = { tool: { list: async () => ({ data: [] }), ids: async () => ({ data: ["read", "bash"] }) } };
    const defs = await discoverKiloNativeCoreToolDefs(client, ["read", "bash"]);
    const names = defs.map((t) => t.function.name);

    expect(names).toContain("skill");
    expect(names).toContain("skill_mcp");
    expect(names).not.toContain("read");
    expect(names).not.toContain("bash");
    expect(buildKiloCoreBridgeToolFallbacks(["skill"]).map((t) => t.function.name)).not.toContain("skill");
  });

  it("overlays fallback skill schema when tool.ids lists skill without parameters", async () => {
    const client = { tool: { ids: async () => ({ data: ["skill", "read"] }) } };
    const defs = await discoverKiloNativeCoreToolDefs(client);
    const skill = defs.find((t) => t.function.name === "skill");

    expect(skill?.function.parameters).toEqual({
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Skill id from available_skills (e.g. superpowers/brainstorming)",
        },
      },
      required: ["name"],
    });
    expect(skill?.function.description).toContain("Agent Skill");
  });

  it("fills skill.name from alias fields and ignores reserved CallDynamicTool names", () => {
    expect(normalizeKiloCoreToolArgs("skill", { skill: "bmad-spec" })).toEqual({
      skill: "bmad-spec",
      name: "bmad-spec",
    });
    expect(normalizeKiloCoreToolArgs("skill", { namespace: "kilo", toolName: "bmad-spec" })).toEqual({
      namespace: "kilo",
      toolName: "bmad-spec",
      name: "bmad-spec",
    });
    expect(normalizeKiloCoreToolArgs("skill", { namespace: "kilo", toolName: "skill" })).toEqual({
      namespace: "kilo",
      toolName: "skill",
    });
    expect(normalizeKiloCoreToolArgs("skill", "bmad-spec")).toEqual({ name: "bmad-spec" });
  });
});
