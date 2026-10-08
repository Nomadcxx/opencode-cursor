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
  /** True until a fenced candidate's info line is complete and accepted. */
  private fenceInfoPending = false;
  private readonly tracker = new MixedDeltaTracker();
  // Incremental bracket/string scan of the candidate. A parseable envelope must
  // end balanced and outside a string, so the full-buffer parse waits for that
  // instead of rerunning on every streamed delta.
  private depth = 0;
  private inString = false;
  private escaped = false;

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
        this.fenceInfoPending = meaningful.startsWith("```");
        this.scan(this.buffer);
      } else {
        const withheld = this.buffer;
        this.buffer = "";
        this.state = "passthrough";
        return hadBufferedText
          ? { action: "passthrough", text: withheld }
          : { action: "passthrough" };
      }
    } else {
      this.scan(delta);
    }

    if (this.fenceInfoPending) {
      const trimmed = this.buffer.trimStart();
      const infoLineEnd = trimmed.indexOf("\n", 3);
      if (infoLineEnd < 0) {
        return { action: "buffer" };
      }
      const info = trimmed.slice(3, infoLineEnd).trim();
      if (info && info.toLowerCase() !== "json") {
        return this.releaseBuffer();
      }
      this.fenceInfoPending = false;
    }

    if (this.depth !== 0 || this.inString) {
      return { action: "buffer" };
    }

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
    this.fenceInfoPending = false;
    this.tracker.reset();
    this.depth = 0;
    this.inString = false;
    this.escaped = false;
  }

  private releaseBuffer(): BridgeStreamDecision {
    const text = this.buffer;
    this.buffer = "";
    this.state = "passthrough";
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

  if (parsed.name === "task" || parsed.name === "subagent") {
    const taskToolName = resolveTaskToolName(allowedToolNames);
    return taskToolName ? buildTaskToolCall(id, taskToolName, parsed.arguments) : null;
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
