import { randomUUID } from "node:crypto";
import { parseStreamJsonLine } from "../streaming/parser.js";
import { MixedDeltaTracker } from "../streaming/delta-tracker.js";
import {
  extractText,
  isAssistantText,
  isPartialStreamDelta,
  type StreamJsonAssistantEvent,
} from "../streaming/types.js";
import type { OpenAiToolCall } from "./tool-loop.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("proxy:bridge-json");

export const BRIDGE_JSON_ENV = "CURSOR_ACP_BRIDGE_JSON";

export const BRIDGE_JSON_CONTEXT = `SYSTEM: opencode bridge mode is active.
For file changes through opencode-cursor, read any needed files first, then respond with exactly one JSON object and no prose:
{"name":"write","arguments":{"path":"relative/path","content":"complete file contents"}}
Use this only for a single complete-file write. Otherwise answer normally or use the available tool format.`;

const TASK_BRIDGE_JSON_CONTEXT = `SYSTEM: OpenCode Task bridge mode is active.
For Task only, the exact envelope below overrides the earlier generic "standard OpenAI tool_call" instruction. Do not add id, type, or function fields, and do not stringify arguments.
OpenCode owns the task tool. Do not invoke Cursor's built-in Task tool; it uses a different subagent list. To call OpenCode's task tool, respond with one JSON object, or one JSON array of those objects to dispatch several tasks in parallel, and no prose:
{"name":"task","arguments":{"description":"3-5 words","prompt":"task details","subagent_type":"one name listed in the OpenCode task description"}}
[{"name":"task","arguments":{"description":"first task","prompt":"details","subagent_type":"explore"}},{"name":"task","arguments":{"description":"second task","prompt":"details","subagent_type":"general"}}]
Use this only when delegating through OpenCode. Otherwise answer normally.`;

type BridgePromptOptions = {
  allowedToolNames: Set<string>;
  env?: Record<string, string | undefined>;
};

export type BridgeStreamDecision =
  | { action: "buffer" }
  | { action: "passthrough"; text?: string }
  | { action: "tool_call"; toolCalls: OpenAiToolCall[] };

export class BridgeJsonStreamDetector {
  private state: "undecided" | "candidate" | "passthrough" = "undecided";
  private buffer = "";
  private readonly tracker = new MixedDeltaTracker();

  constructor(
    private readonly allowedToolNames: Set<string>,
    private readonly writeSchema?: unknown,
  ) {}

  push(event: StreamJsonAssistantEvent): BridgeStreamDecision {
    const text = extractText(event);
    const delta = this.tracker.nextText(text, isPartialStreamDelta(event));
    if (!delta) {
      return this.state === "passthrough"
        ? { action: "passthrough" }
        : { action: "buffer" };
    }
    if (this.state === "passthrough") {
      return { action: "passthrough" };
    }

    const hadBufferedText = this.buffer.length > 0;
    this.buffer += delta;

    if (this.state === "undecided") {
      const meaningful = this.buffer.trimStart();
      if (!meaningful || /^(`{1,2}|\[\s*)$/.test(meaningful)) {
        return { action: "buffer" };
      }
      // `[` alone is common prose (markdown links); only `[{` starts an envelope array.
      if (/^(\{|```|\[\s*\{)/.test(meaningful)) {
        this.state = "candidate";
      } else {
        const withheld = this.buffer;
        this.buffer = "";
        this.state = "passthrough";
        return hadBufferedText
          ? { action: "passthrough", text: withheld }
          : { action: "passthrough" };
      }
    }

    const trimmed = this.buffer.trimStart();
    if (trimmed.startsWith("```")) {
      const infoLineEnd = trimmed.indexOf("\n", 3);
      if (infoLineEnd < 0) {
        return { action: "buffer" };
      }
      const info = trimmed.slice(3, infoLineEnd).trim();
      if (info && info.toLowerCase() !== "json") {
        return this.releaseBuffer();
      }
    }

    // ponytail: bridge responses are small; reparse the accumulated candidate.
    // If envelopes become large, replace this O(n²) path with an incremental parser.
    const toolCalls = extractBridgeToolCallsFromText(
      this.buffer,
      this.allowedToolNames,
      this.writeSchema,
    );
    if (toolCalls) {
      this.buffer = "";
      this.state = "passthrough";
      return { action: "tool_call", toolCalls };
    }

    if (containsCompleteJson(this.buffer)) {
      return this.releaseBuffer();
    }
    return { action: "buffer" };
  }

  flush(): string {
    if (this.state === "passthrough" || !this.buffer) {
      return "";
    }
    const text = this.buffer;
    this.buffer = "";
    this.state = "passthrough";
    return text;
  }

  reset(): void {
    this.state = "undecided";
    this.buffer = "";
    this.tracker.reset();
  }

  private releaseBuffer(): BridgeStreamDecision {
    const text = this.buffer;
    this.buffer = "";
    this.state = "passthrough";
    return { action: "passthrough", text };
  }
}

export function isBridgeJsonEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const raw = env[BRIDGE_JSON_ENV];
  if (raw === undefined) {
    return true;
  }

  return !["0", "false", "off", "no", "disabled"].includes(raw.trim().toLowerCase());
}

export function applyBridgeJsonPrompt(prompt: string, options: BridgePromptOptions): string {
  if (!isBridgeJsonEnabled(options.env)) {
    return prompt;
  }

  let result = prompt;
  if (
    resolveAllowedWriteToolName(options.allowedToolNames)
    && !result.includes("opencode bridge mode is active")
  ) {
    result = result ? `${BRIDGE_JSON_CONTEXT}\n\n${result}` : BRIDGE_JSON_CONTEXT;
  }
  if (
    options.allowedToolNames.has("task")
    && !result.includes("OpenCode Task bridge mode is active")
  ) {
    result = result ? `${result}\n\n${TASK_BRIDGE_JSON_CONTEXT}` : TASK_BRIDGE_JSON_CONTEXT;
  }
  return result;
}

export function extractBridgeToolCallsFromText(
  text: string,
  allowedToolNames: Set<string>,
  writeSchema?: unknown,
): OpenAiToolCall[] | null {
  const jsonText = extractStrictJsonText(text);
  if (!jsonText) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }

  // Random, not content-derived: a retried identical envelope must not reuse earlier call ids.
  const id = `call_bridge_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  if (!Array.isArray(parsed)) {
    const toolCall = buildBridgeToolCall(parsed, id, allowedToolNames, writeSchema);
    return toolCall ? [toolCall] : null;
  }
  const toolCalls = parsed.map((entry, i) =>
    buildBridgeToolCall(entry, `${id}_${i}`, allowedToolNames, writeSchema));
  if (toolCalls.length > 0 && toolCalls.every((call): call is OpenAiToolCall => call !== null)) {
    return toolCalls;
  }
  const rejectedIndex = toolCalls.indexOf(null);
  log.warn("Dropping bridge JSON array; passing it through as text", {
    envelopeCount: parsed.length,
    rejectedIndex,
    rejectedName: isRecord(parsed[rejectedIndex]) ? parsed[rejectedIndex].name : undefined,
  });
  return null;
}

function buildBridgeToolCall(
  parsed: unknown,
  id: string,
  allowedToolNames: Set<string>,
  writeSchema: unknown,
): OpenAiToolCall | null {
  if (!isRecord(parsed) || !isRecord(parsed.arguments)) {
    return null;
  }

  if (parsed.name === "task") {
    return allowedToolNames.has("task")
      ? buildTaskToolCall(id, parsed.arguments)
      : null;
  }

  const writeToolName = resolveAllowedWriteToolName(allowedToolNames);
  if (parsed.name !== "write" || !writeToolName) {
    return null;
  }

  const { path } = parsed.arguments;
  const content = typeof parsed.arguments.content === "string"
    ? parsed.arguments.content
    : parsed.arguments.contents;
  if (typeof path !== "string" || path.trim().length === 0 || typeof content !== "string") {
    return null;
  }

  return {
    id,
    type: "function",
    function: {
      name: writeToolName,
      arguments: JSON.stringify(buildWriteArguments(path, content, writeSchema)),
    },
  };
}

function buildTaskToolCall(
  id: string,
  args: Record<string, unknown>,
): OpenAiToolCall | null {
  if (
    !isNonEmptyString(args.description)
    || !isNonEmptyString(args.prompt)
    || !isNonEmptyString(args.subagent_type)
    || (args.task_id !== undefined && typeof args.task_id !== "string")
    || (args.command !== undefined && typeof args.command !== "string")
  ) {
    return null;
  }

  return {
    id,
    type: "function",
    function: {
      name: "task",
      arguments: JSON.stringify(args),
    },
  };
}

export function extractBridgeToolCallsFromStreamOutput(
  output: string,
  allowedToolNames: Set<string>,
  writeSchema?: unknown,
): OpenAiToolCall[] | null {
  if (!output) {
    return null;
  }

  const detector = new BridgeJsonStreamDetector(allowedToolNames, writeSchema);
  for (const line of output.split("\n")) {
    const event = parseStreamJsonLine(line);
    if (!event) {
      continue;
    }
    if (isAssistantText(event)) {
      const decision = detector.push(event);
      if (decision.action === "tool_call") {
        return decision.toolCalls;
      }
    } else if (event.type === "tool_call") {
      detector.reset();
    }
  }

  return null;
}

function buildWriteArguments(path: string, content: string, writeSchema: unknown): Record<string, string> {
  if (isRecord(writeSchema) && isRecord(writeSchema.properties)) {
    const properties = writeSchema.properties;
    const required = Array.isArray(writeSchema.required)
      ? writeSchema.required.filter((value): value is string => typeof value === "string")
      : [];
    if (required.includes("filePath") || ("filePath" in properties && !("path" in properties))) {
      return { filePath: path, content };
    }
  }

  return { path, content };
}

function resolveAllowedWriteToolName(allowedToolNames: Set<string>): string | null {
  if (allowedToolNames.has("write")) {
    return "write";
  }
  if (allowedToolNames.has("oc_write")) {
    return "oc_write";
  }
  return null;
}

function extractStrictJsonText(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }
  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}"))
    || (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    return trimmed;
  }

  const fenced = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i);
  return fenced ? fenced[1].trim() : null;
}

function containsCompleteJson(text: string): boolean {
  const jsonText = extractStrictJsonText(text);
  if (!jsonText) {
    return false;
  }
  try {
    JSON.parse(jsonText);
    return true;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
