export { CursorPlugin } from "./plugin.js";
export { createCursorProvider, cursor, ProviderOptions } from "./provider.js";
export { createProxyServer } from "./proxy/server.js";
export { parseOpenAIRequest, ParsedRequest } from "./proxy/handler.js";
export { createChatCompletionResponse, createChatCompletionChunk } from "./proxy/formatter.js";

// Default export for OpenCode provider usage
export { default } from "./provider.js";

// Backward compatibility
export { createCursorProvider as cursorProvider };
