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
import { applyToolSchemaCompat } from "../provider/tool-schema-compat.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("proxy:bridge-json");

export const BRIDGE_JSON_ENV = "CURSOR_ACP_BRIDGE_JSON";

export const BRIDGE_JSON_CONTEXT = `SYSTEM: opencode bridge mode is active.
For file changes through opencode-cursor, read any needed files first, then respond with exactly one JSON object and no prose:
{"name":"write","arguments":{"path":"relative/path","content":"complete file contents"}}
Use this only for a single complete-file write. Otherwise answer normally or use the available tool format.`;

// OpenCode 1.x offers `task` (subagent_type); OpenCode 2.0 renamed it `subagent` (agent).
type TaskToolName = "task" | "subagent";

function taskAgentField(toolName: TaskToolName): "subagent_type" | "agent" {
  return toolName === "task" ? "subagent_type" : "agent";
}

function resolveTaskToolName(allowedToolNames: Set<string>): TaskToolName | null {
  if (allowedToolNames.has("task")) {
    return "task";
  }
  return allowedToolNames.has("subagent") ? "subagent" : null;
}

function taskBridgeContext(toolName: TaskToolName): string {
  const agent = taskAgentField(toolName);
  return `SYSTEM: OpenCode Task bridge mode is active.
For ${toolName} only, the exact envelope below overrides the earlier generic "standard OpenAI tool_call" instruction. Do not add id, type, or function fields, and do not stringify arguments.
OpenCode owns the ${toolName} tool. Do not invoke Cursor's built-in Task tool; it uses a different subagent list. To call OpenCode's ${toolName} tool, respond with one JSON object, or one JSON array of those objects to dispatch several tasks in parallel, and no prose:
{"name":"${toolName}","arguments":{"description":"3-5 words","prompt":"task details","${agent}":"one name listed in the OpenCode ${toolName} description"}}
[{"name":"${toolName}","arguments":{"description":"first task","prompt":"details","${agent}":"explore"}},{"name":"${toolName}","arguments":{"description":"second task","prompt":"details","${agent}":"general"}}]
Use this only when delegating through OpenCode. Otherwise answer normally.`;
}

function editBridgeContext(toolName: string): string {
  return `SYSTEM: OpenCode edit bridge mode is active.
For ${toolName} only, the envelope below overrides the earlier generic "standard OpenAI tool_call" instruction. To change part of an existing file through OpenCode, put one JSON object on its own line, with nothing after it:
{"name":"edit","arguments":{"path":"relative/path","oldString":"exact text to replace","newString":"replacement text"}}
oldString must match the file exactly, including whitespace, and appear once. To replace a whole file, use the write envelope instead.`;
}

type BridgePromptOptions = {
  allowedToolNames: Set<string>;
  env?: Record<string, string | undefined>;
};

export type BridgeStreamDecision =
  | { action: "buffer" }
  | { action: "passthrough"; text: string }
  | { action: "tool_call"; toolCalls: OpenAiToolCall[]; text?: string };

/**
 * Splits streamed assistant text into prose and bridge envelopes. The detector
 * owns the text it is fed: callers emit `text` and never the raw event, so text
 * held while a line is being decided cannot leak through a cumulative snapshot.
 * Every line start is checked, so an envelope after a sentence of prose still
 * becomes a tool call (#114).
 */
export class BridgeJsonStreamDetector {
  private state: "line-start" | "prose" | "candidate" = "line-start";
  /** A line start still being decided, or the candidate envelope. */
  private buffer = "";
  /** True until a fenced candidate's info line is complete and accepted. */
  private fenceInfoPending = false;
  /** Inside a non-JSON code fence, where lines starting with `{` are code. */
  private inCodeFence = false;
  private readonly tracker = new MixedDeltaTracker();
  // Incremental bracket/string scan of the candidate. A parseable envelope must
  // end balanced and outside a string, so the full-buffer parse waits for that
  // instead of rerunning on every streamed delta.
  private depth = 0;
  private inString = false;
  private escaped = false;

  constructor(
    private readonly allowedToolNames: Set<string>,
    private readonly toolSchemaMap: Map<string, unknown> = new Map(),
  ) {}

  push(event: StreamJsonAssistantEvent): BridgeStreamDecision {
    const text = extractText(event);
    const delta = this.tracker.nextText(text, isPartialStreamDelta(event));
    if (!delta) {
      return { action: "buffer" };
    }
    if (this.state === "candidate") {
      this.buffer += delta;
      this.scan(delta);
      return this.decideCandidate("");
    }
    return this.pushProse(delta);
  }

  flush(): string {
    const text = this.buffer;
    this.buffer = "";
    this.state = text.endsWith("\n") ? "line-start" : "prose";
    return text;
  }

  reset(): void {
    this.state = "line-start";
    this.buffer = "";
    this.fenceInfoPending = false;
    this.inCodeFence = false;
    this.tracker.reset();
    this.depth = 0;
    this.inString = false;
    this.escaped = false;
  }

  private pushProse(delta: string): BridgeStreamDecision {
    let rest = this.buffer + delta;
    this.buffer = "";
    let out = "";
    while (rest) {
      if (this.state === "line-start") {
        const meaningful = rest.trimStart();
        if (!meaningful || /^(`{1,2}|\[\s*)$/.test(meaningful)) {
          this.buffer = rest;
          break;
        }
        if (this.inCodeFence) {
          if (meaningful.startsWith("```")) {
            this.inCodeFence = false;
          }
        } else if (/^(\{|```|\[\s*\{)/.test(meaningful)) {
          // `[` alone is common prose (markdown links); only `[{` starts an envelope array.
          this.state = "candidate";
          this.buffer = rest;
          this.fenceInfoPending = meaningful.startsWith("```");
          this.depth = 0;
          this.inString = false;
          this.escaped = false;
          this.scan(rest);
          return this.decideCandidate(out);
        }
        this.state = "prose";
      }
      const newline = rest.indexOf("\n");
      if (newline < 0) {
        out += rest;
        rest = "";
      } else {
        out += rest.slice(0, newline + 1);
        rest = rest.slice(newline + 1);
        this.state = "line-start";
      }
    }
    return out ? { action: "passthrough", text: out } : { action: "buffer" };
  }

  private decideCandidate(prefix: string): BridgeStreamDecision {
    if (this.fenceInfoPending) {
      const trimmed = this.buffer.trimStart();
      const infoLineEnd = trimmed.indexOf("\n", 3);
      if (infoLineEnd < 0) {
        return this.holding(prefix);
      }
      const info = trimmed.slice(3, infoLineEnd).trim();
      if (info && info.toLowerCase() !== "json") {
        this.inCodeFence = true;
        return this.releaseBuffer(prefix);
      }
      this.fenceInfoPending = false;
    }

    if (this.depth !== 0 || this.inString) {
      return this.holding(prefix);
    }

    const toolCalls = extractBridgeToolCallsFromText(
      this.buffer,
      this.allowedToolNames,
      this.toolSchemaMap,
    );
    if (toolCalls) {
      this.buffer = "";
      this.state = "line-start";
      return prefix ? { action: "tool_call", toolCalls, text: prefix } : { action: "tool_call", toolCalls };
    }

    // A balanced unfenced candidate that is not JSON never becomes JSON with more
    // text, and holding it would stall the stream. A fenced one waits for its fence.
    const fenced = this.buffer.trimStart().startsWith("```");
    if (containsCompleteJson(this.buffer) || !fenced) {
      return this.releaseBuffer(prefix);
    }
    return this.holding(prefix);
  }

  private holding(prefix: string): BridgeStreamDecision {
    return prefix ? { action: "passthrough", text: prefix } : { action: "buffer" };
  }

  private releaseBuffer(prefix: string): BridgeStreamDecision {
    const text = prefix + this.buffer;
    this.buffer = "";
    this.state = text.endsWith("\n") ? "line-start" : "prose";
    return { action: "passthrough", text };
  }

  // Each delta is scanned once as it arrives, keeping detection linear in envelope size.
  private scan(text: string): void {
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (this.inString) {
        if (this.escaped) {
          this.escaped = false;
        } else if (ch === "\\") {
          this.escaped = true;
        } else if (ch === '"') {
          this.inString = false;
        }
      } else if (ch === '"') {
        this.inString = true;
      } else if (ch === "{" || ch === "[") {
        this.depth++;
      } else if (ch === "}" || ch === "]") {
        this.depth--;
      }
    }
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
  const editToolName = resolveAllowedEditToolName(options.allowedToolNames);
  if (editToolName && !result.includes("OpenCode edit bridge mode is active")) {
    const context = editBridgeContext(editToolName);
    result = result ? `${result}\n\n${context}` : context;
  }
  const taskToolName = resolveTaskToolName(options.allowedToolNames);
  if (taskToolName && !result.includes("OpenCode Task bridge mode is active")) {
    const context = taskBridgeContext(taskToolName);
    result = result ? `${result}\n\n${context}` : context;
  }
  return result;
}

export function extractBridgeToolCallsFromText(
  text: string,
  allowedToolNames: Set<string>,
  toolSchemaMap: Map<string, unknown> = new Map(),
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
    const toolCall = buildBridgeToolCall(parsed, id, allowedToolNames, toolSchemaMap);
    return toolCall ? [toolCall] : null;
  }
  const toolCalls = parsed.map((entry, i) =>
    buildBridgeToolCall(entry, `${id}_${i}`, allowedToolNames, toolSchemaMap));
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
  toolSchemaMap: Map<string, unknown>,
): OpenAiToolCall | null {
  if (!isRecord(parsed) || !isRecord(parsed.arguments)) {
    return null;
  }

  if (parsed.name === "task" || parsed.name === "subagent") {
    const taskToolName = resolveTaskToolName(allowedToolNames);
    return taskToolName ? buildTaskToolCall(id, taskToolName, parsed.arguments) : null;
  }

  if (parsed.name === "edit") {
    const editToolName = resolveAllowedEditToolName(allowedToolNames);
    return editToolName ? buildEditToolCall(id, editToolName, parsed.arguments, toolSchemaMap) : null;
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
      arguments: JSON.stringify(buildWriteArguments(path, content, toolSchemaMap.get(writeToolName))),
    },
  };
}

/**
 * Models print `edit` envelopes in any argument dialect (`path`/`filePath`,
 * `oldString`/`old_string`); the schema compat layer maps them onto the edit
 * schema OpenCode advertised and rejects envelopes missing a required field.
 */
function buildEditToolCall(
  id: string,
  toolName: string,
  rawArgs: Record<string, unknown>,
  toolSchemaMap: Map<string, unknown>,
): OpenAiToolCall | null {
  const compat = applyToolSchemaCompat(
    { id, type: "function", function: { name: toolName, arguments: JSON.stringify(rawArgs) } },
    toolSchemaMap,
  );
  return compat.validation.ok ? compat.toolCall : null;
}

function buildTaskToolCall(
  id: string,
  toolName: TaskToolName,
  rawArgs: Record<string, unknown>,
): OpenAiToolCall | null {
  // Models trained on either host may use the other host's agent field name.
  const agent = taskAgentField(toolName);
  const otherAgent = taskAgentField(toolName === "task" ? "subagent" : "task");
  const { [otherAgent]: otherAgentValue, ...args } = rawArgs;
  if (args[agent] === undefined && otherAgentValue !== undefined) {
    args[agent] = otherAgentValue;
  }
  // A bare runtime model id (e.g. "composer-2.5") is not an OpenCode "providerID/modelID".
  if (toolName === "subagent" && typeof args.model === "string" && !args.model.includes("/")) {
    delete args.model;
  }

  const optionalStrings = toolName === "task" ? ["task_id", "command"] : ["sessionID", "model"];
  if (
    !isNonEmptyString(args.description)
    || !isNonEmptyString(args.prompt)
    || !isNonEmptyString(args[agent])
    || optionalStrings.some((key) => args[key] !== undefined && typeof args[key] !== "string")
    || (toolName === "subagent" && args.background !== undefined && typeof args.background !== "boolean")
  ) {
    return null;
  }

  return {
    id,
    type: "function",
    function: {
      name: toolName,
      arguments: JSON.stringify(args),
    },
  };
}

export function extractBridgeToolCallsFromStreamOutput(
  output: string,
  allowedToolNames: Set<string>,
  toolSchemaMap: Map<string, unknown> = new Map(),
): OpenAiToolCall[] | null {
  if (!output) {
    return null;
  }

  const detector = new BridgeJsonStreamDetector(allowedToolNames, toolSchemaMap);
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

function resolveAllowedEditToolName(allowedToolNames: Set<string>): string | null {
  if (allowedToolNames.has("edit")) {
    return "edit";
  }
  if (allowedToolNames.has("oc_edit")) {
    return "oc_edit";
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
