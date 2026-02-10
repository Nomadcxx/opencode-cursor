import type { StreamJsonToolCallEvent } from "../streaming/types.js";

export interface OpenAiToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface ToolLoopMeta {
  id: string;
  created: number;
  model: string;
}

const TOOL_NAME_ALIASES = new Map<string, string>([
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
): OpenAiToolCall | null {
  if (allowedToolNames.size === 0) {
    return null;
  }

  const { name, args } = extractToolNameAndArgs(event);
  if (!name) {
    return null;
  }

  const resolvedName = resolveAllowedToolName(name, allowedToolNames);
  if (!resolvedName) {
    return null;
  }

  const callId = event.call_id || (event as any).tool_call_id || "call_unknown";
  return {
    id: callId,
    type: "function",
    function: {
      name: resolvedName,
      arguments: toOpenAiArguments(args),
    },
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

function extractToolNameAndArgs(event: StreamJsonToolCallEvent): { name: string | null; args: unknown } {
  let name = typeof (event as any).name === "string" ? (event as any).name : null;
  let args: unknown = undefined;

  const entries = Object.entries(event.tool_call || {});
  if (entries.length > 0) {
    const [rawName, payload] = entries[0];
    if (!name) {
      name = normalizeToolName(rawName);
    }
    args = payload?.args;
  }

  if (name) {
    name = normalizeToolName(name);
  }

  return { name, args };
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
