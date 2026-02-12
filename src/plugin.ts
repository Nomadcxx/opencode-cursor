import type { Plugin, PluginInput } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import type { Auth } from "@opencode-ai/sdk";
import { mkdir } from "fs/promises";
import { homedir } from "os";
import { isAbsolute, join, resolve } from "path";
import { ToolMapper, type ToolUpdate } from "./acp/tools.js";
import { startCursorOAuth } from "./auth";
import { LineBuffer } from "./streaming/line-buffer.js";
import { StreamToSseConverter, formatSseDone } from "./streaming/openai-sse.js";
import { parseStreamJsonLine } from "./streaming/parser.js";
import { extractText, extractThinking, isAssistantText, isThinking } from "./streaming/types.js";
import { createLogger } from "./utils/logger";
import { RequestPerf } from "./utils/perf";
import { parseAgentError, formatErrorForUser, stripAnsi } from "./utils/errors";
import { buildPromptFromMessages } from "./proxy/prompt-builder.js";
import {
  extractAllowedToolNames,
  type OpenAiToolCall,
} from "./proxy/tool-loop.js";
import { OpenCodeToolDiscovery } from "./tools/discovery.js";
import { toOpenAiParameters, describeTool } from "./tools/schema.js";
import { ToolRouter } from "./tools/router.js";
import { SkillLoader } from "./tools/skills/loader.js";
import { SkillResolver } from "./tools/skills/resolver.js";
import { createOpencodeClient } from "@opencode-ai/sdk";
import { ToolRegistry as CoreRegistry } from "./tools/core/registry.js";
import { LocalExecutor } from "./tools/executors/local.js";
import { SdkExecutor } from "./tools/executors/sdk.js";
import { McpExecutor } from "./tools/executors/mcp.js";
import { executeWithChain } from "./tools/core/executor.js";
import { registerDefaultTools } from "./tools/defaults.js";
import type { IToolExecutor } from "./tools/core/types.js";
import {
  createProviderBoundary,
  parseProviderBoundaryMode,
  type ProviderBoundary,
  type ToolLoopMode,
  type ToolOptionResolution,
} from "./provider/boundary.js";
import { handleToolLoopEventWithFallback } from "./provider/runtime-interception.js";
import { buildToolSchemaMap } from "./provider/tool-schema-compat.js";
import {
  createToolLoopGuard,
  parseToolLoopMaxRepeat,
  type ToolLoopGuard,
} from "./provider/tool-loop-guard.js";

const log = createLogger("plugin");

export async function ensurePluginDirectory(): Promise<void> {
  const pluginDir = join(homedir(), ".config", "opencode", "plugin");
  try {
    await mkdir(pluginDir, { recursive: true });
    log.debug("Plugin directory ensured", { path: pluginDir });
  } catch (error) {
    log.warn("Failed to create plugin directory", { error: String(error) });
  }
}

const CURSOR_PROVIDER_ID = "cursor-acp";
const CURSOR_PROXY_HOST = "127.0.0.1";
const CURSOR_PROXY_DEFAULT_PORT = 32124;
const CURSOR_PROXY_DEFAULT_BASE_URL = `http://${CURSOR_PROXY_HOST}:${CURSOR_PROXY_DEFAULT_PORT}/v1`;
const REUSE_EXISTING_PROXY = process.env.CURSOR_ACP_REUSE_EXISTING_PROXY !== "false";

function getGlobalKey(): string {
  return "__opencode_cursor_proxy_server__";
}

const FORCE_TOOL_MODE = process.env.CURSOR_ACP_FORCE !== "false";
const EMIT_TOOL_UPDATES = process.env.CURSOR_ACP_EMIT_TOOL_UPDATES === "true";
const FORWARD_TOOL_CALLS = process.env.CURSOR_ACP_FORWARD_TOOL_CALLS !== "false";

function parseToolLoopMode(value: string | undefined): { mode: ToolLoopMode; valid: boolean } {
  const normalized = (value ?? "opencode").trim().toLowerCase();
  if (normalized === "opencode" || normalized === "proxy-exec" || normalized === "off") {
    return { mode: normalized, valid: true };
  }
  return { mode: "opencode", valid: false };
}

const TOOL_LOOP_MODE_RAW = process.env.CURSOR_ACP_TOOL_LOOP_MODE;
const { mode: TOOL_LOOP_MODE, valid: TOOL_LOOP_MODE_VALID } = parseToolLoopMode(TOOL_LOOP_MODE_RAW);
const PROVIDER_BOUNDARY_MODE_RAW = process.env.CURSOR_ACP_PROVIDER_BOUNDARY;
const {
  mode: PROVIDER_BOUNDARY_MODE,
  valid: PROVIDER_BOUNDARY_MODE_VALID,
} = parseProviderBoundaryMode(PROVIDER_BOUNDARY_MODE_RAW);
const LEGACY_PROVIDER_BOUNDARY = createProviderBoundary("legacy", CURSOR_PROVIDER_ID);
const PROVIDER_BOUNDARY =
  PROVIDER_BOUNDARY_MODE === "legacy"
    ? LEGACY_PROVIDER_BOUNDARY
    : createProviderBoundary(PROVIDER_BOUNDARY_MODE, CURSOR_PROVIDER_ID);
const ENABLE_PROVIDER_BOUNDARY_AUTOFALLBACK =
  process.env.CURSOR_ACP_PROVIDER_BOUNDARY_AUTOFALLBACK !== "false";
const TOOL_LOOP_MAX_REPEAT_RAW = process.env.CURSOR_ACP_TOOL_LOOP_MAX_REPEAT;
const {
  value: TOOL_LOOP_MAX_REPEAT,
  valid: TOOL_LOOP_MAX_REPEAT_VALID,
} = parseToolLoopMaxRepeat(TOOL_LOOP_MAX_REPEAT_RAW);
const {
  proxyExecuteToolCalls: PROXY_EXECUTE_TOOL_CALLS,
  suppressConverterToolEvents: SUPPRESS_CONVERTER_TOOL_EVENTS,
  shouldEmitToolUpdates: SHOULD_EMIT_TOOL_UPDATES,
} = PROVIDER_BOUNDARY.computeToolLoopFlags(
  TOOL_LOOP_MODE,
  FORWARD_TOOL_CALLS,
  EMIT_TOOL_UPDATES,
);

export function resolveChatParamTools(
  mode: ToolLoopMode,
  existingTools: unknown,
  refreshedTools: Array<any>,
): ToolOptionResolution {
  return PROVIDER_BOUNDARY.resolveChatParamTools(mode, existingTools, refreshedTools);
}

function createChatCompletionResponse(model: string, content: string, reasoningContent?: string) {
  const message: { role: "assistant"; content: string; reasoning_content?: string } = {
    role: "assistant",
    content,
  };

  if (reasoningContent && reasoningContent.length > 0) {
    message.reasoning_content = reasoningContent;
  }

  return {
    id: `cursor-acp-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: "stop",
      },
    ],
  };
}

function createChatCompletionChunk(id: string, created: number, model: string, deltaContent: string, done = false) {
  return {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [
      {
        index: 0,
        delta: deltaContent ? { content: deltaContent } : {},
        finish_reason: done ? "stop" : null,
      },
    ],
  };
}

function extractCompletionFromStream(output: string): { assistantText: string; reasoningText: string } {
  const lines = output.split("\n");
  let assistantText = "";
  let reasoningText = "";
  let sawAssistantPartials = false;

  for (const line of lines) {
    const event = parseStreamJsonLine(line);
    if (!event) {
      continue;
    }

    if (isAssistantText(event)) {
      const text = extractText(event);
      if (!text) continue;

      const isPartial = typeof (event as any).timestamp_ms === "number";
      if (isPartial) {
        assistantText += text;
        sawAssistantPartials = true;
      } else if (!sawAssistantPartials) {
        assistantText = text;
      }
    }

    if (isThinking(event)) {
      const thinking = extractThinking(event);
      if (thinking) {
        reasoningText += thinking;
      }
    }
  }

  return { assistantText, reasoningText };
}

function formatToolUpdateEvent(update: ToolUpdate): string {
  return `event: tool_update\ndata: ${JSON.stringify(update)}\n\n`;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function createBoundaryRuntimeContext(scope: string) {
  let activeBoundary = PROVIDER_BOUNDARY;
  let fallbackActive = false;

  const canAutoFallback = ENABLE_PROVIDER_BOUNDARY_AUTOFALLBACK && PROVIDER_BOUNDARY.mode === "v1";

  const activateLegacyFallback = (operation: string, error: unknown): boolean => {
    if (!canAutoFallback || activeBoundary.mode === "legacy") {
      return false;
    }

    activeBoundary = LEGACY_PROVIDER_BOUNDARY;
    const details = {
      scope,
      operation,
      error: toErrorMessage(error),
    };
    if (!fallbackActive) {
      log.warn("Provider boundary v1 failed; switching to legacy for this request", details);
    } else {
      log.debug("Provider boundary fallback already active", details);
    }
    fallbackActive = true;
    return true;
  };

  return {
    getBoundary(): ProviderBoundary {
      return activeBoundary;
    },

    run<T>(operation: string, fn: (boundary: ProviderBoundary) => T): T {
      try {
        return fn(activeBoundary);
      } catch (error) {
        if (!activateLegacyFallback(operation, error)) {
          throw error;
        }
        return fn(activeBoundary);
      }
    },

    async runAsync<T>(operation: string, fn: (boundary: ProviderBoundary) => Promise<T>): Promise<T> {
      try {
        return await fn(activeBoundary);
      } catch (error) {
        if (!activateLegacyFallback(operation, error)) {
          throw error;
        }
        return fn(activeBoundary);
      }
    },

    activateLegacyFallback(operation: string, error: unknown) {
      activateLegacyFallback(operation, error);
    },

    isFallbackActive(): boolean {
      return fallbackActive;
    },
  };
}

async function findFirstAllowedToolCallInOutput(
  output: string,
  options: {
    toolLoopMode: ToolLoopMode;
    allowedToolNames: Set<string>;
    toolSchemaMap: Map<string, unknown>;
    toolLoopGuard: ToolLoopGuard;
    boundaryContext: ReturnType<typeof createBoundaryRuntimeContext>;
    responseMeta: { id: string; created: number; model: string };
  },
): Promise<{ toolCall: OpenAiToolCall | null; terminationMessage: string | null }> {
  if (options.allowedToolNames.size === 0 || !output) {
    return { toolCall: null, terminationMessage: null };
  }

  const toolMapper = new ToolMapper();
  const toolSessionId = options.responseMeta.id;

  for (const line of output.split("\n")) {
    const event = parseStreamJsonLine(line);
    if (!event || event.type !== "tool_call") {
      continue;
    }

    let interceptedToolCall: OpenAiToolCall | null = null;
    const result = await handleToolLoopEventWithFallback({
      event: event as any,
      boundary: options.boundaryContext.getBoundary(),
      boundaryMode: options.boundaryContext.getBoundary().mode,
      autoFallbackToLegacy: ENABLE_PROVIDER_BOUNDARY_AUTOFALLBACK,
      toolLoopMode: options.toolLoopMode,
      allowedToolNames: options.allowedToolNames,
      toolSchemaMap: options.toolSchemaMap,
      toolLoopGuard: options.toolLoopGuard,
      toolMapper,
      toolSessionId,
      shouldEmitToolUpdates: false,
      proxyExecuteToolCalls: false,
      suppressConverterToolEvents: false,
      responseMeta: options.responseMeta,
      onToolUpdate: () => {},
      onToolResult: () => {},
      onInterceptedToolCall: (toolCall) => {
        interceptedToolCall = toolCall;
      },
      onFallbackToLegacy: (error) => {
        options.boundaryContext.activateLegacyFallback("findFirstAllowedToolCallInOutput", error);
      },
    });

    if (result.terminate) {
      return {
        toolCall: null,
        terminationMessage: result.terminate.message,
      };
    }
    if (result.intercepted && interceptedToolCall) {
      return {
        toolCall: interceptedToolCall,
        terminationMessage: null,
      };
    }
  }

  return { toolCall: null, terminationMessage: null };
}

async function ensureCursorProxyServer(workspaceDirectory: string, toolRouter?: ToolRouter): Promise<string> {
  const key = getGlobalKey();
  const g = globalThis as any;

  const existingBaseURL = g[key]?.baseURL;
  if (typeof existingBaseURL === "string" && existingBaseURL.length > 0) {
    return existingBaseURL;
  }

  // Mark as starting to avoid duplicate starts in-process.
  g[key] = { baseURL: "" };

      const handler = async (req: Request): Promise<Response> => {
        try {
          const url = new URL(req.url);

      if (url.pathname === "/health") {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      // Dynamic model discovery via cursor-agent models
      if (url.pathname === "/v1/models" || url.pathname === "/models") {
        try {
          const bunAny = globalThis as any;
          const proc = bunAny.Bun.spawn(["cursor-agent", "models"], {
            stdout: "pipe",
            stderr: "pipe",
          });
          const output = await new Response(proc.stdout).text();
          await proc.exited;

          const models: Array<{ id: string; object: string; created: number; owned_by: string }> = [];
          const lines = stripAnsi(output).split("\n");
          for (const line of lines) {
            // Format: "model-id - Display Name [(current)] [(default)]"
            const match = line.match(/^([a-z0-9.-]+)\s+-\s+(.+?)(?:\s+\((current|default)\))*\s*$/i);
            if (match) {
              models.push({
                id: match[1],
                object: "model",
                created: Math.floor(Date.now() / 1000),
                owned_by: "cursor",
              });
            }
          }

          return new Response(JSON.stringify({ object: "list", data: models }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        } catch (err) {
          log.error("Failed to list models", { error: String(err) });
          return new Response(JSON.stringify({ error: "Failed to fetch models from cursor-agent" }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }
      }

      if (url.pathname !== "/v1/chat/completions" && url.pathname !== "/chat/completions") {
        return new Response(JSON.stringify({ error: `Unsupported path: ${url.pathname}` }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }

      log.debug("Proxy request (bun)", { method: req.method, path: url.pathname });
      const body: any = await req.json().catch(() => ({}));
      const messages: Array<any> = Array.isArray(body?.messages) ? body.messages : [];
      const stream = body?.stream === true;
      const tools = Array.isArray(body?.tools) ? body.tools : [];
      const allowedToolNames = extractAllowedToolNames(tools);
      const toolSchemaMap = buildToolSchemaMap(tools);
      const toolLoopGuard = createToolLoopGuard(messages, TOOL_LOOP_MAX_REPEAT);
      const boundaryContext = createBoundaryRuntimeContext("bun-handler");

      const prompt = buildPromptFromMessages(messages, tools);
      const model = boundaryContext.run("normalizeRuntimeModel", (boundary) =>
        boundary.normalizeRuntimeModel(body?.model),
      );
      log.debug("Proxy chat request (bun)", {
        stream,
        model,
        messages: messages.length,
        tools: tools.length,
        promptChars: prompt.length,
      });

      const bunAny = globalThis as any;
      if (!bunAny.Bun?.spawn) {
        return new Response(JSON.stringify({ error: "This provider requires Bun runtime." }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }

      const cmd = [
        "cursor-agent",
        "--print",
        "--output-format",
        "stream-json",
        "--stream-partial-output",
        "--workspace",
        workspaceDirectory,
        "--model",
        model,
      ];
      if (FORCE_TOOL_MODE) {
        cmd.push("--force");
      }

      const child = bunAny.Bun.spawn({
        cmd,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: bunAny.Bun.env,
      });

      // Write prompt to stdin to avoid E2BIG error
      child.stdin.write(prompt);
      child.stdin.end();

      if (!stream) {
        const [stdoutText, stderrText] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);

        const stdout = (stdoutText || "").trim();
        const stderr = (stderrText || "").trim();
        const exitCode = child.exitCode;
        log.debug("cursor-agent completed (bun non-stream)", {
          exitCode,
          stdoutChars: stdout.length,
          stderrChars: stderr.length,
        });
        const meta = {
          id: `cursor-acp-${Date.now()}`,
          created: Math.floor(Date.now() / 1000),
          model,
        };
        const intercepted = await findFirstAllowedToolCallInOutput(stdout, {
          toolLoopMode: TOOL_LOOP_MODE,
          allowedToolNames,
          toolSchemaMap,
          toolLoopGuard,
          boundaryContext,
          responseMeta: meta,
        });
        if (intercepted.terminationMessage) {
          const payload = createChatCompletionResponse(model, intercepted.terminationMessage);
          return new Response(JSON.stringify(payload), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        if (intercepted.toolCall) {
          log.debug("Intercepted OpenCode tool call (non-stream)", {
            name: intercepted.toolCall.function.name,
            callId: intercepted.toolCall.id,
          });
          const payload = boundaryContext.run(
            "createNonStreamToolCallResponse",
            (boundary) => boundary.createNonStreamToolCallResponse(meta, intercepted.toolCall),
          );
          return new Response(JSON.stringify(payload), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        if (exitCode !== 0) {
          const errSource =
            stderr
            || stdout
            || `cursor-agent exited with code ${String(exitCode ?? "unknown")} and no output`;
          const parsed = parseAgentError(errSource);
          const userError = formatErrorForUser(parsed);
          log.error("cursor-cli failed", {
            type: parsed.type,
            message: parsed.message,
            code: exitCode,
          });
          // Return error as chat completion so user always sees it
          const errorPayload = createChatCompletionResponse(model, userError);
          return new Response(JSON.stringify(errorPayload), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        const completion = extractCompletionFromStream(stdout);
        const payload = createChatCompletionResponse(
          model,
          completion.assistantText || stdout || stderr,
          completion.reasoningText || undefined,
        );
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      // Streaming.
      const encoder = new TextEncoder();
      const id = `cursor-acp-${Date.now()}`;
      const created = Math.floor(Date.now() / 1000);
      const perf = new RequestPerf(id);
      const toolMapper = new ToolMapper();
      const toolSessionId = id;

      perf.mark("spawn");
      const sse = new ReadableStream({
        async start(controller) {
          let streamTerminated = false;
          let firstTokenReceived = false;
          try {
            const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
            const converter = new StreamToSseConverter(model, { id, created });
            const lineBuffer = new LineBuffer();
            const emitToolCallAndTerminate = (toolCall: OpenAiToolCall) => {
              log.debug("Intercepted OpenCode tool call (stream)", {
                name: toolCall.function.name,
                callId: toolCall.id,
              });
              const streamChunks = boundaryContext.run(
                "createStreamToolCallChunks",
                (boundary) =>
                  boundary.createStreamToolCallChunks({ id, created, model }, toolCall),
              );
              for (const chunk of streamChunks) {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
              }
              controller.enqueue(encoder.encode(formatSseDone()));
              streamTerminated = true;
              try {
                child.kill();
              } catch {
                // ignore
              }
            };
            const emitTerminalAssistantErrorAndTerminate = (message: string) => {
              if (streamTerminated) {
                return;
              }
              const errChunk = createChatCompletionChunk(id, created, model, message, true);
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(errChunk)}\n\n`));
              controller.enqueue(encoder.encode(formatSseDone()));
              streamTerminated = true;
              try {
                child.kill();
              } catch {
                // ignore
              }
            };

            while (true) {
              if (streamTerminated) break;
              const { value, done } = await reader.read();
              if (done) break;
              if (!value || value.length === 0) continue;
              if (!firstTokenReceived) { perf.mark("first-token"); firstTokenReceived = true; }

              for (const line of lineBuffer.push(value)) {
                if (streamTerminated) break;
                const event = parseStreamJsonLine(line);
                if (!event) {
                  continue;
                }

                if (event.type === "tool_call") {
                  perf.mark("tool-call");
                  const result = await handleToolLoopEventWithFallback({
                    event: event as any,
                    boundary: boundaryContext.getBoundary(),
                    boundaryMode: boundaryContext.getBoundary().mode,
                    autoFallbackToLegacy: ENABLE_PROVIDER_BOUNDARY_AUTOFALLBACK,
                    toolLoopMode: TOOL_LOOP_MODE,
                    allowedToolNames,
                    toolSchemaMap,
                    toolLoopGuard,
                    toolMapper,
                    toolSessionId,
                    shouldEmitToolUpdates: SHOULD_EMIT_TOOL_UPDATES,
                    proxyExecuteToolCalls: PROXY_EXECUTE_TOOL_CALLS,
                    suppressConverterToolEvents: SUPPRESS_CONVERTER_TOOL_EVENTS,
                    toolRouter,
                    responseMeta: { id, created, model },
                    onToolUpdate: (update) => {
                      controller.enqueue(encoder.encode(formatToolUpdateEvent(update)));
                    },
                    onToolResult: (toolResult) => {
                      controller.enqueue(encoder.encode(`data: ${JSON.stringify(toolResult)}\n\n`));
                    },
                    onInterceptedToolCall: (toolCall) => {
                      emitToolCallAndTerminate(toolCall);
                    },
                    onFallbackToLegacy: (error) => {
                      boundaryContext.activateLegacyFallback("handleToolLoopEvent", error);
                    },
                  });
                  if (result.terminate) {
                    emitTerminalAssistantErrorAndTerminate(result.terminate.message);
                    break;
                  }
                  if (result.intercepted) {
                    break;
                  }
                  if (result.skipConverter) {
                    continue;
                  }
                }

                for (const sse of converter.handleEvent(event)) {
                  controller.enqueue(encoder.encode(sse));
                }
              }
            }
            if (streamTerminated) {
              return;
            }

            for (const line of lineBuffer.flush()) {
              if (streamTerminated) break;
              const event = parseStreamJsonLine(line);
              if (!event) {
                continue;
              }
              if (event.type === "tool_call") {
                const result = await handleToolLoopEventWithFallback({
                  event: event as any,
                  boundary: boundaryContext.getBoundary(),
                  boundaryMode: boundaryContext.getBoundary().mode,
                  autoFallbackToLegacy: ENABLE_PROVIDER_BOUNDARY_AUTOFALLBACK,
                  toolLoopMode: TOOL_LOOP_MODE,
                  allowedToolNames,
                  toolSchemaMap,
                  toolLoopGuard,
                  toolMapper,
                  toolSessionId,
                  shouldEmitToolUpdates: SHOULD_EMIT_TOOL_UPDATES,
                  proxyExecuteToolCalls: PROXY_EXECUTE_TOOL_CALLS,
                  suppressConverterToolEvents: SUPPRESS_CONVERTER_TOOL_EVENTS,
                  toolRouter,
                  responseMeta: { id, created, model },
                  onToolUpdate: (update) => {
                    controller.enqueue(encoder.encode(formatToolUpdateEvent(update)));
                  },
                  onToolResult: (toolResult) => {
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify(toolResult)}\n\n`));
                  },
                  onInterceptedToolCall: (toolCall) => {
                    emitToolCallAndTerminate(toolCall);
                  },
                  onFallbackToLegacy: (error) => {
                    boundaryContext.activateLegacyFallback("handleToolLoopEvent.flush", error);
                  },
                });
                if (result.terminate) {
                  emitTerminalAssistantErrorAndTerminate(result.terminate.message);
                  break;
                }
                if (result.intercepted) {
                  break;
                }
                if (result.skipConverter) {
                  continue;
                }
              }
              for (const sse of converter.handleEvent(event)) {
                controller.enqueue(encoder.encode(sse));
              }
            }
            if (streamTerminated) {
              return;
            }

            if (child.exitCode !== 0) {
              const stderrText = await new Response(child.stderr).text();
              const errSource = (stderrText || "").trim()
                || `cursor-agent exited with code ${String(child.exitCode ?? "unknown")} and no output`;
              const parsed = parseAgentError(errSource);
              const msg = formatErrorForUser(parsed);
              log.error("cursor-cli streaming failed", {
                type: parsed.type,
                code: child.exitCode,
              });
              const errChunk = createChatCompletionChunk(id, created, model, msg, true);
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(errChunk)}\n\n`));
              controller.enqueue(encoder.encode(formatSseDone()));
              return;
            }

            log.debug("cursor-agent completed (bun stream)", {
              exitCode: child.exitCode,
            });
            const doneChunk = createChatCompletionChunk(id, created, model, "", true);
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(doneChunk)}\n\n`));
            controller.enqueue(encoder.encode(formatSseDone()));
          } finally {
            perf.mark("request:done");
            perf.summarize();
            controller.close();
          }
        },
      });

      return new Response(sse, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return new Response(JSON.stringify({ error: message }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  };

  if (REUSE_EXISTING_PROXY) {
    // Check if another process already started a proxy on the default port
    try {
      const res = await fetch(`http://${CURSOR_PROXY_HOST}:${CURSOR_PROXY_DEFAULT_PORT}/health`).catch(() => null);
      if (res && res.ok) {
        g[key].baseURL = CURSOR_PROXY_DEFAULT_BASE_URL;
        return CURSOR_PROXY_DEFAULT_BASE_URL;
      }
    } catch {
      // ignore
    }
  }

  // Use Node.js http server (works in both Node and Bun)
  const http = await import("http");
  const { spawn } = await import("child_process");

  const requestHandler = async (req: any, res: any) => {
    try{
      const url = new URL(req.url || "/", `http://${req.headers.host}`);

      if (url.pathname === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      // Dynamic model discovery via cursor-agent models (Node.js handler)
      if (url.pathname === "/v1/models" || url.pathname === "/models") {
        try {
          const { execSync } = await import("child_process");
          const output = execSync("cursor-agent models", { encoding: "utf-8", timeout: 30000 });
          const clean = stripAnsi(output);
          const models: Array<{ id: string; object: string; created: number; owned_by: string }> = [];
          for (const line of clean.split("\n")) {
            const match = line.match(/^([a-z0-9.-]+)\s+-\s+(.+?)(?:\s+\((current|default)\))*\s*$/i);
            if (match) {
              models.push({
                id: match[1],
                object: "model",
                created: Math.floor(Date.now() / 1000),
                owned_by: "cursor",
              });
            }
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ object: "list", data: models }));
        } catch (err) {
          log.error("Failed to list models", { error: String(err) });
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Failed to fetch models" }));
        }
        return;
      }

      if (url.pathname !== "/v1/chat/completions" && url.pathname !== "/chat/completions") {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `Unsupported path: ${url.pathname}` }));
        return;
      }

      log.debug("Proxy request (node)", { method: req.method, path: url.pathname });
      let body = "";
      for await (const chunk of req) {
        body += chunk;
      }

      const bodyData: any = JSON.parse(body || "{}");
      const messages: Array<any> = Array.isArray(bodyData?.messages) ? bodyData.messages : [];
      const stream = bodyData?.stream === true;
      const tools = Array.isArray(bodyData?.tools) ? bodyData.tools : [];
      const allowedToolNames = extractAllowedToolNames(tools);
      const toolSchemaMap = buildToolSchemaMap(tools);
      const toolLoopGuard = createToolLoopGuard(messages, TOOL_LOOP_MAX_REPEAT);
      const boundaryContext = createBoundaryRuntimeContext("node-handler");

      const prompt = buildPromptFromMessages(messages, tools);
      const model = boundaryContext.run("normalizeRuntimeModel", (boundary) =>
        boundary.normalizeRuntimeModel(bodyData?.model),
      );
      log.debug("Proxy chat request (node)", {
        stream,
        model,
        messages: messages.length,
        tools: tools.length,
        promptChars: prompt.length,
      });

      const cmd = [
        "cursor-agent",
        "--print",
        "--output-format",
        "stream-json",
        "--stream-partial-output",
        "--workspace",
        workspaceDirectory,
        "--model",
        model,
      ];
      if (FORCE_TOOL_MODE) {
        cmd.push("--force");
      }

      const child = spawn(cmd[0], cmd.slice(1), { stdio: ["pipe", "pipe", "pipe"] });

      // Write prompt to stdin to avoid E2BIG error
      child.stdin.write(prompt);
      child.stdin.end();

      if (!stream) {
        const stdoutChunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];
        let spawnErrorText: string | null = null;

        child.on("error", (error: any) => {
          spawnErrorText = String(error?.message || error);
          log.error("Failed to spawn cursor-agent", { error: spawnErrorText, model });
        });

        child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
        child.stderr.on("data", (chunk) => stderrChunks.push(chunk));

        child.on("close", async (code) => {
          const stdout = Buffer.concat(stdoutChunks).toString().trim();
          const stderr = Buffer.concat(stderrChunks).toString().trim();
          log.debug("cursor-agent completed (node non-stream)", {
            code,
            stdoutChars: stdout.length,
            stderrChars: stderr.length,
            spawnError: spawnErrorText != null,
          });
          const meta = {
            id: `cursor-acp-${Date.now()}`,
            created: Math.floor(Date.now() / 1000),
            model,
          };
          const intercepted = await findFirstAllowedToolCallInOutput(stdout, {
            toolLoopMode: TOOL_LOOP_MODE,
            allowedToolNames,
            toolSchemaMap,
            toolLoopGuard,
            boundaryContext,
            responseMeta: meta,
          });
          if (intercepted.terminationMessage) {
            const terminationResponse = createChatCompletionResponse(model, intercepted.terminationMessage);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(terminationResponse));
            return;
          }

          if (intercepted.toolCall) {
            log.debug("Intercepted OpenCode tool call (non-stream)", {
              name: intercepted.toolCall.function.name,
              callId: intercepted.toolCall.id,
            });
            const payload = boundaryContext.run(
              "createNonStreamToolCallResponse",
              (boundary) => boundary.createNonStreamToolCallResponse(meta, intercepted.toolCall),
            );
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(payload));
            return;
          }

          const completion = extractCompletionFromStream(stdout);

          if (code !== 0 || spawnErrorText) {
            const errSource =
              stderr
              || stdout
              || spawnErrorText
              || `cursor-agent exited with code ${String(code ?? "unknown")} and no output`;
            const parsed = parseAgentError(errSource);
            const userError = formatErrorForUser(parsed);
            log.error("cursor-cli failed", {
              type: parsed.type,
              message: parsed.message,
              code,
            });
            // Return error as chat completion so user always sees it
            const errorResponse = createChatCompletionResponse(model, userError);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(errorResponse));
            return;
          }

          const response = createChatCompletionResponse(
            model,
            completion.assistantText || stdout || stderr,
            completion.reasoningText || undefined,
          );

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(response));
        });
      } else {
        // Streaming
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });

        const id = `cursor-acp-${Date.now()}`;
        const created = Math.floor(Date.now() / 1000);
        const perf = new RequestPerf(id);
        perf.mark("spawn");

        const converter = new StreamToSseConverter(model, { id, created });
        const lineBuffer = new LineBuffer();
        const toolMapper = new ToolMapper();
        const toolSessionId = id;
        const stderrChunks: Buffer[] = [];
        let streamTerminated = false;
        let firstTokenReceived = false;
        child.stderr.on("data", (chunk) => {
          stderrChunks.push(Buffer.from(chunk));
        });
        child.on("error", (error: any) => {
          if (streamTerminated || res.writableEnded) {
            return;
          }
          const errSource = String(error?.message || error);
          log.error("Failed to spawn cursor-agent (stream)", { error: errSource, model });
          const parsed = parseAgentError(errSource);
          const msg = formatErrorForUser(parsed);
          const errChunk = createChatCompletionChunk(id, created, model, msg, true);
          res.write(`data: ${JSON.stringify(errChunk)}\n\n`);
          res.write(formatSseDone());
          streamTerminated = true;
          res.end();
        });
        const emitToolCallAndTerminate = (toolCall: OpenAiToolCall) => {
          if (streamTerminated || res.writableEnded) {
            return;
          }
          log.debug("Intercepted OpenCode tool call (stream)", {
            name: toolCall.function.name,
            callId: toolCall.id,
          });
          const streamChunks = boundaryContext.run(
            "createStreamToolCallChunks",
            (boundary) =>
              boundary.createStreamToolCallChunks({ id, created, model }, toolCall),
          );
          for (const chunk of streamChunks) {
            res.write(`data: ${JSON.stringify(chunk)}\n\n`);
          }
          res.write(formatSseDone());
          streamTerminated = true;
          res.end();
          try {
            child.kill();
          } catch {
            // ignore
          }
        };
        const emitTerminalAssistantErrorAndTerminate = (message: string) => {
          if (streamTerminated || res.writableEnded) {
            return;
          }
          const errChunk = createChatCompletionChunk(id, created, model, message, true);
          res.write(`data: ${JSON.stringify(errChunk)}\n\n`);
          res.write(formatSseDone());
          streamTerminated = true;
          res.end();
          try {
            child.kill();
          } catch {
            // ignore
          }
        };

        child.stdout.on("data", async (chunk) => {
          if (streamTerminated || res.writableEnded) {
            return;
          }
          if (!firstTokenReceived) { perf.mark("first-token"); firstTokenReceived = true; }
          for (const line of lineBuffer.push(chunk)) {
            if (streamTerminated || res.writableEnded) {
              break;
            }
            const event = parseStreamJsonLine(line);
            if (!event) {
              continue;
            }

            if (event.type === "tool_call") {
              perf.mark("tool-call");
              const result = await handleToolLoopEventWithFallback({
                event: event as any,
                boundary: boundaryContext.getBoundary(),
                boundaryMode: boundaryContext.getBoundary().mode,
                autoFallbackToLegacy: ENABLE_PROVIDER_BOUNDARY_AUTOFALLBACK,
                toolLoopMode: TOOL_LOOP_MODE,
                allowedToolNames,
                toolSchemaMap,
                toolLoopGuard,
                toolMapper,
                toolSessionId,
                shouldEmitToolUpdates: SHOULD_EMIT_TOOL_UPDATES,
                proxyExecuteToolCalls: PROXY_EXECUTE_TOOL_CALLS,
                suppressConverterToolEvents: SUPPRESS_CONVERTER_TOOL_EVENTS,
                toolRouter,
                responseMeta: { id, created, model },
                onToolUpdate: (update) => {
                  res.write(formatToolUpdateEvent(update));
                },
                onToolResult: (toolResult) => {
                  res.write(`data: ${JSON.stringify(toolResult)}\n\n`);
                },
                onInterceptedToolCall: (toolCall) => {
                  emitToolCallAndTerminate(toolCall);
                },
                onFallbackToLegacy: (error) => {
                  boundaryContext.activateLegacyFallback("handleToolLoopEvent", error);
                },
              });
              if (result.terminate) {
                emitTerminalAssistantErrorAndTerminate(result.terminate.message);
                break;
              }
              if (result.intercepted) {
                break;
              }
              if (result.skipConverter) {
                continue;
              }
            }

            if (streamTerminated || res.writableEnded) {
              break;
            }
            for (const sse of converter.handleEvent(event)) {
              res.write(sse);
            }
          }
        });

        child.on("close", async (code) => {
          if (streamTerminated || res.writableEnded) {
            return;
          }
          for (const line of lineBuffer.flush()) {
            if (streamTerminated || res.writableEnded) {
              break;
            }
            const event = parseStreamJsonLine(line);
            if (!event) {
              continue;
            }

            if (event.type === "tool_call") {
              const result = await handleToolLoopEventWithFallback({
                event: event as any,
                boundary: boundaryContext.getBoundary(),
                boundaryMode: boundaryContext.getBoundary().mode,
                autoFallbackToLegacy: ENABLE_PROVIDER_BOUNDARY_AUTOFALLBACK,
                toolLoopMode: TOOL_LOOP_MODE,
                allowedToolNames,
                toolSchemaMap,
                toolLoopGuard,
                toolMapper,
                toolSessionId,
                shouldEmitToolUpdates: SHOULD_EMIT_TOOL_UPDATES,
                proxyExecuteToolCalls: PROXY_EXECUTE_TOOL_CALLS,
                suppressConverterToolEvents: SUPPRESS_CONVERTER_TOOL_EVENTS,
                toolRouter,
                responseMeta: { id, created, model },
                onToolUpdate: (update) => {
                  res.write(formatToolUpdateEvent(update));
                },
                onToolResult: (toolResult) => {
                  res.write(`data: ${JSON.stringify(toolResult)}\n\n`);
                },
                onInterceptedToolCall: (toolCall) => {
                  emitToolCallAndTerminate(toolCall);
                },
                onFallbackToLegacy: (error) => {
                  boundaryContext.activateLegacyFallback("handleToolLoopEvent.close", error);
                },
              });
              if (result.terminate) {
                emitTerminalAssistantErrorAndTerminate(result.terminate.message);
                break;
              }
              if (result.intercepted) {
                break;
              }
              if (result.skipConverter) {
                continue;
              }
            }

            if (streamTerminated || res.writableEnded) {
              break;
            }
            for (const sse of converter.handleEvent(event)) {
              res.write(sse);
            }
          }
          if (streamTerminated || res.writableEnded) {
            return;
          }

          perf.mark("request:done");
          perf.summarize();
          const stderrText = Buffer.concat(stderrChunks).toString().trim();
          log.debug("cursor-agent completed (node stream)", {
            code,
            stderrChars: stderrText.length,
          });
          if (code !== 0) {
            const errSource =
              stderrText
              || `cursor-agent exited with code ${String(code ?? "unknown")} and no output`;
            const parsed = parseAgentError(errSource);
            const msg = formatErrorForUser(parsed);
            const errChunk = createChatCompletionChunk(id, created, model, msg, true);
            res.write(`data: ${JSON.stringify(errChunk)}\n\n`);
            res.write(formatSseDone());
            streamTerminated = true;
            res.end();
            return;
          }

          const doneChunk = {
            id,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [
              {
                index: 0,
                delta: {},
                finish_reason: "stop",
              },
            ],
          };
          res.write(`data: ${JSON.stringify(doneChunk)}\n\n`);
          res.write(formatSseDone());
          res.end();
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: message }));
    }
  };

  let server = http.createServer(requestHandler);

  // Try to start on default port
  try {
    await new Promise<void>((resolve, reject) => {
      server.listen(CURSOR_PROXY_DEFAULT_PORT, CURSOR_PROXY_HOST, () => resolve());
      server.once("error", reject);
    });

    const baseURL = `http://${CURSOR_PROXY_HOST}:${CURSOR_PROXY_DEFAULT_PORT}/v1`;
    g[key].baseURL = baseURL;
    return baseURL;
  } catch (error: any) {
    if (error?.code !== "EADDRINUSE") {
      throw error;
    }

    if (REUSE_EXISTING_PROXY) {
      // Port in use - check if it's our proxy
      try {
        const res = await fetch(`http://${CURSOR_PROXY_HOST}:${CURSOR_PROXY_DEFAULT_PORT}/health`).catch(() => null);
        if (res && res.ok) {
          g[key].baseURL = CURSOR_PROXY_DEFAULT_BASE_URL;
          return CURSOR_PROXY_DEFAULT_BASE_URL;
        }
      } catch {
        // ignore
      }
    }

    // Start on random port
    server = http.createServer(requestHandler);
    await new Promise<void>((resolve, reject) => {
      server.listen(0, CURSOR_PROXY_HOST, () => resolve());
      server.once("error", reject);
    });

    const addr = server.address() as any;
    const baseURL = `http://${CURSOR_PROXY_HOST}:${addr.port}/v1`;
    g[key].baseURL = baseURL;
    return baseURL;
  }
}

/**
 * Convert JSON Schema parameters to Zod schemas for plugin tool hook
 */
function jsonSchemaToZod(jsonSchema: any): any {
  const z = tool.schema;
  const properties = jsonSchema.properties || {};
  const required = jsonSchema.required || [];

  const zodShape: any = {};

  for (const [key, prop] of Object.entries(properties)) {
    const p = prop as any;
    let zodType: any;

    switch (p.type) {
      case "string":
        zodType = z.string();
        if (p.description) {
          zodType = zodType.describe(p.description);
        }
        break;
      case "number":
        zodType = z.number();
        if (p.description) {
          zodType = zodType.describe(p.description);
        }
        break;
      case "boolean":
        zodType = z.boolean();
        if (p.description) {
          zodType = zodType.describe(p.description);
        }
        break;
      case "object":
        zodType = z.record(z.any());
        if (p.description) {
          zodType = zodType.describe(p.description);
        }
        break;
      case "array":
        zodType = z.array(z.any());
        if (p.description) {
          zodType = zodType.describe(p.description);
        }
        break;
      default:
        zodType = z.any();
        break;
    }

    // Make optional if not in required array
    if (!required.includes(key)) {
      zodType = zodType.optional();
    }

    zodShape[key] = zodType;
  }

  return zodShape;
}

function resolveToolContextBaseDir(context: any): string | null {
  const candidates = [context?.worktree, context?.directory];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate;
    }
  }
  return null;
}

function toAbsoluteWithBase(value: unknown, baseDir: string): unknown {
  if (typeof value !== "string") {
    return value;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || isAbsolute(trimmed)) {
    return value;
  }
  return resolve(baseDir, trimmed);
}

function applyToolContextDefaults(
  toolName: string,
  rawArgs: Record<string, unknown>,
  context: any,
): Record<string, unknown> {
  const baseDir = resolveToolContextBaseDir(context);
  if (!baseDir) {
    return rawArgs;
  }

  const args: Record<string, unknown> = { ...rawArgs };

  for (const key of [
    "path",
    "filePath",
    "targetPath",
    "directory",
    "dir",
    "folder",
    "targetDirectory",
    "targetFile",
    "cwd",
    "workdir",
  ]) {
    args[key] = toAbsoluteWithBase(args[key], baseDir);
  }

  if ((toolName === "bash" || toolName === "shell") && args.cwd === undefined && args.workdir === undefined) {
    args.cwd = baseDir;
  }

  if ((toolName === "grep" || toolName === "glob" || toolName === "ls") && args.path === undefined) {
    args.path = baseDir;
  }

  return args;
}

/**
 * Build tool hook entries from local registry
 */
function buildToolHookEntries(registry: CoreRegistry): Record<string, any> {
  const entries: Record<string, any> = {};
  const tools = registry.list();
  for (const t of tools) {
    const handler = registry.getHandler(t.name);
    if (!handler) continue;

    const zodArgs = jsonSchemaToZod(t.parameters);

    entries[t.name] = tool({
      description: t.description,
      args: zodArgs,
      async execute(args: any, context: any) {
        try {
          const normalizedArgs = applyToolContextDefaults(t.name, args, context);
          return await handler(normalizedArgs);
        } catch (error: any) {
          log.warn("Tool hook execution failed", { tool: t.name, error: String(error?.message || error) });
          throw error;
        }
      },
    });
  }

  return entries;
}

/**
 * OpenCode plugin for Cursor Agent
 */
export const CursorPlugin: Plugin = async ({ $, directory, client, serverUrl }: PluginInput) => {
  log.debug("Plugin initializing", { directory, serverUrl: serverUrl?.toString() });
  if (!TOOL_LOOP_MODE_VALID) {
    log.warn("Invalid CURSOR_ACP_TOOL_LOOP_MODE; defaulting to opencode", { value: TOOL_LOOP_MODE_RAW });
  }
  if (!PROVIDER_BOUNDARY_MODE_VALID) {
    log.warn("Invalid CURSOR_ACP_PROVIDER_BOUNDARY; defaulting to v1", {
      value: PROVIDER_BOUNDARY_MODE_RAW,
    });
  }
  if (!TOOL_LOOP_MAX_REPEAT_VALID) {
    log.warn("Invalid CURSOR_ACP_TOOL_LOOP_MAX_REPEAT; defaulting to 3", {
      value: TOOL_LOOP_MAX_REPEAT_RAW,
    });
  }
  if (ENABLE_PROVIDER_BOUNDARY_AUTOFALLBACK && PROVIDER_BOUNDARY.mode !== "v1") {
    log.debug("Provider boundary auto-fallback is enabled but inactive unless mode=v1");
  }
  log.info("Tool loop mode configured", {
    mode: TOOL_LOOP_MODE,
    providerBoundary: PROVIDER_BOUNDARY.mode,
    proxyExecToolCalls: PROXY_EXECUTE_TOOL_CALLS,
    providerBoundaryAutoFallback: ENABLE_PROVIDER_BOUNDARY_AUTOFALLBACK,
    toolLoopMaxRepeat: TOOL_LOOP_MAX_REPEAT,
  });
  await ensurePluginDirectory();

  // Tools (skills) discovery/execution wiring
  const toolsEnabled = process.env.CURSOR_ACP_ENABLE_OPENCODE_TOOLS !== "false"; // default ON
  const legacyProxyToolPathsEnabled = toolsEnabled && TOOL_LOOP_MODE === "proxy-exec";
  if (toolsEnabled && TOOL_LOOP_MODE === "opencode") {
    log.debug("OpenCode mode active; skipping legacy SDK/MCP discovery and proxy-side tool execution");
  } else if (toolsEnabled && TOOL_LOOP_MODE === "off") {
    log.debug("Tool loop mode off; proxy-side tool execution disabled");
  }
  // FORWARD_TOOL_CALLS is only used when TOOL_LOOP_MODE=proxy-exec.
  // Build a client with serverUrl so SDK tool.list works even if the injected client isn't fully configured.
  const serverClient = legacyProxyToolPathsEnabled
    ? createOpencodeClient({ baseUrl: serverUrl.toString(), directory })
    : null;
  const discovery = legacyProxyToolPathsEnabled ? new OpenCodeToolDiscovery(serverClient ?? client) : null;

  // Build executor chain: Local -> SDK -> MCP
  const localRegistry = new CoreRegistry();
  registerDefaultTools(localRegistry);

  const timeoutMs = Number(process.env.CURSOR_ACP_TOOL_TIMEOUT_MS || 30000);
  const localExec = new LocalExecutor(localRegistry);
  const sdkExec = legacyProxyToolPathsEnabled ? new SdkExecutor(serverClient ?? client, timeoutMs) : null;
  const mcpExec = legacyProxyToolPathsEnabled ? new McpExecutor(serverClient ?? client, timeoutMs) : null;

  const executorChain: IToolExecutor[] = [localExec];
  if (sdkExec) executorChain.push(sdkExec);
  if (mcpExec) executorChain.push(mcpExec);

  const toolsByName = new Map<string, any>();
  const skillLoader = new SkillLoader();
  let skillResolver: SkillResolver | null = null;

  const router = legacyProxyToolPathsEnabled
    ? new ToolRouter({
        execute: (toolId, args) => executeWithChain(executorChain, toolId, args),
        toolsByName,
        resolveName: (name) => skillResolver?.resolve(name),
      })
    : null;
  let lastToolNames: string[] = [];
  let lastToolMap: Array<{ id: string; name: string }> = [];

  async function refreshTools() {
    toolsByName.clear();

    const toolEntries: any[] = [];
    const add = (name: string, t: any) => {
      if (!toolsByName.has(name)) {
        toolsByName.set(name, t);
      }
      toolEntries.push({
        type: "function" as const,
        function: {
          name,
          description: `${describeTool(t)} (skill id: ${t.id})`,
          parameters: toOpenAiParameters(t.parameters),
        },
      });
    };

    // Always include local tools — these work regardless of SDK connectivity
    const localTools = localRegistry.list().map((t) => ({ ...t, name: `oc_${t.id}` }));
    for (const asTool of localTools) {
      const nsName = asTool.name;
      add(nsName, asTool);
    }

    // Layer SDK/MCP-discovered tools on top (best-effort)
    let discoveredList: any[] = [];
    if (discovery) {
      try {
        discoveredList = await discovery.listTools();
        discoveredList.forEach((t) => toolsByName.set(t.name, t));
      } catch (err) {
        log.debug("Tool discovery failed, using local tools only", { error: String(err) });
      }
    }

    // Load skills and initialize resolver for alias resolution
    const allTools = [...localTools, ...discoveredList];
    const skills = skillLoader.load(allTools);
    skillResolver = new SkillResolver(skills);

    // Populate executors with their respective tool IDs
    if (sdkExec) {
      sdkExec.setToolIds(discoveredList.filter((t) => t.source === "sdk").map((t) => t.id));
    }
    if (mcpExec) {
      mcpExec.setToolIds(discoveredList.filter((t) => t.source === "mcp").map((t) => t.id));
    }

    for (const t of discoveredList) {
      add(t.name, t);

      if (t.name === "bash" && !toolsByName.has("shell")) {
        add("shell", t);
      }

      const baseId = t.id.replace(/[^a-zA-Z0-9_\\-]/g, "_");
      const skillAlias = `oc_skill_${baseId}`.slice(0, 64);
      if (!toolsByName.has(skillAlias)) add(skillAlias, t);
      const superAlias = `oc_superskill_${baseId}`.slice(0, 64);
      if (!toolsByName.has(superAlias)) add(superAlias, t);
      const spAlias = `oc_superpowers_${baseId}`.slice(0, 64);
      if (!toolsByName.has(spAlias)) add(spAlias, t);
    }

    lastToolNames = toolEntries.map((e) => e.function.name);
    lastToolMap = allTools.map((t) => ({ id: t.id, name: t.name }));
    log.debug("Tools refreshed", { local: localTools.length, discovered: discoveredList.length, total: toolEntries.length });
    return toolEntries;
  }

  const proxyBaseURL = await ensureCursorProxyServer(directory, router);
  log.debug("Proxy server started", { baseURL: proxyBaseURL });

  // Build tool hook entries from local registry
  const toolHookEntries = buildToolHookEntries(localRegistry);

  return {
    tool: toolHookEntries,
    auth: {
      provider: CURSOR_PROVIDER_ID,
      async loader(_getAuth: () => Promise<Auth>) {
        return {};
      },
      methods: [
        {
          label: "Cursor OAuth",
          type: "oauth",
          async authorize() {
            try {
              log.info("Starting OAuth flow");
              const { url, instructions, callback } = await startCursorOAuth();
              log.debug("Got OAuth URL", { url: url.substring(0, 50) + "..." });
              return {
                url,
                instructions,
                method: "auto" as const,
                callback,
              };
            } catch (error) {
              log.error("OAuth error", { error });
              throw error;
            }
          },
        },
      ],
    },

    async "chat.params"(input: any, output: any) {
      const boundaryContext = createBoundaryRuntimeContext("chat.params");

      const providerMatch = boundaryContext.run("matchesProvider", (boundary) =>
        boundary.matchesProvider(input.model),
      );
      if (!providerMatch) {
        return;
      }

      boundaryContext.run("applyChatParamDefaults", (boundary) =>
        boundary.applyChatParamDefaults(
          output,
          proxyBaseURL,
          CURSOR_PROXY_DEFAULT_BASE_URL,
          "cursor-agent",
        ),
      );

      // Tool definitions handling:
      // - proxy-exec mode: provider injects tool definitions directly.
      // - opencode mode: preserve OpenCode-provided tools, fallback only when absent.
      if (toolsEnabled) {
        try {
          const existingTools = output.options.tools;
          const shouldRefresh =
            TOOL_LOOP_MODE === "proxy-exec"
            || (TOOL_LOOP_MODE === "opencode" && existingTools == null);
          const refreshedTools = shouldRefresh ? await refreshTools() : [];
          const resolved = boundaryContext.run("resolveChatParamTools", (boundary) =>
            boundary.resolveChatParamTools(TOOL_LOOP_MODE, existingTools, refreshedTools),
          );

          if (resolved.action === "override" || resolved.action === "fallback") {
            output.options.tools = resolved.tools;
          } else if (resolved.action === "preserve") {
            const count = Array.isArray(existingTools) ? existingTools.length : 0;
            log.debug("Using OpenCode-provided tools from chat.params", { count });
          }
        } catch (err) {
          log.debug("Failed to refresh tools", { error: String(err) });
        }
      }
    },

    async "experimental.chat.system.transform"(input: any, output: { system: string[] }) {
      if (!toolsEnabled || lastToolNames.length === 0) return;
      const names = lastToolNames.join(", ");
      const mapping = lastToolMap.map((m) => `${m.id} -> ${m.name}`).join("; ");
      output.system = output.system || [];
      output.system.push(
        `Available OpenCode tools (use via tool calls): ${names}. Original skill ids mapped as: ${mapping}. Aliases include oc_skill_* and oc_superskill_* when applicable.`
      );
    },
  };
};

export default CursorPlugin;
