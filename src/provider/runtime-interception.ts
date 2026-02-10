import type { ToolUpdate, ToolMapper } from "../acp/tools.js";
import { extractOpenAiToolCall, type OpenAiToolCall } from "../proxy/tool-loop.js";
import type { StreamJsonToolCallEvent } from "../streaming/types.js";
import type { ToolRouter } from "../tools/router.js";
import { createLogger } from "../utils/logger.js";
import { applyToolSchemaCompat } from "./tool-schema-compat.js";
import type { ToolLoopGuard } from "./tool-loop-guard.js";
import type { ProviderBoundaryMode, ToolLoopMode } from "./boundary.js";
import type { ProviderBoundary } from "./boundary.js";

const log = createLogger("provider:runtime-interception");

interface HandleToolLoopEventBaseOptions {
  event: StreamJsonToolCallEvent;
  toolLoopMode: ToolLoopMode;
  allowedToolNames: Set<string>;
  toolSchemaMap: Map<string, unknown>;
  toolLoopGuard: ToolLoopGuard;
  toolMapper: ToolMapper;
  toolSessionId: string;
  shouldEmitToolUpdates: boolean;
  proxyExecuteToolCalls: boolean;
  suppressConverterToolEvents: boolean;
  toolRouter?: ToolRouter;
  responseMeta: { id: string; created: number; model: string };
  onToolUpdate: (update: ToolUpdate) => Promise<void> | void;
  onToolResult: (toolResult: any) => Promise<void> | void;
  onInterceptedToolCall: (toolCall: OpenAiToolCall) => Promise<void> | void;
}

export interface HandleToolLoopEventLegacyOptions extends HandleToolLoopEventBaseOptions {}

export interface HandleToolLoopEventV1Options extends HandleToolLoopEventBaseOptions {
  boundary: ProviderBoundary;
}

export interface HandleToolLoopEventWithFallbackOptions
  extends HandleToolLoopEventV1Options {
  boundaryMode: ProviderBoundaryMode;
  autoFallbackToLegacy: boolean;
  onFallbackToLegacy?: (error: unknown) => void;
}

export interface HandleToolLoopEventResult {
  intercepted: boolean;
  skipConverter: boolean;
  terminate?: ToolLoopTermination;
}

export interface ToolLoopTermination {
  reason: "loop_guard";
  message: string;
  tool: string;
  fingerprint: string;
  repeatCount: number;
  maxRepeat: number;
  errorClass: string;
}

export class ToolBoundaryExtractionError extends Error {
  cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "ToolBoundaryExtractionError";
    this.cause = cause;
  }
}

export async function handleToolLoopEventLegacy(
  options: HandleToolLoopEventLegacyOptions,
): Promise<HandleToolLoopEventResult> {
  const {
    event,
    toolLoopMode,
    allowedToolNames,
    toolSchemaMap: _toolSchemaMap,
    toolLoopGuard,
    toolMapper,
    toolSessionId,
    shouldEmitToolUpdates,
    proxyExecuteToolCalls,
    suppressConverterToolEvents,
    toolRouter,
    responseMeta,
    onToolUpdate,
    onToolResult,
    onInterceptedToolCall,
  } = options;

  const interceptedToolCall =
    toolLoopMode === "opencode"
      ? extractOpenAiToolCall(event as any, allowedToolNames)
      : null;
  if (interceptedToolCall) {
    const termination = evaluateToolLoopGuard(toolLoopGuard, interceptedToolCall);
    if (termination) {
      return { intercepted: false, skipConverter: true, terminate: termination };
    }
    await onInterceptedToolCall(interceptedToolCall);
    return { intercepted: true, skipConverter: true };
  }

  const updates = await toolMapper.mapCursorEventToAcp(
    event,
    event.session_id ?? toolSessionId,
  );

  if (shouldEmitToolUpdates) {
    for (const update of updates) {
      await onToolUpdate(update);
    }
  }

  if (toolRouter && proxyExecuteToolCalls) {
    const toolResult = await toolRouter.handleToolCall(event as any, responseMeta);
    if (toolResult) {
      await onToolResult(toolResult);
    }
  }

  return {
    intercepted: false,
    skipConverter: suppressConverterToolEvents,
  };
}

export async function handleToolLoopEventV1(
  options: HandleToolLoopEventV1Options,
): Promise<HandleToolLoopEventResult> {
  const {
    event,
    boundary,
    toolLoopMode,
    allowedToolNames,
    toolSchemaMap,
    toolLoopGuard,
    toolMapper,
    toolSessionId,
    shouldEmitToolUpdates,
    proxyExecuteToolCalls,
    suppressConverterToolEvents,
    toolRouter,
    responseMeta,
    onToolUpdate,
    onToolResult,
    onInterceptedToolCall,
  } = options;

  let interceptedToolCall: OpenAiToolCall | null;
  try {
    interceptedToolCall = boundary.maybeExtractToolCall(
      event,
      allowedToolNames,
      toolLoopMode,
    );
  } catch (error) {
    throw new ToolBoundaryExtractionError("Boundary tool extraction failed", error);
  }
  if (interceptedToolCall) {
    const compat = applyToolSchemaCompat(interceptedToolCall, toolSchemaMap);
    interceptedToolCall = compat.toolCall;
    log.debug("Applied tool schema compatibility", {
      tool: interceptedToolCall.function.name,
      originalArgKeys: compat.originalArgKeys,
      normalizedArgKeys: compat.normalizedArgKeys,
      collisionKeys: compat.collisionKeys,
      validationOk: compat.validation.ok,
    });
    if (compat.validation.hasSchema && !compat.validation.ok) {
      log.warn("Tool schema compatibility validation failed", {
        tool: interceptedToolCall.function.name,
        missing: compat.validation.missing,
        unexpected: compat.validation.unexpected,
        typeErrors: compat.validation.typeErrors,
        repairHint: compat.validation.repairHint,
      });
    }

    const termination = evaluateToolLoopGuard(toolLoopGuard, interceptedToolCall);
    if (termination) {
      return { intercepted: false, skipConverter: true, terminate: termination };
    }
    await onInterceptedToolCall(interceptedToolCall);
    return { intercepted: true, skipConverter: true };
  }

  const updates = await toolMapper.mapCursorEventToAcp(
    event,
    event.session_id ?? toolSessionId,
  );

  if (shouldEmitToolUpdates) {
    for (const update of updates) {
      await onToolUpdate(update);
    }
  }

  if (toolRouter && proxyExecuteToolCalls) {
    const toolResult = await toolRouter.handleToolCall(event as any, responseMeta);
    if (toolResult) {
      await onToolResult(toolResult);
    }
  }

  return {
    intercepted: false,
    skipConverter: suppressConverterToolEvents,
  };
}

export async function handleToolLoopEventWithFallback(
  options: HandleToolLoopEventWithFallbackOptions,
): Promise<HandleToolLoopEventResult> {
  const {
    boundaryMode,
    autoFallbackToLegacy,
    onFallbackToLegacy,
    ...shared
  } = options;

  if (boundaryMode === "legacy") {
    return handleToolLoopEventLegacy(shared);
  }

  try {
    const result = await handleToolLoopEventV1(shared);
    if (
      result.terminate
      && autoFallbackToLegacy
      && boundaryMode === "v1"
      && result.terminate.reason === "loop_guard"
    ) {
      shared.toolLoopGuard.resetFingerprint(result.terminate.fingerprint);
      onFallbackToLegacy?.(new Error(`loop guard: ${result.terminate.fingerprint}`));
      return handleToolLoopEventLegacy(shared);
    }
    return result;
  } catch (error) {
    if (
      !autoFallbackToLegacy
      || boundaryMode !== "v1"
      || !(error instanceof ToolBoundaryExtractionError)
    ) {
      throw error;
    }
    onFallbackToLegacy?.(error.cause ?? error);
    return handleToolLoopEventLegacy(shared);
  }
}

function evaluateToolLoopGuard(
  toolLoopGuard: ToolLoopGuard,
  toolCall: OpenAiToolCall,
): ToolLoopTermination | null {
  const decision = toolLoopGuard.evaluate(toolCall);
  if (!decision.tracked) {
    return null;
  }
  if (!decision.triggered) {
    return null;
  }

  log.warn("Tool loop guard triggered", {
    tool: toolCall.function.name,
    fingerprint: decision.fingerprint,
    repeatCount: decision.repeatCount,
    maxRepeat: decision.maxRepeat,
    errorClass: decision.errorClass,
  });

  return {
    reason: "loop_guard",
    message:
      `Tool loop guard stopped repeated failing calls to "${toolCall.function.name}" `
      + `after ${decision.repeatCount} attempts (limit ${decision.maxRepeat}). `
      + "Adjust tool arguments and retry.",
    tool: toolCall.function.name,
    fingerprint: decision.fingerprint,
    repeatCount: decision.repeatCount,
    maxRepeat: decision.maxRepeat,
    errorClass: decision.errorClass,
  };
}
