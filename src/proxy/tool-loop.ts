import type { StreamJsonToolCallEvent } from "../streaming/types.js";
import {
  isCursorMcpMetaTool,
  isCursorNativeMcpDiscoveryTool,
  isKiloMcpCatalogToolName,
  isKiloNativeCoreToolName,
  mcpCatalogAliasKey,
  normalizeKiloCoreToolArgs,
  remapBareMcpToolCall,
  resolveMcpToolName,
  splitKiloMcpToolName,
} from "../mcp/kilo-bridge.js";
import {
  GET_DYNAMIC_TOOLS_NAME,
  getRememberedCoreTools,
  getRememberedMcpCatalog,
  isCallDynamicToolName,
  isGetDynamicToolsName,
  mcpServerIsRemembered,
  parseCallDynamicToolArgs,
  resolveCallDynamicToolToKiloName,
  shouldPassthroughCursorDynamicTool,
} from "../mcp/dynamic-catalog.js";
import { namespaceMcpTool } from "../mcp/tool-bridge.js";
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
  // edit/write aliases
  ["edit", "oc_edit"],
  ["write", "oc_write"],
  ["read", "oc_read"],
  ["ocedit", "edit"],
  ["strreplace", "edit"],
  ["ocwrite", "write"],
  ["writefile", "write"],
  // read aliases
  ["ocread", "read"],
  // grep aliases
  ["ocgrep", "grep"],
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
  // web aliases (Kilo: webfetch, websearch)
  ["websearch", "websearch"],
  ["webfetch", "webfetch"],
  ["fetchurl", "webfetch"],
  ["fetch", "webfetch"],
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

  if (isGetDynamicToolsName(name) || isCallDynamicToolName(name) || isCursorNativeMcpDiscoveryTool(name)) {
    const metaResult = extractMcpMetaToolCall(event, allowedToolNames);
    if (metaResult) {
      return metaResult;
    }
    const remappedDynamic = resolveCallDynamicToolToKiloName(args, allowedToolNames);
    if (remappedDynamic) {
      log.debug("Remapped native dynamic MCP call to Kilo name", {
        from: name,
        to: remappedDynamic.name,
      });
      const callId = event.call_id || (event as any).tool_call_id || "call_unknown";
      return {
        action: "intercept",
        toolCall: {
          id: callId,
          type: "function",
          function: {
            name: remappedDynamic.name,
            arguments: toOpenAiArguments(
              isKiloNativeCoreToolName(remappedDynamic.name)
                ? normalizeKiloCoreToolArgs(remappedDynamic.name, remappedDynamic.args)
                : remappedDynamic.args,
            ),
          },
        },
      };
    }
    if (isCallDynamicToolName(name) && shouldPassthroughCursorDynamicTool(args)) {
      return { action: "passthrough", passthroughName: name };
    }
    if (isGetDynamicToolsName(name) || isCursorNativeMcpDiscoveryTool(name)) {
      const callId = event.call_id || (event as any).tool_call_id || "call_unknown";
      return {
        action: "intercept",
        toolCall: {
          id: callId,
          type: "function",
          function: {
            name: GET_DYNAMIC_TOOLS_NAME,
            arguments: toOpenAiArguments(args ?? {}),
          },
        },
      };
    }
  }

  if (isCursorMcpMetaTool(name)) {
    const metaResult = extractMcpMetaToolCall(event, allowedToolNames);
    if (metaResult) {
      return metaResult;
    }
  }

  // SDK/cursor-agent generic MCP wrapper: { providerIdentifier, toolName, args }.
  if (name.toLowerCase() === "mcp") {
    const remapped = remapBareMcpToolCall(args, allowedToolNames);
    if (remapped) {
      const callId = event.call_id || (event as any).tool_call_id || "call_unknown";
      return {
        action: "intercept",
        toolCall: {
          id: callId,
          type: "function",
          function: {
            name: remapped.name,
            arguments: toOpenAiArguments(remapped.args),
          },
        },
      };
    }

    log.warn("Model attempted to call 'mcp' without resolvable provider/toolName", {
      args,
      hint: "MCP tools must use mcp__<server>__<tool> or a Kilo name like context7_<tool>",
    });
    return {
      action: "passthrough",
      passthroughName: name,
    };
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
          arguments: toOpenAiArguments(
            isKiloNativeCoreToolName(resolvedName)
              ? normalizeKiloCoreToolArgs(resolvedName, args)
              : args,
          ),
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
    const payloadRecord = isRecord(payload) ? payload : null;
    const unwrapped = unwrapToolCallPayload(rawName, payloadRecord);

    if (!name) {
      name = unwrapped.name;
    } else {
      name = normalizeToolName(name);
      if (isWrapperToolName(name) && unwrapped.name) {
        name = unwrapped.name;
      }
    }
    args = unwrapped.args;

    // Cursor native tool_use events carry arguments under `input` instead of `args`.
    if (args === undefined && payloadRecord && isRecord(payloadRecord.input)) {
      args = payloadRecord.input;
    }

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

  if (args === undefined) {
    const topLevel = event as { args?: unknown; arguments?: unknown; input?: unknown };
    args = firstDefined(topLevel.args, topLevel.arguments, topLevel.input);
  }

  args = coerceToolArgs(args);

  if (name) {
    name = normalizeToolName(name);
  }

  const envelope = unwrapDynamicEnvelope(name, args);
  name = envelope.name;
  args = envelope.args;

  if (!name || isWrapperToolName(name)) {
    const inferred = inferDynamicToolName(args);
    if (inferred) {
      name = inferred;
    }
  }

  return { name, args, skipped: false };
}

function unwrapToolCallPayload(
  rawName: string,
  payload: Record<string, unknown> | null,
): { name: string | null; args: unknown } {
  const normalizedRaw = normalizeToolName(rawName);
  if (isWrapperToolName(normalizedRaw) && payload) {
    const fn = isRecord(payload.function) ? payload.function : payload;
    const nestedName = pickFirstString(fn.name, payload.name, payload.toolName);
    const nestedArgs = firstDefined(
      fn.arguments,
      fn.args,
      fn.input,
      payload.arguments,
      payload.args,
      payload.input,
    );
    return {
      name: nestedName ?? normalizedRaw,
      args: nestedArgs,
    };
  }

  let args: unknown = payload?.args;
  if (args === undefined && payload && isRecord(payload.input)) {
    args = payload.input;
  }
  return { name: normalizedRaw, args };
}

function isWrapperToolName(name: string): boolean {
  const key = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  return key === "function" || key === "unknown" || key === "unknowntool";
}

function unwrapDynamicEnvelope(
  currentName: string | null,
  args: unknown,
): { name: string | null; args: unknown } {
  if (!isRecord(args)) {
    return { name: currentName, args };
  }

  const nestedName = pickFirstString(args.name);
  if (
    !nestedName
    || !(
      isGetDynamicToolsName(nestedName)
      || isCallDynamicToolName(nestedName)
      || isCursorNativeMcpDiscoveryTool(nestedName)
    )
  ) {
    return { name: currentName, args };
  }

  const { name: _nested, ...rest } = args;
  if (isCallDynamicToolName(nestedName) && parseCallDynamicToolArgs(rest)) {
    return { name: nestedName, args: rest };
  }

  const inner = firstDefined(rest.arguments, rest.args, rest.input);
  return {
    name: nestedName,
    args: inner === undefined ? rest : coerceToolArgs(inner),
  };
}

function inferDynamicToolName(args: unknown): string | null {
  const parsed = parseCallDynamicToolArgs(args);
  if (parsed?.toolName) {
    return "CallDynamicTool";
  }
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return null;
  }
  const record = args as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length === 0) {
    return null;
  }
  const catalogKeys = new Set([
    "namespace",
    "toolname",
    "tool",
    "pattern",
    "provideridentifier",
    "server",
  ]);
  if (!keys.every((key) => catalogKeys.has(key.toLowerCase()))) {
    return null;
  }
  return "GetDynamicTools";
}

function coerceToolArgs(args: unknown): unknown {
  if (typeof args !== "string") {
    return args;
  }
  const trimmed = args.trim();
  if (!trimmed) {
    return args;
  }
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object") {
      return parsed;
    }
  } catch {
    return args;
  }
  return args;
}

function pickFirstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function firstDefined<T>(...values: T[]): T | undefined {
  for (const value of values) {
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

function normalizeToolName(raw: string): string {
  if (raw.endsWith("ToolCall")) {
    const base = raw.slice(0, -"ToolCall".length);
    return base.charAt(0).toLowerCase() + base.slice(1);
  }
  return raw;
}

function resolveAllowedToolName(name: string, allowedToolNames: Set<string>): string | null {
  const mcpResolved = resolveMcpToolName(name, allowedToolNames);
  if (mcpResolved) {
    return mcpResolved;
  }

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
  if (aliasedCanonical) {
    const canonicalNormalized = normalizeAliasKey(aliasedCanonical);
    for (const allowedName of allowedToolNames) {
      if (normalizeAliasKey(allowedName) === canonicalNormalized) {
        return allowedName;
      }
    }
  }

  const rememberedMatch = resolveRememberedMcpToolName(name, allowedToolNames);
  if (rememberedMatch) {
    return rememberedMatch;
  }

  const coreMatch = resolveRememberedCoreToolName(name);
  if (coreMatch) {
    return coreMatch;
  }

  return null;
}

function resolveRememberedCoreToolName(name: string): string | null {
  const aliased = TOOL_NAME_ALIASES.get(normalizeAliasKey(name)) ?? name;
  const candidates = [aliased, name];
  for (const candidate of candidates) {
    const key = candidate.trim().toLowerCase();
    if (key === "skill" || key === "skill_mcp") {
      return key;
    }
  }
  const want = normalizeAliasKey(aliased);
  for (const core of getRememberedCoreTools()) {
    const coreKey = core.trim().toLowerCase();
    if ((coreKey === "skill" || coreKey === "skill_mcp") && normalizeAliasKey(core) === want) {
      return core;
    }
  }
  return null;
}

function resolveRememberedMcpToolName(
  name: string,
  allowedToolNames: Set<string>,
): string | null {
  const key = mcpCatalogAliasKey(name);
  for (const entry of getRememberedMcpCatalog()) {
    if (mcpCatalogAliasKey(entry.name) === key) {
      return entry.name;
    }
  }

  if (!isKiloMcpCatalogToolName(name)) {
    return null;
  }
  const split = splitKiloMcpToolName(name);
  if (!split) {
    return null;
  }
  const serverKey = mcpCatalogAliasKey(split.server);

  if (mcpServerIsRemembered(split.server)) {
    return name;
  }

  for (const entry of getRememberedMcpCatalog()) {
    const rememberedSplit = splitKiloMcpToolName(entry.name);
    if (rememberedSplit && mcpCatalogAliasKey(rememberedSplit.server) === serverKey) {
      return name;
    }
  }

  for (const allowedName of allowedToolNames) {
    const allowedSplit = splitKiloMcpToolName(allowedName);
    if (allowedSplit && mcpCatalogAliasKey(allowedSplit.server) === serverKey) {
      return name;
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

function extractMcpMetaToolCall(
  event: StreamJsonToolCallEvent,
  allowedToolNames: Set<string>,
): ToolCallExtractionResult | null {
  const entries = Object.entries(event.tool_call || {});
  if (entries.length === 0) {
    return null;
  }

  const [, payload] = entries[0]!;
  if (!isRecord(payload)) {
    return null;
  }

  let inner: Record<string, unknown> = isRecord(payload.args) ? payload.args : payload;
  if (
    !("toolName" in inner || "providerIdentifier" in inner || "server" in inner)
    && isRecord(payload.input)
  ) {
    inner = payload.input;
  }

  const provider = inner.providerIdentifier ?? inner.server;
  const toolName = inner.toolName ?? inner.name;
  let resolvedName: string | null = null;

  if (typeof provider === "string" && typeof toolName === "string") {
    resolvedName = resolveMcpToolName(namespaceMcpTool(provider, toolName), allowedToolNames);
  } else if (typeof toolName === "string") {
    resolvedName = resolveMcpToolName(toolName, allowedToolNames);
    if (resolvedName === null && allowedToolNames.has(toolName)) {
      resolvedName = toolName;
    }
  }

  if (!resolvedName) {
    return null;
  }

  let args = inner.arguments ?? inner.args ?? {};
  if (typeof args === "string") {
    try {
      const parsed = JSON.parse(args);
      args = parsed;
    } catch {
      args = { value: args };
    }
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
