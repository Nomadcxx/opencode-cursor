import { createLogger } from "../utils/logger";
import type { OpenCodeTool } from "./discovery";
import type { ExecutionResult } from "./core/types.js";
import { isInterceptableToolName } from "../kilo/platform.js";

const log = createLogger("tools:router");

export interface ToolCallEvent {
  type: "tool_call";
  call_id?: string;
  tool_call_id?: string;
  tool_call?: Record<string, { args?: any }>;
  name?: string;
}

export interface ToolResultChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: Array<{ index: number; delta: any; finish_reason: string | null }>;
}

export interface RouterContext {
  execute: (toolId: string, args: Record<string, unknown>) => Promise<ExecutionResult>;
  toolsByName: Map<string, OpenCodeTool>;
  resolveName?: (name: string) => string | undefined;
}

export class ToolRouter {
  private ctx: RouterContext;

  constructor(ctx: RouterContext) {
    this.ctx = ctx;
  }

  isOpenCodeTool(name: string | undefined): boolean {
    if (!name) return false;
    // oc_* prefix (same convention as OpenCode/Kilo fork)
    if (name.startsWith("oc_")) return true;
    // Native Kilo tools: read, glob, websearch, MCP server_tool, etc.
    if (isInterceptableToolName(name)) return true;
    return this.ctx.toolsByName.has(name);
  }

  async handleToolCall(event: ToolCallEvent, meta: { id: string; created: number; model: string }): Promise<ToolResultChunk | null> {
    const callId = event.call_id || event.tool_call_id || "unknown";
    let name = event.name || this.inferName(event);
    if (!this.isOpenCodeTool(name)) return null;

    if (this.ctx.resolveName) {
      const resolved = this.ctx.resolveName(name!);
      if (resolved) {
        name = resolved;
      }
    }

    const tool = this.ctx.toolsByName.get(name!) ?? this.ctx.toolsByName.get(name!.replace(/^oc_/, ""));
    if (!tool) {
      log.warn("Unknown tool call", { name });
      return this.buildResult(meta, callId, name!, { status: "error", error: `Unknown tool ${name}` });
    }

    const args = this.extractArgs(event);
    log.debug("Executing tool via Kilo", { name, toolId: tool.id });
    const t0 = Date.now();
    const result = await this.ctx.execute(tool.id, args);
    const elapsed = Date.now() - t0;
    if (result.status === "error") {
      log.warn("Tool execution returned error", { name, error: result.error, elapsed });
    } else {
      log.debug("Tool execution completed", { name, toolId: tool.id, elapsed });
    }
    return this.buildResult(meta, callId, name!, result);
  }

  private extractArgs(event: ToolCallEvent): any {
    if (event.tool_call) {
      const [key] = Object.keys(event.tool_call);
      return event.tool_call[key]?.args || {};
    }
    return (event as any).arguments || {};
  }

  private inferName(event: ToolCallEvent): string | undefined {
    if (event.tool_call) {
      const [key] = Object.keys(event.tool_call);
      return key;
    }
    return undefined;
  }

  private buildResult(meta: { id: string; created: number; model: string }, callId: string, name: string, result: { status: string; output?: string; error?: string }): ToolResultChunk {
    const delta: any = {
      role: "assistant",
      tool_calls: [
        {
          id: callId,
          type: "function",
          function: {
            name,
            arguments: "{}",
          },
        },
      ],
    };

    const content = result.status === "success" ? result.output ?? "" : (result.error || "unknown error");

    delta.tool_calls[0].function.arguments = JSON.stringify({ result: content }).slice(0, 8000);

    return {
      id: meta.id,
      object: "chat.completion.chunk",
      created: meta.created,
      model: meta.model,
      choices: [
        {
          index: 0,
          delta,
          finish_reason: null,
        },
      ],
    };
  }
}
