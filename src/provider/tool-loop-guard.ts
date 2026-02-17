import type { OpenAiToolCall } from "../proxy/tool-loop.js";

type ToolLoopErrorClass =
  | "validation"
  | "not_found"
  | "permission"
  | "timeout"
  | "tool_error"
  | "success"
  | "unknown";

const UNKNOWN_AS_SUCCESS_TOOLS = new Set([
  // Core filesystem tools
  "bash",
  "shell",
  "read",
  "write",
  "edit",
  "grep",
  "ls",
  "glob",
  "stat",
  "mkdir",
  "rm",
  // Web/network tools
  "webfetch",
  // cursor-agent specific tools (passthrough, but should not trigger loop guard)
  // Discovered via tests/experiments/ harness - see docs/cursor-agent-tools.md
  "semsearch",   // semantic code search
  "readlints",   // lint/diagnostic reader
]);

// Exploratory tools that commonly iterate over many files/patterns.
// These are exempt from COARSE fingerprint tracking (tool|errorClass) to allow
// legitimate multi-file exploration. Strict fingerprints (tool|args|errorClass)
// still apply to catch identical repeated failures.
const EXPLORATION_TOOLS = new Set([
  "read",
  "grep",
  "glob",
  "ls",
  "stat",
  "semsearch",
  "bash",
  "shell",
  "webfetch",
]);

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
  evaluateValidation(toolCall: OpenAiToolCall, validationSignature: string): ToolLoopGuardDecision;
  resetFingerprint(fingerprint: string): void;
}

export function parseToolLoopMaxRepeat(
  value: string | undefined,
): { value: number; valid: boolean } {
  if (value === undefined) {
    return { value: 2, valid: true };
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return { value: 2, valid: false };
  }
  return { value: Math.floor(parsed), valid: true };
}

// Coarse fingerprint (tool|errorClass without args) uses a higher multiplier
// to allow legitimate exploration across different files/targets while still
// catching spray-and-pray patterns.
const COARSE_LIMIT_MULTIPLIER = 3;
const EXPLORATION_LIMIT_MULTIPLIER = 5;

export function createToolLoopGuard(
  messages: Array<unknown>,
  maxRepeat: number,
): ToolLoopGuard {
  const coarseMaxRepeat = maxRepeat * COARSE_LIMIT_MULTIPLIER;
  const {
    byCallId,
    latest,
    latestByToolName,
    initialCounts,
    initialCoarseCounts,
    initialValidationCounts,
    initialValidationCoarseCounts,
  } = indexToolLoopHistory(messages);
  const counts = new Map<string, number>(initialCounts);
  const coarseCounts = new Map<string, number>(initialCoarseCounts);
  const validationCounts = new Map<string, number>(initialValidationCounts);
  const validationCoarseCounts = new Map<string, number>(initialValidationCoarseCounts);

  return {
    evaluate(toolCall) {
      const errorClass = normalizeErrorClassForTool(
        toolCall.function.name,
        byCallId.get(toolCall.id)
          ?? latestByToolName.get(toolCall.function.name)
          ?? latest
          ?? "unknown",
      );
      const argShape = deriveArgumentShape(toolCall.function.arguments);
      if (errorClass === "success") {
        // For success paths, only track identical value payloads to avoid blocking
        // legitimate repeated tool usage with different arguments.
        const valueSignature = deriveArgumentValueSignature(toolCall.function.arguments);
        const successFingerprint = `${toolCall.function.name}|values:${valueSignature}|success`;
        const repeatCount = (counts.get(successFingerprint) ?? 0) + 1;
        counts.set(successFingerprint, repeatCount);

        // Exploration tools (read, grep, glob, etc.) get a higher limit because
        // re-reading the same file across turns is legitimate behavior (verifying
        // edits, checking state, etc.). Use 5x multiplier for these tools.
        const isExplorationTool = EXPLORATION_TOOLS.has(
          toolCall.function.name.toLowerCase(),
        );
        const effectiveMaxRepeat = isExplorationTool
          ? maxRepeat * EXPLORATION_LIMIT_MULTIPLIER
          : maxRepeat;

        // Some tools (notably edit/write) can get stuck in "successful" loops where
        // the model keeps re-issuing the same operation with slightly different
        // content (e.g. trailing newline differences). Track a coarse signature for
        // these cases so we can still terminate noisy loops without blocking
        // legitimate multi-step edits (which typically have non-empty old_string).
        const coarseSuccessFingerprint = deriveSuccessCoarseFingerprint(
          toolCall.function.name,
          toolCall.function.arguments,
        );
        const coarseRepeatCount = coarseSuccessFingerprint
          ? (coarseCounts.get(coarseSuccessFingerprint) ?? 0) + 1
          : 0;
        if (coarseSuccessFingerprint) {
          coarseCounts.set(coarseSuccessFingerprint, coarseRepeatCount);
        }
        const coarseTriggered = coarseSuccessFingerprint
          ? coarseRepeatCount > effectiveMaxRepeat
          : false;
        return {
          fingerprint: coarseTriggered ? coarseSuccessFingerprint! : successFingerprint,
          repeatCount: coarseTriggered ? coarseRepeatCount : repeatCount,
          maxRepeat: effectiveMaxRepeat,
          errorClass,
          triggered: repeatCount > effectiveMaxRepeat || coarseTriggered,
          tracked: true,
        };
      }
      const strictFingerprint = `${toolCall.function.name}|${argShape}|${errorClass}`;
      const coarseFingerprint = `${toolCall.function.name}|${errorClass}`;

      return evaluateWithFingerprints(
        toolCall.function.name,
        errorClass,
        strictFingerprint,
        coarseFingerprint,
        counts,
        coarseCounts,
        maxRepeat,
        coarseMaxRepeat,
      );
    },

    evaluateValidation(toolCall, validationSignature) {
      const normalizedSignature = normalizeValidationSignature(validationSignature);
      const strictFingerprint = `${toolCall.function.name}|schema:${normalizedSignature}|validation`;
      const coarseFingerprint = `${toolCall.function.name}|validation`;
      return evaluateWithFingerprints(
        toolCall.function.name,
        "validation",
        strictFingerprint,
        coarseFingerprint,
        validationCounts,
        validationCoarseCounts,
        maxRepeat,
        coarseMaxRepeat,
      );
    },

    resetFingerprint(fingerprint) {
      counts.delete(fingerprint);
      coarseCounts.delete(fingerprint);
      validationCounts.delete(fingerprint);
      validationCoarseCounts.delete(fingerprint);
      const parts = fingerprint.split("|");
      if (parts.length >= 3) {
        const tool = parts[0];
        const errorClass = parts[parts.length - 1];
        coarseCounts.delete(`${tool}|${errorClass}`);
        validationCoarseCounts.delete(`${tool}|${errorClass}`);
      } else if (parts.length === 2) {
        const tool = parts[0];
        const errorClass = parts[1];
        for (const key of counts.keys()) {
          if (key.startsWith(`${tool}|`) && key.endsWith(`|${errorClass}`)) {
            counts.delete(key);
          }
        }
        for (const key of validationCounts.keys()) {
          if (key.startsWith(`${tool}|`) && key.endsWith(`|${errorClass}`)) {
            validationCounts.delete(key);
          }
        }
      }
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
  latestByToolName: Map<string, ToolLoopErrorClass>;
  initialCounts: Map<string, number>;
  initialCoarseCounts: Map<string, number>;
  initialValidationCounts: Map<string, number>;
  initialValidationCoarseCounts: Map<string, number>;
} {
  const { byCallId, latest } = indexToolResultErrorClasses(messages);
  const initialCounts = new Map<string, number>();
  const initialCoarseCounts = new Map<string, number>();
  const initialValidationCounts = new Map<string, number>();
  const initialValidationCoarseCounts = new Map<string, number>();
  const assistantCalls = extractAssistantToolCalls(messages);

  // Build per-tool-name latest errorClass by cross-referencing assistant calls
  // with tool result classifications.  In multi-tool turns (e.g. edit + context_info),
  // the global `latest` may belong to the wrong tool; this map ensures each tool
  // name resolves to the errorClass of *its own* most recent result.
  const latestByToolName = new Map<string, ToolLoopErrorClass>();
  for (const call of assistantCalls) {
    const ec = byCallId.get(call.id);
    if (ec !== undefined) {
      latestByToolName.set(call.name, normalizeErrorClassForTool(call.name, ec));
    }
  }

  for (const call of assistantCalls) {
    const schemaSignature = deriveSchemaValidationSignature(call.name, call.argKeys);
    const errorClass = normalizeErrorClassForTool(
      call.name,
      byCallId.get(call.id) ?? latestByToolName.get(call.name) ?? latest ?? "unknown",
    );

    if (errorClass === "success") {
      incrementCount(
        initialCounts,
        `${call.name}|values:${call.argValueSignature}|success`,
      );
      const coarseSuccessFP = deriveSuccessCoarseFingerprint(
        call.name,
        call.rawArguments,
      );
      if (coarseSuccessFP) {
        incrementCount(initialCoarseCounts, coarseSuccessFP);
      }

      if (schemaSignature) {
        incrementCount(
          initialValidationCounts,
          `${call.name}|schema:${schemaSignature}|validation`,
        );
        incrementCount(initialValidationCoarseCounts, `${call.name}|validation`);
      }
      continue;
    }
    const strictFingerprint = `${call.name}|${call.argShape}|${errorClass}`;
    const coarseFingerprint = `${call.name}|${errorClass}`;
    incrementCount(initialCounts, strictFingerprint);
    incrementCount(initialCoarseCounts, coarseFingerprint);
    if (!schemaSignature) {
      continue;
    }
    incrementCount(
      initialValidationCounts,
      `${call.name}|schema:${schemaSignature}|validation`,
    );
    incrementCount(initialValidationCoarseCounts, `${call.name}|validation`);
  }

  return {
    byCallId,
    latest,
    latestByToolName,
    initialCounts,
    initialCoarseCounts,
    initialValidationCounts,
    initialValidationCoarseCounts,
  };
}

function classifyToolResult(content: unknown): ToolLoopErrorClass {
  const text = toLowerText(content);
  if (!text) {
    return "unknown";
  }

  if (
    containsAny(text, [
      "missing required",
      "missing required argument",
      "invalid",
      "schema",
      "unexpected",
      "type error",
      "must be of type",
    ])
  ) {
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
  if (containsAny(text, ["# todos", "\n[ ] ", "\n[x] ", "\n[x]"])) {
    return "success";
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

function deriveArgumentValueSignature(rawArguments: string): string {
  try {
    const parsed = JSON.parse(rawArguments);
    return hashString(JSON.stringify(canonicalizeValue(parsed)));
  } catch {
    return `invalid:${hashString(rawArguments)}`;
  }
}

function deriveSuccessCoarseFingerprint(toolName: string, rawArguments: string): string | null {
  // Keep this intentionally conservative: only guard noisy success loops for tools
  // that are commonly used for "create/overwrite file" operations.
  const lowered = toolName.toLowerCase();
  if (lowered !== "edit" && lowered !== "write") {
    return null;
  }

  try {
    const parsed = JSON.parse(rawArguments);
    if (!isRecord(parsed)) {
      return null;
    }
    const path = typeof parsed.path === "string" ? parsed.path : "";
    if (!path) {
      return null;
    }

    if (lowered === "edit") {
      const oldString = typeof parsed.old_string === "string" ? parsed.old_string : null;
      // Only treat "full file replace" edits as coarse-success tracked; multi-step
      // edits with a non-empty old_string are common and should not be blocked.
      if (oldString !== "") {
        return null;
      }
    }

    return `${toolName}|path:${hashString(path)}|success`;
  } catch {
    return null;
  }
}

function extractAssistantToolCalls(messages: Array<unknown>): Array<{
  id: string;
  name: string;
  rawArguments: string;
  argShape: string;
  argValueSignature: string;
  argKeys: string[];
}> {
  const calls: Array<{
    id: string;
    name: string;
    rawArguments: string;
    argShape: string;
    argValueSignature: string;
    argKeys: string[];
  }> = [];
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
        rawArguments,
        argShape: deriveArgumentShape(rawArguments),
        argValueSignature: deriveArgumentValueSignature(rawArguments),
        argKeys: extractArgumentKeys(rawArguments),
      });
    }
  }
  return calls;
}

function extractArgumentKeys(rawArguments: string): string[] {
  try {
    const parsed = JSON.parse(rawArguments);
    if (!isRecord(parsed)) {
      return [];
    }
    return Object.keys(parsed);
  } catch {
    return [];
  }
}

function deriveSchemaValidationSignature(toolName: string, argKeys: string[]): string | null {
  if (toolName !== "edit") {
    return null;
  }
  const argKeySet = new Set(argKeys);
  const required = ["path", "old_string", "new_string"];
  const missing = required.filter((key) => !argKeySet.has(key));
  if (missing.length === 0) {
    return null;
  }
  return `missing:${missing.join(",")}`;
}

function normalizeValidationSignature(signature: string): string {
  const normalized = signature.trim().toLowerCase();
  return normalized.length > 0 ? normalized : "invalid";
}

function evaluateWithFingerprints(
  toolName: string,
  errorClass: ToolLoopErrorClass,
  strictFingerprint: string,
  coarseFingerprint: string,
  strictCounts: Map<string, number>,
  coarseCounts: Map<string, number>,
  maxRepeat: number,
  coarseMaxRepeat: number,
): ToolLoopGuardDecision {
  if (errorClass === "success") {
    return {
      fingerprint: strictFingerprint,
      repeatCount: 0,
      maxRepeat,
      errorClass,
      triggered: false,
      tracked: false,
    };
  }

  const strictRepeatCount = (strictCounts.get(strictFingerprint) ?? 0) + 1;
  strictCounts.set(strictFingerprint, strictRepeatCount);
  const strictTriggered = strictRepeatCount > maxRepeat;

  const isExplorationTool = EXPLORATION_TOOLS.has(toolName.toLowerCase());
  if (isExplorationTool) {
    return {
      fingerprint: strictFingerprint,
      repeatCount: strictRepeatCount,
      maxRepeat,
      errorClass,
      triggered: strictTriggered,
      tracked: true,
    };
  }

  const coarseRepeatCount = (coarseCounts.get(coarseFingerprint) ?? 0) + 1;
  coarseCounts.set(coarseFingerprint, coarseRepeatCount);
  const coarseTriggered = coarseRepeatCount > coarseMaxRepeat;
  const preferCoarseFingerprint = coarseTriggered && !strictTriggered;
  return {
    fingerprint: preferCoarseFingerprint ? coarseFingerprint : strictFingerprint,
    repeatCount: preferCoarseFingerprint ? coarseRepeatCount : strictRepeatCount,
    maxRepeat: preferCoarseFingerprint ? coarseMaxRepeat : maxRepeat,
    errorClass,
    triggered: strictTriggered || coarseTriggered,
    tracked: true,
  };
}

function incrementCount(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
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

function canonicalizeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalizeValue(entry));
  }
  if (isRecord(value)) {
    const canonical: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      canonical[key] = canonicalizeValue(value[key]);
    }
    return canonical;
  }
  return value;
}

function hashString(value: string): string {
  // FNV-1a 32-bit hash is stable and cheap for loop-guard fingerprints.
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function normalizeErrorClassForTool(
  toolName: string,
  errorClass: ToolLoopErrorClass,
): ToolLoopErrorClass {
  if (
    errorClass === "unknown"
    && UNKNOWN_AS_SUCCESS_TOOLS.has(toolName.toLowerCase())
  ) {
    return "success";
  }
  return errorClass;
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
