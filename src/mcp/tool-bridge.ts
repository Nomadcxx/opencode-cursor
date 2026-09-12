import { tool } from "@kilocode/plugin/tool";
import { createLogger } from "../utils/logger.js";
import type { McpClientManager } from "./client-manager.js";
import { namespaceMcpToolKilo, namespaceMcpToolKiloNative } from "../kilo/platform.js";

const log = createLogger("mcp:tool-bridge");

export const MCP_TOOL_PREFIX = "mcp__";

interface DiscoveredMcpTool {
  name: string;
  serverName: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

function makeMcpExecutor(
  manager: McpClientManager,
  serverName: string,
  toolName: string,
) {
  return async (args: any) => {
    log.debug("Executing MCP tool", { server: serverName, tool: toolName });
    const result = await manager.callTool(serverName, toolName, args ?? {});
    if (result.startsWith("Error:")) {
      throw new Error(result);
    }
    return result;
  };
}

/**
 * Build plugin `tool()` hook entries for discovered MCP tools.
 *
 * Registers both naming conventions for transparent Kilo <-> cursor-agent bridging:
 * - cursor-agent: `mcp__<server>__<tool>`
 * - Kilo native:  `<server>_<tool>`
 */
export function buildMcpToolHookEntries(
  tools: DiscoveredMcpTool[],
  manager: McpClientManager,
): Record<string, any> {
  const z = tool.schema;
  const entries: Record<string, any> = {};

  for (const t of tools) {
    const cursorName = namespaceMcpTool(t.serverName, t.name);
    const kiloSanitized = namespaceMcpToolKilo(t.serverName, t.name);
    const kiloNative = namespaceMcpToolKiloNative(t.serverName, t.name);
    const zodArgs = mcpSchemaToZod(t.inputSchema, z);
    const execute = makeMcpExecutor(manager, t.serverName, t.name);
    const description = t.description || `MCP tool: ${t.name} (server: ${t.serverName})`;

    for (const hookName of [cursorName, kiloSanitized, kiloNative]) {
      if (entries[hookName]) continue;
      entries[hookName] = tool({ description, args: zodArgs, execute });
    }
  }

  log.debug("Built MCP tool hook entries", { count: Object.keys(entries).length });
  return entries;
}

/**
 * Build OpenAI-format tool definitions for discovered MCP tools.
 * Visible names match Kilo (`<server>_<tool>`); mcp__ aliases stay off the catalog.
 */
export function buildMcpToolDefinitions(tools: DiscoveredMcpTool[]): any[] {
  const defs: any[] = [];
  const seen = new Set<string>();

  for (const t of tools) {
    const description = t.description || `MCP tool: ${t.name} (server: ${t.serverName})`;
    const parameters = t.inputSchema ?? { type: "object", properties: {} };

    const name = namespaceMcpToolKiloNative(t.serverName, t.name);
    if (seen.has(name)) continue;
    seen.add(name);
    defs.push({
      type: "function",
      function: { name, description, parameters },
    });
  }

  return defs;
}

export function namespaceMcpTool(serverName: string, toolName: string): string {
  const sanitizedServer = serverName.replace(/[^a-zA-Z0-9]/g, "_");
  const sanitizedTool = toolName.replace(/[^a-zA-Z0-9]/g, "_");
  return `${MCP_TOOL_PREFIX}${sanitizedServer}__${sanitizedTool}`;
}

function mcpSchemaToZod(inputSchema: Record<string, unknown> | undefined, z: any): any {
  if (!inputSchema || typeof inputSchema !== "object") {
    return {};
  }

  const properties = (inputSchema.properties ?? {}) as Record<string, any>;
  const required = (inputSchema.required ?? []) as string[];
  const shape: any = {};

  for (const [key, prop] of Object.entries(properties)) {
    let zodType: any;

    switch (prop?.type) {
      case "string":
        zodType = z.string();
        break;
      case "number":
      case "integer":
        zodType = z.number();
        break;
      case "boolean":
        zodType = z.boolean();
        break;
      case "array":
        zodType = z.array(z.any());
        break;
      case "object":
        zodType = z.record(z.string(), z.any());
        break;
      default:
        zodType = z.any();
        break;
    }

    if (prop?.description) {
      zodType = zodType.describe(prop.description);
    }

    if (!required.includes(key)) {
      zodType = zodType.optional();
    }

    shape[key] = zodType;
  }

  return shape;
}
