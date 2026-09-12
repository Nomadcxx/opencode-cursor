import { SimpleCursorClient } from "./client/simple.js";
import { createProxyServer } from "./proxy/server.js";
import { parseOpenAIRequest } from "./proxy/handler.js";
import { createChatCompletionResponse, createChatCompletionChunk } from "./proxy/formatter.js";
import { StreamToAiSdkParts } from "./streaming/ai-sdk-parts.js";
import { ToolMapper, type ToolUpdate } from "./acp/tools.js";

export interface ProviderOptions {
  baseURL?: string;
  apiKey?: string;
  mode?: 'direct' | 'proxy';
  proxyConfig?: { port?: number; host?: string };
  toolUpdateCallback?: (updates: ToolUpdate[]) => void;
  sessionId?: string;
}

/**
 * Creates a Cursor ACP provider compatible with OpenCode
 * Exports a factory function for @ai-sdk/provider compatibility
 */
export function createCursorProvider(options: ProviderOptions = {}) {
  const providerOptions = options;
  const mode = options.mode || 'direct';

  if (mode === 'proxy') {
    // Start proxy server
    const proxy = createProxyServer(options.proxyConfig || {});
    let baseURL: string = options.baseURL ?? proxy.getBaseURL();

    // Create the provider object
    const provider = {
      id: "cursor-kilo",
      name: "Cursor ACP Provider (Proxy Mode)",
      proxy,
      baseURL: '',

      /**
       * Initialize the provider (starts the proxy server)
       */
      async init(): Promise<any> {
        baseURL = await proxy.start();
        this.baseURL = baseURL;
        return this;
      },

      /**
       * Returns a language model for the given model ID
       */
      languageModel(modelId: string = "cursor-kilo/auto") {
        const model = modelId.replace("cursor-kilo/", "") || "auto";

        return {
          modelId,
          provider: "cursor-kilo",

          /**
           * Generate text (non-streaming)
           */
          async doGenerate({ prompt, messages }: any) {
            // Use HTTP API
            const response = await fetch(`${baseURL}/chat/completions`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                model: modelId,
                messages: messages || [{ role: "user", content: prompt }],
                stream: false
              })
            });

            const result: any = await response.json();
            return {
              text: result.choices?.[0]?.message?.content || "",
              finishReason: "stop",
              usage: result.usage
            };
          },

          /**
           * Stream text
           */
          async doStream({ prompt, messages }: any) {
            const response = await fetch(`${baseURL}/chat/completions`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                model: modelId,
                messages: messages || [{ role: "user", content: prompt }],
                stream: true
              })
            });

            return {
              stream: response.body,
              rawResponse: { headers: Object.fromEntries(response.headers) }
            };
          }
        };
      }
    };

    return provider;
  }

  // Direct mode - existing implementation
  const client = new SimpleCursorClient({
    timeout: 30000,
    maxRetries: 3
  });

  return {
    id: "cursor-kilo",
    name: "Cursor ACP Provider",

    /**
     * Returns a language model for the given model ID
     */
    languageModel(modelId: string = "cursor-kilo/auto") {
      const model = modelId.replace("cursor-kilo/", "") || "auto";

      return {
        modelId,
        provider: "cursor-kilo",

        /**
         * Generate text (non-streaming)
         */
        async doGenerate(options: any = {}) {
          // Handle both direct prompt and OpenAI-style messages format
          let prompt = "";

          // Try to extract prompt from various sources
          if (options.prompt) {
            // OpenCode passes prompt as array of messages
            if (Array.isArray(options.prompt)) {
              const lines = [];
              for (const msg of options.prompt) {
                if (msg && typeof msg.content === 'string') {
                  lines.push(`${msg.role || 'user'}: ${msg.content}`);
                }
              }
              prompt = lines.join('\n\n');
            } else if (typeof options.prompt === 'string') {
              prompt = options.prompt;
            }
          } else if (options.inputFormat === "messages" && options.messages) {
            // OpenAI-style messages format
            const messages = Array.isArray(options.messages) ? options.messages : [];
            const lines = [];
            for (const msg of messages) {
              if (msg && typeof msg.content === 'string') {
                lines.push(`${msg.role || 'user'}: ${msg.content}`);
              }
            }
            prompt = lines.join('\n\n');
          } else if (options.messages) {
            // Alternative format
            const messages = Array.isArray(options.messages) ? options.messages : [];
            prompt = messages.map((m: any) => m?.content || '').filter(Boolean).join('\n\n');
          }

          // Fallback for empty prompt
          if (!prompt) {
            prompt = "Hello";
          }

          const result = await client.executePrompt(prompt, { model });

          return {
            text: result.content || result.error || "No response",
            finishReason: result.done ? "stop" : "other",
            usage: {
              promptTokens: 0,
              completionTokens: 0
            }
          };
        },

        /**
         * Stream text - returns a proper ReadableStream for pipeThrough support
         */
        async doStream(options: any = {}) {
          // Handle both direct prompt and OpenAI-style messages format
          let prompt = "";

          // Try to extract prompt from various sources
          if (options.prompt) {
            // OpenCode passes prompt as array of messages
            if (Array.isArray(options.prompt)) {
              const lines = [];
              for (const msg of options.prompt) {
                if (msg && typeof msg.content === 'string') {
                  lines.push(`${msg.role || 'user'}: ${msg.content}`);
                }
              }
              prompt = lines.join('\n\n');
            } else if (typeof options.prompt === 'string') {
              prompt = options.prompt;
            }
          } else if (options.inputFormat === "messages" && options.messages) {
            // OpenAI-style messages format
            const messages = Array.isArray(options.messages) ? options.messages : [];
            const lines = [];
            for (const msg of messages) {
              if (msg && typeof msg.content === 'string') {
                lines.push(`${msg.role || 'user'}: ${msg.content}`);
              }
            }
            prompt = lines.join('\n\n');
          } else if (options.messages) {
            // Alternative format
            const messages = Array.isArray(options.messages) ? options.messages : [];
            prompt = messages.map((m: any) => m?.content || '').filter(Boolean).join('\n\n');
          }

          // Fallback for empty prompt
          if (!prompt) {
            prompt = "Hello";
          }

          const stream = client.executePromptStream(prompt, { model });
          const converter = new StreamToAiSdkParts();
          const toolMapper = providerOptions.toolUpdateCallback ? new ToolMapper() : null;
          const toolSessionId = providerOptions.sessionId
            ?? `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

          // Create a proper ReadableStream that OpenCode can use with pipeThrough
          const readableStream = new ReadableStream({
            async start(controller) {
              try {
                for await (const event of stream) {
                  if (toolMapper && event.type === "tool_call") {
                    const updates = await toolMapper.mapCursorEventToAcp(
                      event,
                      event.session_id ?? toolSessionId,
                    );
                    if (updates.length > 0) {
                      providerOptions.toolUpdateCallback?.(updates);
                    }
                  }
                  const parts = converter.handleEvent(event);
                  for (const part of parts) {
                    controller.enqueue(part);
                  }
                }
                controller.enqueue({ type: "text-delta", textDelta: "" });
                controller.close();
              } catch (error) {
                controller.error(error);
              }
            },
          });

          return {
            stream: readableStream,
            rawResponse: { headers: {} }
          };
        }
      };
    }
  };
}

// Factory function export for OpenCode compatibility
export const cursor = createCursorProvider;

// Default export
export default createCursorProvider;
