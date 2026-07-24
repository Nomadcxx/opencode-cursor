import { createHash } from "node:crypto";
import { buildToolSchemaMap, applyToolSchemaCompat, tryRerouteEditToWrite } from "../provider/tool-schema-compat.js";
import type { OpenAiToolCall } from "./tool-loop.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("proxy:prompt-builder");

// Cache the tool schema block — tools don't change between requests in a session.
let _cachedToolFingerprint = "";
let _cachedToolBlock = "";

/** Clear cached tool schema block (for testing only). */
export function _resetToolSchemaCache(): void {
  _cachedToolFingerprint = "";
  _cachedToolBlock = "";
}

/** Short, collision-resistant digest used in the tool schema fingerprint. */
function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

/** Build a compact fingerprint of the tool schema for cache validation. */
export function buildToolFingerprint(tools: Array<any>): string {
  if (tools.length === 0) return "";
  // Include names + descriptions + parameter names + required fields to detect
  // schema changes without the cost of full JSON.stringify on every request.
  // The description is hashed (not length-only) so edits that preserve length
  // still invalidate the cache; required is copied before sorting so the
  // caller's schema array is not mutated in place.
  const parts = tools.map((t: any) => {
    const fn = t.function || t;
    const name = fn.name || "?";
    const desc = fn.description || "";
    const paramProps = fn.parameters?.properties || {};
    const paramKeys = Object.keys(paramProps).sort().join(",");
    const required = [...(fn.parameters?.required || [])].sort().join(",");
    return `${name}:${shortHash(desc)}:${paramKeys}:${required}`;
  });
  parts.sort();
  return `${parts.length}:${parts.join("|")}`;
}

function buildToolSchemaBlock(tools: Array<any>): string {
  const fingerprint = buildToolFingerprint(tools);
  if (fingerprint && fingerprint === _cachedToolFingerprint) {
    return _cachedToolBlock;
  }

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

  const block =
    `SYSTEM: You have access to the following tools. When you need to use one, respond with a tool_call in the standard OpenAI format.\n` +
    `Tool guidance: prefer write/edit for file changes; use bash mainly to run commands/tests.\n\nAvailable tools:\n${toolDescs}`;

  if (fingerprint) {
    _cachedToolFingerprint = fingerprint;
    _cachedToolBlock = block;
  }

  return block;
}

function formatToolResult(callId: string, name: string | undefined, body: string): string {
  return name
    ? `TOOL_RESULT (name: ${name}, call_id: ${callId}): ${body}`
    : `TOOL_RESULT (call_id: ${callId}): ${body}`;
}

function formatAssistantToolCall(
  tc: any,
  allowedToolNames: Set<string>,
  toolSchemaMap: Map<string, unknown>,
): { text: string; name: string } {
  const fn = tc.function || {};
  let name = fn.name || "?";
  let args = fn.arguments || "{}";

  if (typeof fn.name === "string" && typeof fn.arguments === "string") {
    const toolCall: OpenAiToolCall = {
      id: tc.id || "call_unknown",
      type: "function",
      function: {
        name: fn.name,
        arguments: fn.arguments,
      },
    };
    const compat = applyToolSchemaCompat(toolCall, toolSchemaMap);
    const rerouted = tryRerouteEditToWrite(compat.toolCall, compat, allowedToolNames, toolSchemaMap);
    if (rerouted) {
      name = rerouted.function.name;
      args = rerouted.function.arguments;
    }
  }

  return {
    text: `tool_call(id: ${tc.id || "?"}, name: ${name}, args: ${args})`,
    name,
  };
}

/**
 * Build a text prompt from OpenAI chat messages + tool definitions.
 * Handles role:"tool" result messages and assistant tool_calls that
 * plain text flattening would silently drop.
 */
export function buildPromptFromMessages(messages: Array<any>, tools: Array<any>): string {
  if (log.isDebugEnabled()) {
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

    log.debug("buildPromptFromMessages", {
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
        name: m?.name,
        contentPreview: typeof m?.content === "string" ? m.content.slice(0, 100) : typeof m?.content,
      })) : [],
    });
  }

  const lines: string[] = [];
  const toolCallNames = new Map<string, string>();
  const allowedToolNames = new Set(
    tools
      .map((t: any) => t?.function?.name ?? t?.name)
      .filter((name: unknown): name is string => typeof name === "string" && name.length > 0),
  );
  const toolSchemaMap = buildToolSchemaMap(tools);

  if (tools.length > 0) {
    lines.push(buildToolSchemaBlock(tools));
  }

  for (const message of messages) {
    const role = typeof message.role === "string" ? message.role : "user";

    // tool result messages (from multi-turn tool execution loop)
    if (role === "tool") {
      const callId = message.tool_call_id || "unknown";
      const name = typeof message.name === "string" && message.name ? message.name : toolCallNames.get(callId);
      const body =
        typeof message.content === "string"
          ? message.content
          : JSON.stringify(message.content ?? "");
      lines.push(formatToolResult(callId, name, body));
      continue;
    }

    // assistant messages that contain tool_calls (previous turn's tool invocations)
    if (
      role === "assistant" &&
      Array.isArray(message.tool_calls) &&
      message.tool_calls.length > 0
    ) {
      const tcTexts = message.tool_calls.map((tc: any) => {
        const formatted = formatAssistantToolCall(tc, allowedToolNames, toolSchemaMap);
        if (tc.id && formatted.name && formatted.name !== "?") {
          toolCallNames.set(tc.id, formatted.name);
        }
        return formatted.text;
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

  const finalPrompt = lines.join("\n\n");
  log.debug("buildPromptFromMessages: final prompt", {
    lineCount: lines.length,
    promptLength: finalPrompt.length,
    promptPreview: finalPrompt.slice(0, 500),
    hasToolResultFormat: finalPrompt.includes("TOOL_RESULT"),
    hasAssistantToolCallFormat: finalPrompt.includes("tool_call(id:"),
    hasCompletionSignal: finalPrompt.includes("The above tool calls have been executed"),
  });

  return finalPrompt;
}
