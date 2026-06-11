import type { StreamJsonToolCallEvent } from "../streaming/types.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("proxy:tool-loop");

export interface OpenAiToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface ToolCallExtractionResult {
  action: "intercept" | "passthrough" | "skip";
  toolCall?: OpenAiToolCall;
  passthroughName?: string;
  skipReason?: string;
}

export interface ToolLoopMeta {
  id: string;
  created: number;
  model: string;
}

const TOOL_NAME_ALIASES = new Map<string, string>([
  // bash aliases
  ["runcommand", "bash"],
  ["executecommand", "bash"],
  ["runterminalcommand", "bash"],
  ["terminalcommand", "bash"],
  ["shellcommand", "bash"],
  ["shell", "bash"],
  ["terminal", "bash"],
  ["bashcommand", "bash"],
  ["runbash", "bash"],
  ["executebash", "bash"],
  // glob aliases
  ["findfiles", "glob"],
  ["searchfiles", "glob"],
  ["globfiles", "glob"],
  ["fileglob", "glob"],
  ["matchfiles", "glob"],
  // mkdir aliases
  ["createdirectory", "mkdir"],
  ["makedirectory", "mkdir"],
  ["mkdirp", "mkdir"],
  ["createdir", "mkdir"],
  ["makefolder", "mkdir"],
  // rm aliases
  ["delete", "rm"],
  ["deletefile", "rm"],
  ["deletepath", "rm"],
  ["deletedirectory", "rm"],
  ["remove", "rm"],
  ["removefile", "rm"],
  ["removepath", "rm"],
  ["unlink", "rm"],
  ["rmdir", "rm"],
  // stat aliases
  ["getfileinfo", "stat"],
  ["fileinfo", "stat"],
  ["filestat", "stat"],
  ["pathinfo", "stat"],
  // ls aliases
  ["listdirectory", "ls"],
  ["listfiles", "ls"],
  ["listdir", "ls"],
  ["readdir", "ls"],
  // todo write aliases
  ["updatetodos", "todowrite"],
  ["updatetodostoolcall", "todowrite"],
  ["todowrite", "todowrite"],
  ["todowritetoolcall", "todowrite"],
  ["writetodos", "todowrite"],
  ["todowritefn", "todowrite"],
  // todo read aliases
  ["readtodos", "todoread"],
  ["readtodostoolcall", "todoread"],
  ["todoread", "todoread"],
  ["todoreadtoolcall", "todoread"],
  // sub-agent and delegation aliases
  ["callomoagent", "call_omo_agent"],
  ["callagent", "call_omo_agent"],
  ["invokeagent", "call_omo_agent"],
  ["delegatetask", "task"],
  ["delegate", "task"],
  ["runtask", "task"],
  ["subagent", "task"],
  // skill aliases
  ["useskill", "skill"],
  ["invokeskill", "skill"],
  ["runskill", "skill"],
  ["skillmcp", "skill_mcp"],
  ["mcp_skill", "skill_mcp"],
  ["runmcpskill", "skill_mcp"],
  ["invokeskillmcp", "skill_mcp"],
  // question aliases (Cursor-trained models often emit AskQuestion / ask_user)
  ["askquestion", "question"],
  ["askuser", "question"],
  ["askuserquestion", "question"],
  ["askquestions", "question"],
  ["promptuser", "question"],
]);

export function extractAllowedToolNames(tools: Array<any>): Set<string> {
  const names = new Set<string>();
  for (const tool of tools) {
    const fn = tool?.function ?? tool;
    if (fn && typeof fn.name === "string" && fn.name.length > 0) {
      names.add(fn.name);
    }
  }
  return names;
}

export function extractOpenAiToolCall(
  event: StreamJsonToolCallEvent,
  allowedToolNames: Set<string>,
): ToolCallExtractionResult {
  if (allowedToolNames.size === 0) {
    return { action: "skip", skipReason: "no_allowed_tools" };
  }

  const { name, args, skipped } = extractToolNameAndArgs(event);
  if (skipped) {
    return { action: "skip", skipReason: "event_skipped" };
  }
  if (!name) {
    return { action: "skip", skipReason: "no_name" };
  }

  const resolvedName = resolveAllowedToolName(name, allowedToolNames);
  if (resolvedName) {
    // Known tool → intercept and forward to OpenCode
    if (args === undefined && event.subtype === "started") {
      log.debug("Tool call args extraction returned undefined", {
        toolName: name,
        subtype: event.subtype ?? "none",
        payloadKeys: Object.entries(event.tool_call || {}).map(([k, v]) =>
          `${k}:[${isRecord(v) ? Object.keys(v).join(",") : typeof v}]`),
        hasCallId: Boolean(event.call_id),
      });
    }

    const callId = event.call_id || (event as any).tool_call_id || "call_unknown";
    return {
      action: "intercept",
      toolCall: {
        id: callId,
        type: "function",
        function: {
          name: resolvedName,
          arguments: toOpenAiArguments(args),
        },
      },
    };
  }

  // Unknown tool → pass through to cursor-agent
  log.debug("Tool call not in allowlist; passing through to cursor-agent", {
    name,
    normalized: normalizeAliasKey(name),
    allowedToolCount: allowedToolNames.size,
  });
  return {
    action: "passthrough",
    passthroughName: name,
  };
}

export function createToolCallCompletionResponse(meta: ToolLoopMeta, toolCall: OpenAiToolCall) {
  return {
    id: meta.id,
    object: "chat.completion",
    created: meta.created,
    model: meta.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [toolCall],
        },
        finish_reason: "tool_calls",
      },
    ],
  };
}

export function createToolCallStreamChunks(meta: ToolLoopMeta, toolCall: OpenAiToolCall): Array<any> {
  const toolDelta = {
    id: meta.id,
    object: "chat.completion.chunk",
    created: meta.created,
    model: meta.model,
    choices: [
      {
        index: 0,
        delta: {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              ...toolCall,
            },
          ],
        },
        finish_reason: null,
      },
    ],
  };

  const finishChunk = {
    id: meta.id,
    object: "chat.completion.chunk",
    created: meta.created,
    model: meta.model,
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: "tool_calls",
      },
    ],
  };

  return [toolDelta, finishChunk];
}

function extractToolNameAndArgs(event: StreamJsonToolCallEvent): {
  name: string | null;
  args: unknown;
  skipped: boolean;
} {
  let name = typeof (event as any).name === "string" ? (event as any).name : null;
  let args: unknown = undefined;

  const entries = Object.entries(event.tool_call || {});
  if (entries.length > 0) {
    const [rawName, payload] = entries[0];
    if (!name) {
      name = normalizeToolName(rawName);
    }
    const payloadRecord = isRecord(payload) ? payload : null;
    args = payloadRecord?.args;

    // Some tool-call events include a flat payload without an `args` wrapper.
    if (args === undefined && payloadRecord) {
      const { result: _result, ...rest } = payloadRecord;
      const restKeys = Object.keys(rest);
      if (restKeys.length === 0) {
        if (name) {
          name = normalizeToolName(name);
        }
        return { name, args: undefined, skipped: true };
      }
      args = rest;
    }
  }

  if (name) {
    name = normalizeToolName(name);
  }

  return { name, args, skipped: false };
}

function normalizeToolName(raw: string): string {
  if (raw.endsWith("ToolCall")) {
    const base = raw.slice(0, -"ToolCall".length);
    return base.charAt(0).toLowerCase() + base.slice(1);
  }
  return raw;
}

function resolveAllowedToolName(name: string, allowedToolNames: Set<string>): string | null {
  if (allowedToolNames.has(name)) {
    return name;
  }

  const normalizedName = normalizeAliasKey(name);
  for (const allowedName of allowedToolNames) {
    if (normalizeAliasKey(allowedName) === normalizedName) {
      return allowedName;
    }
  }

  const aliasedCanonical = TOOL_NAME_ALIASES.get(normalizedName);
  if (!aliasedCanonical) {
    return null;
  }

  const canonicalNormalized = normalizeAliasKey(aliasedCanonical);
  for (const allowedName of allowedToolNames) {
    if (normalizeAliasKey(allowedName) === canonicalNormalized) {
      return allowedName;
    }
  }

  return null;
}

function normalizeAliasKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function toOpenAiArguments(args: unknown): string {
  if (args === undefined) {
    return "{}";
  }

  if (typeof args === "string") {
    try {
      const parsed = JSON.parse(args);
      if (parsed && typeof parsed === "object") {
        return JSON.stringify(parsed);
      }
      return JSON.stringify({ value: parsed });
    } catch {
      return JSON.stringify({ value: args });
    }
  }

  if (typeof args === "object" && args !== null) {
    return JSON.stringify(args);
  }

  return JSON.stringify({ value: args });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
