export { CursorPlugin } from "./plugin.js";
export { createCursorProvider, cursor } from "./provider.js";
export type { ProviderOptions } from "./provider.js";
export { createProxyServer } from "./proxy/server.js";
export { parseOpenAIRequest } from "./proxy/handler.js";
export type { ParsedRequest } from "./proxy/handler.js";
export { createChatCompletionResponse, createChatCompletionChunk } from "./proxy/formatter.js";
export { startCursorOAuth, verifyCursorAuth } from "./auth.js";
export type { AuthResult } from "./auth.js";
export { checkAuthStatus, formatStatusOutput } from "./commands/status";
export type { AuthStatus } from "./commands/status";

// Utilities
export { createLogger } from "./utils/logger";
export type { Logger } from "./utils/logger";
export { parseAgentError, formatErrorForUser, stripAnsi } from "./utils/errors";
export type { ParsedError, ErrorType } from "./utils/errors";

// Default export for OpenCode plugin usage
export { CursorPlugin as default } from "./plugin.js";

// Backward compatibility
export { default as createCursorProviderCompat } from "./provider.js";
