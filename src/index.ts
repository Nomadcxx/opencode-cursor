export { CursorPlugin } from "./plugin.js";
export { createCursorProvider, cursor } from "./provider.js";
export type { ProviderOptions } from "./provider.js";
export { createProxyServer, findAvailablePort } from "./proxy/server.js";
export { parseOpenAIRequest } from "./proxy/handler.js";
export type { ParsedRequest } from "./proxy/handler.js";
export { createChatCompletionResponse, createChatCompletionChunk } from "./proxy/formatter.js";
export { verifyCursorAuth } from "./auth.js";
export type { AuthResult } from "./auth.js";
export { checkAuthStatus, formatStatusOutput } from "./commands/status";
export type { AuthStatus } from "./commands/status";

// Utilities
export { createLogger } from "./utils/logger";
export type { Logger } from "./utils/logger";
export { parseAgentError, formatErrorForUser, stripAnsi } from "./utils/errors";
export type { ParsedError, ErrorType } from "./utils/errors";

// Streaming utilities
export { LineBuffer } from "./streaming/line-buffer.js";
export { parseStreamJsonLine } from "./streaming/parser.js";
export { DeltaTracker } from "./streaming/delta-tracker.js";
export { StreamToSseConverter, formatSseChunk, formatSseDone } from "./streaming/openai-sse.js";
export { StreamToAiSdkParts } from "./streaming/ai-sdk-parts.js";
export type {
  StreamJsonAssistantEvent,
  StreamJsonEvent,
  StreamJsonResultEvent,
  StreamJsonSystemEvent,
  StreamJsonThinkingEvent,
  StreamJsonToolCallEvent,
  StreamJsonUserEvent,
} from "./streaming/types.js";

// Default export for OpenCode plugin usage
export { CursorPlugin as default } from "./plugin.js";

// Backward compatibility
export { default as createCursorProviderCompat } from "./provider.js";
