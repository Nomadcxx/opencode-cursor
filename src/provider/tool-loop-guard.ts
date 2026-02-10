import type { OpenAiToolCall } from "../proxy/tool-loop.js";

type ToolLoopErrorClass =
  | "validation"
  | "not_found"
  | "permission"
  | "timeout"
  | "tool_error"
  | "success"
  | "unknown";

export interface ToolLoopGuardDecision {
  fingerprint: string;
  repeatCount: number;
  maxRepeat: number;
  errorClass: ToolLoopErrorClass;
  triggered: boolean;
  tracked: boolean;
}

export interface ToolLoopGuard {
  evaluate(toolCall: OpenAiToolCall): ToolLoopGuardDecision;
  resetFingerprint(fingerprint: string): void;
}

export function parseToolLoopMaxRepeat(
  value: string | undefined,
): { value: number; valid: boolean } {
  if (value === undefined) {
    return { value: 3, valid: true };
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return { value: 3, valid: false };
  }
  return { value: Math.floor(parsed), valid: true };
}

export function createToolLoopGuard(
  messages: Array<unknown>,
  maxRepeat: number,
): ToolLoopGuard {
  const { byCallId, latest, initialCounts } = indexToolLoopHistory(messages);
  const counts = new Map<string, number>(initialCounts);

  return {
    evaluate(toolCall) {
      const errorClass = byCallId.get(toolCall.id) ?? latest ?? "unknown";
      const argShape = deriveArgumentShape(toolCall.function.arguments);
      const fingerprint = `${toolCall.function.name}|${argShape}|${errorClass}`;

      if (errorClass === "success") {
        return {
          fingerprint,
          repeatCount: 0,
          maxRepeat,
          errorClass,
          triggered: false,
          tracked: false,
        };
      }

      const repeatCount = (counts.get(fingerprint) ?? 0) + 1;
      counts.set(fingerprint, repeatCount);
      return {
        fingerprint,
        repeatCount,
        maxRepeat,
        errorClass,
        triggered: repeatCount > maxRepeat,
        tracked: true,
      };
    },

    resetFingerprint(fingerprint) {
      counts.delete(fingerprint);
    },
  };
}

function indexToolResultErrorClasses(messages: Array<unknown>): {
  byCallId: Map<string, ToolLoopErrorClass>;
  latest: ToolLoopErrorClass | null;
} {
  const byCallId = new Map<string, ToolLoopErrorClass>();
  let latest: ToolLoopErrorClass | null = null;

  for (const message of messages) {
    if (!isRecord(message) || message.role !== "tool") {
      continue;
    }

    const errorClass = classifyToolResult(message.content);
    latest = errorClass;

    const callId =
      typeof message.tool_call_id === "string" && message.tool_call_id.length > 0
        ? message.tool_call_id
        : null;
    if (callId) {
      byCallId.set(callId, errorClass);
    }
  }

  return { byCallId, latest };
}

function indexToolLoopHistory(messages: Array<unknown>): {
  byCallId: Map<string, ToolLoopErrorClass>;
  latest: ToolLoopErrorClass | null;
  initialCounts: Map<string, number>;
} {
  const { byCallId, latest } = indexToolResultErrorClasses(messages);
  const initialCounts = new Map<string, number>();
  const assistantCalls = extractAssistantToolCalls(messages);

  for (const call of assistantCalls) {
    const errorClass = byCallId.get(call.id) ?? latest ?? "unknown";
    if (errorClass === "success") {
      continue;
    }
    const fingerprint = `${call.name}|${call.argShape}|${errorClass}`;
    initialCounts.set(fingerprint, (initialCounts.get(fingerprint) ?? 0) + 1);
  }

  return { byCallId, latest, initialCounts };
}

function classifyToolResult(content: unknown): ToolLoopErrorClass {
  const text = toLowerText(content);
  if (!text) {
    return "unknown";
  }

  if (containsAny(text, ["missing required", "missing", "invalid", "schema", "unexpected", "type error"])) {
    return "validation";
  }
  if (containsAny(text, ["enoent", "not found", "no such file"])) {
    return "not_found";
  }
  if (containsAny(text, ["permission denied", "eacces", "forbidden"])) {
    return "permission";
  }
  if (containsAny(text, ["timeout", "timed out"])) {
    return "timeout";
  }
  if (containsAny(text, ["success", "completed", "\"ok\":true", "\"success\":true"])) {
    return "success";
  }
  if (containsAny(text, ["error", "failed", "\"is_error\":true", "\"success\":false"])) {
    return "tool_error";
  }

  return "unknown";
}

function deriveArgumentShape(rawArguments: string): string {
  try {
    const parsed = JSON.parse(rawArguments);
    return JSON.stringify(shapeOf(parsed));
  } catch {
    return "invalid_json";
  }
}

function extractAssistantToolCalls(messages: Array<unknown>): Array<{
  id: string;
  name: string;
  argShape: string;
}> {
  const calls: Array<{ id: string; name: string; argShape: string }> = [];
  for (const message of messages) {
    if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.tool_calls)) {
      continue;
    }
    for (const call of message.tool_calls) {
      if (!isRecord(call)) {
        continue;
      }
      const id = typeof call.id === "string" ? call.id : "";
      const fn = isRecord(call.function) ? call.function : null;
      const name = fn && typeof fn.name === "string" ? fn.name : "";
      const rawArguments =
        fn && typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn?.arguments ?? {});
      if (!id || !name) {
        continue;
      }
      calls.push({
        id,
        name,
        argShape: deriveArgumentShape(rawArguments),
      });
    }
  }
  return calls;
}

function shapeOf(value: unknown): unknown {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return ["empty"];
    }
    return [shapeOf(value[0])];
  }
  if (isRecord(value)) {
    const shaped: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      shaped[key] = shapeOf(value[key]);
    }
    return shaped;
  }
  if (value === null) {
    return "null";
  }
  return typeof value;
}

function toLowerText(content: unknown): string {
  const rendered = renderContent(content);
  return rendered.trim().toLowerCase();
}

function renderContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }
        if (isRecord(part) && typeof part.text === "string") {
          return part.text;
        }
        return JSON.stringify(part);
      })
      .join(" ");
  }
  if (content === null || content === undefined) {
    return "";
  }
  return JSON.stringify(content);
}

function containsAny(text: string, patterns: string[]): boolean {
  return patterns.some((pattern) => text.includes(pattern));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
