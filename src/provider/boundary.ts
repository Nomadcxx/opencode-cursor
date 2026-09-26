import type { OpenAiToolCall, ToolLoopMeta, ToolCallExtractionResult } from "../proxy/tool-loop.js";
import {
  createToolCallCompletionResponse,
  createToolCallStreamChunks,
  extractOpenAiToolCall,
} from "../proxy/tool-loop.js";
import type { StreamJsonToolCallEvent } from "../streaming/types.js";

export type ToolLoopMode = "opencode" | "proxy-exec" | "off";

export type ProviderBoundaryMode = "legacy" | "v1";

/**
 * A single model parameter forwarded to the Cursor SDK.
 * Shape matches @cursor/sdk `ModelParameterValue` ({ id, value }).
 */
export interface RuntimeModelParameter {
  id: string;
  value: string;
}

/**
 * Normalize a `cursorParams` request field into a stable array of
 * `{ id, value }` pairs accepted by the Cursor SDK `model.params`.
 *
 * Accepted forms (all liberal, invalid/empty → undefined):
 *  - "effort=high" or "effort=high,fast=true" (comma/space separated k=v)
 *  - JSON string: '[{"id":"effort","value":"high"}]'
 *  - array of { id, value } objects
 *  - plain object: { "effort": "high" }
 *
 * Only string values are accepted; values are trimmed; empty entries are
 * dropped; duplicate ids are deduped (last wins). Never throws.
 */
export function resolveRuntimeParams(
  raw: unknown,
): RuntimeModelParameter[] | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }

  let pairs: Array<[string, string]> = [];

  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      return undefined;
    }

    // Try JSON first: '[{"id":"effort","value":"high"}]'
    if (trimmed.startsWith("[")) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        parsed = undefined;
      }
      if (Array.isArray(parsed)) {
        pairs = parsed
          .map((entry) => extractSinglePair(entry))
          .filter((pair): pair is [string, string] => pair !== undefined);
      } else {
        return undefined;
      }
    } else {
      // k=v list separated by commas and/or whitespace
      const tokens = trimmed.split(/[\s,]+/).filter((t) => t.length > 0);
      pairs = tokens
        .map((token) => {
          const eq = token.indexOf("=");
          if (eq <= 0) {
            return undefined;
          }
          const id = token.slice(0, eq).trim();
          const value = token.slice(eq + 1).trim();
          if (id.length === 0 || value.length === 0) {
            return undefined;
          }
          return [id, value] as [string, string];
        })
        .filter((pair): pair is [string, string] => pair !== undefined);
    }
  } else if (Array.isArray(raw)) {
    pairs = raw
      .map((entry) => extractSinglePair(entry))
      .filter((pair): pair is [string, string] => pair !== undefined);
  } else if (typeof raw === "object") {
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value === "string" && value.trim().length > 0) {
        pairs.push([key, value.trim()]);
      }
    }
  }

  if (pairs.length === 0) {
    return undefined;
  }

  // Dedupe by id (last wins).
  const byId = new Map<string, string>();
  for (const [id, value] of pairs) {
    byId.set(id, value);
  }

  const params: RuntimeModelParameter[] = [];
  for (const [id, value] of byId) {
    params.push({ id, value });
  }
  return params;
}

function extractSinglePair(entry: unknown): [string, string] | undefined {
  if (!entry || typeof entry !== "object") {
    return undefined;
  }
  const obj = entry as Record<string, unknown>;
  const id = typeof obj.id === "string" ? obj.id.trim() : "";
  const value = typeof obj.value === "string" ? obj.value.trim() : "";
  if (id.length === 0 || value.length === 0) {
    return undefined;
  }
  return [id, value];
}

export type ToolOptionResolution = {
  tools: unknown;
  action: "preserve" | "fallback" | "override" | "none";
};

export interface ToolLoopFlags {
  proxyExecuteToolCalls: boolean;
  suppressConverterToolEvents: boolean;
  shouldEmitToolUpdates: boolean;
}

export interface ProviderBoundary {
  readonly mode: ProviderBoundaryMode;
  readonly providerId: string;
  resolveChatParamTools(
    toolLoopMode: ToolLoopMode,
    existingTools: unknown,
    refreshedTools: Array<any>,
  ): ToolOptionResolution;
  computeToolLoopFlags(
    toolLoopMode: ToolLoopMode,
    forwardToolCalls: boolean,
    emitToolUpdates: boolean,
  ): ToolLoopFlags;
  matchesProvider(inputModel: any): boolean;
  normalizeRuntimeModel(model: unknown): string;
  resolveRuntimeModel(model: unknown, cursorModel: unknown): string;
  applyChatParamDefaults(
    output: any,
    proxyBaseURL: string | undefined,
    defaultBaseURL: string,
    defaultApiKey: string,
  ): void;
  maybeExtractToolCall(
    event: StreamJsonToolCallEvent,
    allowedToolNames: Set<string>,
    toolLoopMode: ToolLoopMode,
  ): ToolCallExtractionResult;
  createNonStreamToolCallResponse(meta: ToolLoopMeta, toolCall: OpenAiToolCall): any;
  createStreamToolCallChunks(meta: ToolLoopMeta, toolCall: OpenAiToolCall): Array<any>;
}

export function parseProviderBoundaryMode(
  value: string | undefined,
): { mode: ProviderBoundaryMode; valid: boolean } {
  const normalized = (value ?? "v1").trim().toLowerCase();
  if (normalized === "legacy" || normalized === "v1") {
    return { mode: normalized, valid: true };
  }
  return { mode: "v1", valid: false };
}

export function createProviderBoundary(
  mode: ProviderBoundaryMode,
  providerId: string,
): ProviderBoundary {
  const shared = createSharedBoundary(providerId);
  if (mode === "v1") {
    return { ...shared, mode: "v1" };
  }
  return { ...shared, mode: "legacy" };
}

function createSharedBoundary(
  providerId: string,
): Omit<ProviderBoundary, "mode"> {
  return {
    providerId,

    resolveChatParamTools(toolLoopMode, existingTools, refreshedTools) {
      if (toolLoopMode === "proxy-exec") {
        if (refreshedTools.length > 0) {
          return { tools: refreshedTools, action: "override" };
        }
        return { tools: existingTools, action: "none" };
      }

      if (toolLoopMode === "opencode") {
        if (existingTools != null) {
          return { tools: existingTools, action: "preserve" };
        }
        if (refreshedTools.length > 0) {
          return { tools: refreshedTools, action: "fallback" };
        }
        return { tools: existingTools, action: "none" };
      }

      return { tools: existingTools, action: "none" };
    },

    computeToolLoopFlags(toolLoopMode, forwardToolCalls, emitToolUpdates) {
      const proxyExec = toolLoopMode === "proxy-exec";
      const opencode = toolLoopMode === "opencode";
      return {
        proxyExecuteToolCalls: proxyExec && forwardToolCalls,
        // ponytail: opencode mode owns tool-call delivery through the normalized
        // interception path. Letting the generic stream converter emit raw
        // tool_call chunks bypasses schema repair and surfaces edit SchemaErrors.
        suppressConverterToolEvents: opencode || (proxyExec && !forwardToolCalls),
        shouldEmitToolUpdates: proxyExec && emitToolUpdates,
      };
    },

    matchesProvider(inputModel: any) {
      if (!inputModel || typeof inputModel !== "object") {
        return false;
      }

      const modelProviderId =
        (typeof inputModel.providerID === "string" && inputModel.providerID)
        || (typeof inputModel.providerId === "string" && inputModel.providerId)
        || (typeof inputModel.provider === "string" && inputModel.provider)
        || "";

      return modelProviderId === providerId;
    },

    normalizeRuntimeModel(model) {
      const raw = typeof model === "string" ? model.trim() : "";
      if (raw.length === 0) {
        return "auto";
      }

      const prefix = `${providerId}/`;
      if (raw.startsWith(prefix)) {
        const stripped = raw.slice(prefix.length).trim();
        return stripped.length > 0 ? stripped : "auto";
      }

      return raw;
    },

    resolveRuntimeModel(model, cursorModel) {
      const rawCursorModel = typeof cursorModel === "string" ? cursorModel.trim() : "";
      if (rawCursorModel.length > 0) {
        return this.normalizeRuntimeModel(rawCursorModel);
      }

      return this.normalizeRuntimeModel(model);
    },

    applyChatParamDefaults(output, proxyBaseURL, defaultBaseURL, defaultApiKey) {
      output.options = output.options || {};
      output.options.baseURL = proxyBaseURL || defaultBaseURL;
      output.options.apiKey = output.options.apiKey || defaultApiKey;
    },

    maybeExtractToolCall(event, allowedToolNames, toolLoopMode) {
      if (toolLoopMode !== "opencode") {
        return { action: "skip" as const, skipReason: "tool_loop_mode_not_opencode" };
      }
      return extractOpenAiToolCall(event, allowedToolNames);
    },

    createNonStreamToolCallResponse(meta, toolCall) {
      return createToolCallCompletionResponse(meta, toolCall);
    },

    createStreamToolCallChunks(meta, toolCall) {
      return createToolCallStreamChunks(meta, toolCall);
    },
  };
}
