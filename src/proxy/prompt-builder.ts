import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../utils/logger.js";

const log = createLogger("proxy:prompt-builder");

// Debug log file for tool-loop investigation
const DEBUG_LOG_DIR = join(homedir(), ".config", "opencode", "logs");
const DEBUG_LOG_FILE = join(DEBUG_LOG_DIR, "tool-loop-debug.log");

function ensureLogDir(): void {
  try {
    if (!existsSync(DEBUG_LOG_DIR)) {
      mkdirSync(DEBUG_LOG_DIR, { recursive: true });
    }
  } catch {
    // Ignore errors creating log directory
  }
}

function debugLogToFile(message: string, data: any): void {
  try {
    ensureLogDir();
    const timestamp = new Date().toISOString();
    const logLine = `[${timestamp}] ${message}: ${JSON.stringify(data, null, 2)}\n`;
    appendFileSync(DEBUG_LOG_FILE, logLine);
  } catch (err) {
    // Fall back to regular debug log if file writing fails
    log.debug(message, data);
  }
}

/**
 * Build a text prompt from OpenAI chat messages + tool definitions.
 * Handles role:"tool" result messages and assistant tool_calls that
 * plain text flattening would silently drop.
 */
export function buildPromptFromMessages(messages: Array<any>, tools: Array<any>): string {
  // DEBUG: Log incoming message structure to file for root cause analysis
  const messageSummary = messages.map((m: any, i: number) => {
    const role = m?.role ?? "?";
    const hasToolCalls = Array.isArray(m?.tool_calls) ? m.tool_calls.length : 0;
    const tcNames = hasToolCalls > 0 ? m.tool_calls.map((tc: any) => tc?.function?.name).join(",") : "";
    const contentType = typeof m?.content;
    const contentLen = typeof m?.content === "string" ? m.content.length : Array.isArray(m?.content) ? `arr:${m.content.length}` : "null";
    const toolCallId = m?.tool_call_id ?? null;
    return { i, role, hasToolCalls, tcNames, contentType, contentLen, toolCallId };
  });

  const assistantWithToolCalls = messages.filter((m: any) => m?.role === "assistant" && Array.isArray(m?.tool_calls) && m.tool_calls.length > 0);
  const assistantEmpty = messages.filter((m: any) => m?.role === "assistant" && (!m?.tool_calls || m.tool_calls.length === 0) && (!m?.content || m.content === "" || m.content === null));
  const toolResults = messages.filter((m: any) => m?.role === "tool");

  debugLogToFile("buildPromptFromMessages", {
    totalMessages: messages.length,
    totalTools: tools.length,
    messageSummary,
    stats: {
      assistantWithToolCalls: assistantWithToolCalls.length,
      assistantEmpty: assistantEmpty.length,
      toolResults: toolResults.length,
    },
    assistantDetails: assistantWithToolCalls.length > 0 ? assistantWithToolCalls.map((m: any, i: number) => ({
      index: i,
      toolCallCount: Array.isArray(m?.tool_calls) ? m.tool_calls.length : 0,
      toolCallIds: Array.isArray(m?.tool_calls) ? m.tool_calls.map((tc: any) => tc?.id).join(",") : "",
      toolCallNames: Array.isArray(m?.tool_calls) ? m.tool_calls.map((tc: any) => tc?.function?.name).join(",") : "",
      contentType: typeof m?.content,
      contentPreview: typeof m?.content === "string" ? m.content.slice(0, 50) : typeof m?.content,
    })) : [],
    emptyAssistantDetails: assistantEmpty.length > 0 ? assistantEmpty.map((m: any, i: number) => ({
      index: i,
      contentType: typeof m?.content,
      contentPreview: typeof m?.content === "string" ? m.content.slice(0, 50) : typeof m?.content,
    })) : [],
    toolResultDetails: toolResults.length > 0 ? toolResults.map((m: any, i: number) => ({
      index: i,
      toolCallId: m?.tool_call_id,
      contentPreview: typeof m?.content === "string" ? m.content.slice(0, 100) : typeof m?.content,
    })) : [],
  });

  const lines: string[] = [];

  if (tools.length > 0) {
    const toolDescs = tools
      .map((t: any) => {
        const fn = t.function || t;
        const name = fn.name || "unknown";
        const desc = fn.description || "";
        const params = fn.parameters;
        const paramStr = params ? JSON.stringify(params) : "{}";
        return `- ${name}: ${desc}\n  Parameters: ${paramStr}`;
      })
      .join("\n");
    lines.push(
      `SYSTEM: You have access to the following tools. When you need to use one, respond with a tool_call in the standard OpenAI format.\n` +
        `Tool guidance: prefer write/edit for file changes; use bash mainly to run commands/tests.\n\nAvailable tools:\n${toolDescs}`,
    );
  }

  for (const message of messages) {
    const role = typeof message.role === "string" ? message.role : "user";

    // tool result messages (from multi-turn tool execution loop)
    if (role === "tool") {
      const callId = message.tool_call_id || "unknown";
      const body =
        typeof message.content === "string"
          ? message.content
          : JSON.stringify(message.content ?? "");
      lines.push(`TOOL_RESULT (call_id: ${callId}): ${body}`);
      continue;
    }

    // assistant messages that contain tool_calls (previous turn's tool invocations)
    if (
      role === "assistant" &&
      Array.isArray(message.tool_calls) &&
      message.tool_calls.length > 0
    ) {
      const tcTexts = message.tool_calls.map((tc: any) => {
        const fn = tc.function || {};
        return `tool_call(id: ${tc.id || "?"}, name: ${fn.name || "?"}, args: ${fn.arguments || "{}"})`;
      });
      const text = typeof message.content === "string" ? message.content : "";
      lines.push(`ASSISTANT: ${text ? text + "\n" : ""}${tcTexts.join("\n")}`);
      continue;
    }

    // standard text messages
    const content = message.content;
    if (typeof content === "string") {
      lines.push(`${role.toUpperCase()}: ${content}`);
    } else if (Array.isArray(content)) {
      const textParts = content
        .map((part: any) => {
          if (part && typeof part === "object" && part.type === "text" && typeof part.text === "string") {
            return part.text;
          }
          return "";
        })
        .filter(Boolean);
      if (textParts.length) {
        lines.push(`${role.toUpperCase()}: ${textParts.join("\n")}`);
      }
    }
  }

  // Add continuation suffix after tool results to anchor model on completed state
  const hasToolResults = messages.some((m: any) => m?.role === "tool");
  if (hasToolResults) {
    lines.push(
      "The above tool calls have been executed. Continue your response based on these results."
    );
  }

  // DEBUG: Log the final prompt structure
  const finalPrompt = lines.join("\n\n");
  debugLogToFile("buildPromptFromMessages: final prompt", {
    lineCount: lines.length,
    promptLength: finalPrompt.length,
    promptPreview: finalPrompt.slice(0, 500),
    hasToolResultFormat: finalPrompt.includes("TOOL_RESULT"),
    hasAssistantToolCallFormat: finalPrompt.includes("tool_call(id:"),
    hasCompletionSignal: finalPrompt.includes("Based on the tool results"),
  });

  return finalPrompt;
}