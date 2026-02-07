import type { ToolListResponse } from "@opencode-ai/sdk";
import { createLogger } from "../utils/logger";
import stripAnsi from "strip-ansi";

const log = createLogger("tools:discovery");

export interface OpenCodeTool {
  id: string;
  name: string; // namespaced for OpenAI (e.g., oc_<id>)
  description: string;
  parameters: any; // JSON Schema
  source: "sdk" | "cli" | "mcp";
}

export interface DiscoveryOptions {
  ttlMs?: number;
  executor?: "sdk" | "cli" | "auto";
}

export class OpenCodeToolDiscovery {
  private client: any;
  private cache: Map<string, OpenCodeTool> = new Map();
  private cacheExpiry = 0;
  private ttl: number;
  private executorPref: "sdk" | "cli" | "auto";

  constructor(client: any, opts: DiscoveryOptions = {}) {
    this.client = client;
    this.ttl = opts.ttlMs ?? Number(process.env.CURSOR_ACP_TOOL_CACHE_TTL_MS || 60000);
    // Default: auto (SDK first, CLI fallback). Users can force sdk or cli.
    const envPref = process.env.CURSOR_ACP_TOOL_EXECUTOR as any;
    this.executorPref = opts.executor ?? (envPref === "sdk" || envPref === "cli" ? envPref : "auto");
  }

  async listTools(): Promise<OpenCodeTool[]> {
    const now = Date.now();
    if (this.cache.size > 0 && now < this.cacheExpiry) {
      return Array.from(this.cache.values());
    }

    let tools: OpenCodeTool[] = [];

    // Try SDK first (tool.list) if available
    if (this.executorPref !== "cli" && this.client?.tool?.list) {
      try {
        const resp: ToolListResponse = await this.client.tool.list();
        tools = (resp?.data?.tools || []).map((t: any) => this.normalize(t, "sdk"));

        // Merge MCP tools if available on client (best-effort)
        const mcpTools = await this.tryListMcpTools();
        tools = tools.concat(mcpTools);
      } catch (err) {
        log.warn("SDK tool.list failed, will try CLI", { error: String(err) });
      }
    }

    // Fallback: CLI opencode tool list --json (only if executorPref allows)
    if (tools.length === 0 && this.executorPref !== "sdk") {
      try {
        const { spawnSync } = await import("node:child_process");
        const cliCmd = process.env.OPENCODE_TOOL_LIST_SHIM
          ? process.env.OPENCODE_TOOL_LIST_SHIM.split(" ")
          : ["opencode", "tool", "list", "--json"];
        const res = spawnSync(cliCmd[0], cliCmd.slice(1), { encoding: "utf-8" });
        const parsed = this.parseCliJson(res.stdout || "");
        if (parsed?.data?.tools?.length) {
          tools = parsed.data.tools.map((t: any) => this.normalize(t, "cli"));
        } else {
          log.warn("CLI tool list failed", { status: res.status, stderr: res.stderr });
        }
      } catch (err) {
        log.error("CLI tool list error", { error: String(err) });
      }
    }

    if (tools.length === 0) {
      log.warn("No tools discovered via SDK or CLI; tool exposure will be skipped");
    }

    // Deduplicate by id after namespace
    const map = new Map<string, OpenCodeTool>();
    for (const t of tools) {
      map.set(t.name, t);
    }
    this.cache = map;
    this.cacheExpiry = now + this.ttl;
    return Array.from(this.cache.values());
  }

  getToolByName(name: string): OpenCodeTool | undefined {
    return this.cache.get(name);
  }

  private normalize(t: any, source: "sdk" | "cli" | "mcp"): OpenCodeTool {
    const id = String(t.id || t.name || "unknown");
    const name = this.namespace(id);
    return {
      id,
      name,
      description: String(t.description || "OpenCode tool"),
      parameters: t.parameters || { type: "object", properties: {} },
      source,
    };
  }

  private namespace(id: string): string {
    const sanitized = id.replace(/[^a-zA-Z0-9_\-]/g, "_").slice(0, 59); // leave room for prefix
    return `oc_${sanitized}`;
  }

  // Best-effort MCP discovery (if SDK exposes it)
  private async tryListMcpTools(): Promise<OpenCodeTool[]> {
    try {
      const mcpList = this.client?.mcp?.tool?.list ? await this.client.mcp.tool.list() : null;
      if (!mcpList?.data?.tools) return [];
      return mcpList.data.tools.map((t: any) => this.normalize(t, "mcp"));
    } catch (err) {
      log.debug("MCP tool discovery skipped", { error: String(err) });
      return [];
    }
  }

  // Parse JSON from noisy CLI output (strip ANSI, take last JSON object)
  private parseCliJson(stdout: string): any | null {
    const clean = stripAnsi(stdout || "").trim();
    if (!clean) return null;
    // Fast path
    try {
      return JSON.parse(clean);
    } catch {}
    // Find last '{'
    const lastBrace = clean.lastIndexOf("{");
    if (lastBrace >= 0) {
      const substr = clean.slice(lastBrace);
      try {
        return JSON.parse(substr);
      } catch {}
    }
    return null;
  }
}
