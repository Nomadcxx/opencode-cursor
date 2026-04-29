import type { OpenAiToolCall, ToolLoopMeta, ToolCallExtractionResult } from "../proxy/tool-loop.js";
import {
  createToolCallCompletionResponse,
  createToolCallStreamChunks,
  extractOpenAiToolCall,
} from "../proxy/tool-loop.js";
import type { StreamJsonToolCallEvent } from "../streaming/types.js";

export type ToolLoopMode = "opencode" | "proxy-exec" | "off";

export type ProviderBoundaryMode = "legacy" | "v1";

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
      return {
        proxyExecuteToolCalls: proxyExec && forwardToolCalls,
        suppressConverterToolEvents: proxyExec && !forwardToolCalls,
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
