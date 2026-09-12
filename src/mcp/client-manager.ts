import { createLogger } from "../utils/logger.js";
import type { McpServerConfig } from "./config.js";

const log = createLogger("mcp:client-manager");

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

interface DiscoveredTool extends McpToolInfo {
  serverName: string;
}

interface ServerConnection {
  client: any;
  tools: McpToolInfo[];
}

interface McpClientManagerDeps {
  createClient: () => any;
  createTransport: (config: McpServerConfig) => any;
}

let defaultDeps: McpClientManagerDeps | null = null;

async function loadDefaultDeps(): Promise<McpClientManagerDeps> {
  if (defaultDeps) return defaultDeps;
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");

  defaultDeps = {
    createClient: () =>
      new Client({ name: "kilo-cursor-plugin", version: "1.0.0" }, { capabilities: {} }),
    createTransport: (config: McpServerConfig) => {
      if (config.type === "local") {
        return new StdioClientTransport({
          command: config.command[0],
          args: config.command.slice(1),
          env: { ...process.env, ...(config.environment ?? {}) },
          stderr: "pipe",
        });
      }
      // Remote servers: StreamableHTTPClientTransport can be added later.
      throw new Error(`Remote MCP transport not yet implemented for ${config.name}`);
    },
  };
  return defaultDeps;
}

export class McpClientManager {
  private connections = new Map<string, ServerConnection>();
  private deps: McpClientManagerDeps | null;

  constructor(deps?: McpClientManagerDeps) {
    this.deps = deps ?? null;
  }

  async connectServer(config: McpServerConfig): Promise<void> {
    if (this.connections.has(config.name)) {
      log.debug("Server already connected, skipping", { server: config.name });
      return;
    }

    // Lazy-load MCP SDK if no deps were injected
    if (!this.deps) {
      try {
        this.deps = await loadDefaultDeps();
      } catch (err) {
        log.warn("Failed to load MCP SDK", { error: String(err) });
        return;
      }
    }

    const deps = this.deps;
    let client: any;
    try {
      client = deps.createClient();
      const transport = deps.createTransport(config);
      await client.connect(transport);
    } catch (err) {
      log.warn("MCP server connection failed", {
        server: config.name,
        error: String(err),
      });
      return;
    }

    let tools: McpToolInfo[] = [];
    try {
      const result = await client.listTools();
      tools = result?.tools ?? [];
      log.info("MCP server connected", {
        server: config.name,
        tools: tools.length,
      });
    } catch (err) {
      log.warn("MCP tool discovery failed", {
        server: config.name,
        error: String(err),
      });
    }

    this.connections.set(config.name, { client, tools });
  }

  listTools(): DiscoveredTool[] {
    const all: DiscoveredTool[] = [];
    for (const [serverName, conn] of this.connections) {
      for (const tool of conn.tools) {
        all.push({ ...tool, serverName });
      }
    }
    return all;
  }

  async callTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    const conn = this.connections.get(serverName);
    if (!conn) {
      return `Error: MCP server "${serverName}" not connected`;
    }

    try {
      const result = await conn.client.callTool({
        name: toolName,
        arguments: args,
      });

      // MCP callTool returns { content: Array<{ type, text }> }
      if (Array.isArray(result?.content)) {
        return result.content
          .map((c: any) => (c.type === "text" ? c.text : JSON.stringify(c)))
          .join("\n");
      }
      return typeof result === "string" ? result : JSON.stringify(result);
    } catch (err: any) {
      log.warn("MCP tool call failed", {
        server: serverName,
        tool: toolName,
        error: String(err?.message || err),
      });
      return `Error: MCP tool "${toolName}" failed: ${err?.message || err}`;
    }
  }

  async disconnectAll(): Promise<void> {
    for (const [name, conn] of this.connections) {
      try {
        await conn.client.close();
        log.debug("MCP server disconnected", { server: name });
      } catch (err) {
        log.debug("MCP server disconnect failed", { server: name, error: String(err) });
      }
    }
    this.connections.clear();
  }

  get connectedServers(): string[] {
    return Array.from(this.connections.keys());
  }
}
