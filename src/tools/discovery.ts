import type { ToolListResponse } from "@kilocode/sdk";
import { createLogger } from "../utils/logger";
import stripAnsi from "strip-ansi";
import { resolveKiloCliCommand } from "../kilo/platform.js";

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
    this.ttl = opts.ttlMs ?? Number(process.env.CURSOR_KILO_TOOL_CACHE_TTL_MS || process.env.CURSOR_ACP_TOOL_CACHE_TTL_MS || 60000);
    const envPref = (process.env.CURSOR_KILO_TOOL_EXECUTOR ?? process.env.CURSOR_ACP_TOOL_EXECUTOR) as any;
    this.executorPref = opts.executor ?? (envPref === "sdk" || envPref === "cli" ? envPref : "auto");
  }

  async listTools(): Promise<OpenCodeTool[]> {
    const now = Date.now();
    if (this.cache.size > 0 && now < this.cacheExpiry) {
      return Array.from(this.cache.values());
    }

    let tools: OpenCodeTool[] = [];

    if (this.executorPref !== "cli" && this.client?.tool?.list) {
      try {
        const resp: ToolListResponse = await this.client.tool.list({});
        const rawTools = Array.isArray(resp?.data) ? resp.data : (resp?.data as any)?.tools || [];
        tools = rawTools.map((t: any) => this.normalize(t, "sdk"));

        const mcpTools = await this.tryListMcpTools();
        tools = tools.concat(mcpTools);
      } catch (err) {
        log.debug("SDK tool.list failed, will try CLI", { error: String(err) });
      }
    }

    // Fallback: `kilo tool list --json` (Kilo fork; same as opencode tool list)
    if (tools.length === 0 && this.executorPref !== "sdk") {
      try {
        const { spawnSync } = await import("node:child_process");
        const { resolveToolExecMaxBuffer } = await import("./exec-utils.js");
        const cliCmd = resolveKiloCliCommand();
        const res = spawnSync(cliCmd[0], cliCmd.slice(1), {
          encoding: "utf-8",
          maxBuffer: resolveToolExecMaxBuffer(),
        });
        const parsed = this.parseCliJson(res.stdout || "");
        if (parsed?.data?.tools?.length) {
          tools = parsed.data.tools.map((t: any) => this.normalize(t, "cli"));
        } else {
          log.debug("CLI tool list failed", { status: res.status, stderr: res.stderr });
        }
      } catch (err) {
        log.debug("CLI tool list error", { error: String(err) });
      }
    }

    const map = new Map<string, OpenCodeTool>();
    for (const t of tools) {
      map.set(t.name, t);
      // Also index by native id so cursor-agent can call read/glob/websearch directly
      if (t.id !== t.name) {
        map.set(t.id, t);
      }
    }
    this.cache = map;
    this.cacheExpiry = now + this.ttl;
    return Array.from(new Map(Array.from(map.values()).map((t) => [t.name, t])).values());
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
      description: String(t.description || "Kilo tool"),
      parameters: t.parameters || { type: "object", properties: {} },
      source,
    };
  }

  private namespace(id: string): string {
    const sanitized = id.replace(/[^a-zA-Z0-9_\-]/g, "_").slice(0, 59);
    return `oc_${sanitized}`;
  }

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

  private parseCliJson(stdout: string): any | null {
    const clean = stripAnsi(stdout || "").trim();
    if (!clean) return null;
    try {
      return JSON.parse(clean);
    } catch {}
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
