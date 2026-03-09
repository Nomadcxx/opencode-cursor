import { tool } from "@opencode-ai/plugin";
import { createLogger } from "../utils/logger.js";
import type { McpClientManager } from "./client-manager.js";

const log = createLogger("mcp:tool-bridge");

interface DiscoveredMcpTool {
  name: string;
  serverName: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/**
 * Build plugin `tool()` hook entries for discovered MCP tools.
 *
 * Each MCP tool is namespaced as `mcp__<server_name>__<tool_name>`
 * to avoid collision with local tools and to make the source clear.
 */
export function buildMcpToolHookEntries(
  tools: DiscoveredMcpTool[],
  manager: McpClientManager,
): Record<string, any> {
  const z = tool.schema;
  const entries: Record<string, any> = {};

  for (const t of tools) {
    const hookName = namespaceMcpTool(t.serverName, t.name);

    if (entries[hookName]) {
      log.debug("Duplicate MCP tool name, skipping", { hookName });
      continue;
    }

    const zodArgs = mcpSchemaToZod(t.inputSchema, z);
    const serverName = t.serverName;
    const toolName = t.name;

    entries[hookName] = tool({
      description: t.description || `MCP tool: ${t.name} (server: ${t.serverName})`,
      args: zodArgs,
      async execute(args: any) {
        log.debug("Executing MCP tool", { server: serverName, tool: toolName });
        const result = await manager.callTool(serverName, toolName, args ?? {});
        if (result.startsWith("Error:")) {
          throw new Error(result);
        }
        return result;
      },
    });
  }

  log.debug("Built MCP tool hook entries", { count: Object.keys(entries).length });
  return entries;
}

/**
 * Build OpenAI-format tool definitions for discovered MCP tools.
 * These are injected into chat.params so the model sees the tools.
 */
export function buildMcpToolDefinitions(tools: DiscoveredMcpTool[]): any[] {
  const defs: any[] = [];

  for (const t of tools) {
    const name = namespaceMcpTool(t.serverName, t.name);
    defs.push({
      type: "function",
      function: {
        name,
        description: t.description || `MCP tool: ${t.name} (server: ${t.serverName})`,
        parameters: t.inputSchema ?? { type: "object", properties: {} },
      },
    });
  }

  return defs;
}

function namespaceMcpTool(serverName: string, toolName: string): string {
  const sanitizedServer = serverName.replace(/[^a-zA-Z0-9]/g, "_");
  const sanitizedTool = toolName.replace(/[^a-zA-Z0-9]/g, "_");
  return `mcp__${sanitizedServer}__${sanitizedTool}`;
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
        zodType = z.record(z.any());
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
