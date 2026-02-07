import type { Plugin, PluginInput } from "@opencode-ai/plugin";
import type { Auth } from "@opencode-ai/sdk";
import { mkdir } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import { ToolMapper, type ToolUpdate } from "./acp/tools.js";
import { startCursorOAuth } from "./auth";
import { LineBuffer } from "./streaming/line-buffer.js";
import { StreamToSseConverter, formatSseDone } from "./streaming/openai-sse.js";
import { parseStreamJsonLine } from "./streaming/parser.js";
import { extractText, extractThinking, isAssistantText, isThinking } from "./streaming/types.js";
import { createLogger } from "./utils/logger";
import { parseAgentError, formatErrorForUser, stripAnsi } from "./utils/errors";
import { OpenCodeToolDiscovery } from "./tools/discovery.js";
import { toOpenAiParameters, describeTool } from "./tools/schema.js";
import { OpenCodeToolExecutor } from "./tools/executor.js";
import { ToolRouter } from "./tools/router.js";
import { createOpencodeClient } from "@opencode-ai/sdk";

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

function getGlobalKey(): string {
  return "__opencode_cursor_proxy_server__";
}

const FORCE_TOOL_MODE = process.env.CURSOR_ACP_FORCE !== "false";
const EMIT_TOOL_UPDATES = process.env.CURSOR_ACP_EMIT_TOOL_UPDATES === "true";
const FORWARD_TOOL_CALLS = process.env.CURSOR_ACP_FORWARD_TOOL_CALLS === "true";

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

        const body: any = await req.json().catch(() => ({}));
        const messages: Array<any> = Array.isArray(body?.messages) ? body.messages : [];
        const stream = body?.stream === true;
        const tools = Array.isArray(body?.tools) ? body.tools : [];

      // Convert messages to prompt
      const lines: string[] = [];
      for (const message of messages) {
        const role = typeof message.role === "string" ? message.role : "user";
        const content = message.content;

        if (typeof content === "string") {
          lines.push(`${role.toUpperCase()}: ${content}`);
        } else if (Array.isArray(content)) {
          const textParts = content
            .map((part: any) => {
              if (part && typeof part === "object" && part.type === "text" && typeof part.text === "string") {
                return part.text;
              }
              return "";
            })
            .filter(Boolean);
          if (textParts.length) {
            lines.push(`${role.toUpperCase()}: ${textParts.join("\n")}`);
          }
        }
      }
      const prompt = lines.join("\n\n");
      const model = typeof body?.model === "string" ? body.model : "auto";

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

        // cursor-agent sometimes returns non-zero even with usable stdout.
        // Treat stdout as success unless we have explicit stderr.
        if (child.exitCode !== 0 && stderr.length > 0) {
          const parsed = parseAgentError(stderr);
          const userError = formatErrorForUser(parsed);
          log.error("cursor-cli failed", { type: parsed.type, message: parsed.message });
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
      const toolMapper = new ToolMapper();
      const toolSessionId = id;

      const sse = new ReadableStream({
        async start(controller) {
          let closed = false;
          try {
            const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
            const converter = new StreamToSseConverter(model, { id, created });
            const lineBuffer = new LineBuffer();

            while (true) {
              const { value, done } = await reader.read();
              if (done) break;
              if (!value || value.length === 0) continue;

              for (const line of lineBuffer.push(value)) {
                const event = parseStreamJsonLine(line);
                if (!event) {
                  continue;
                }

                if (event.type === "tool_call") {
                  const updates = await toolMapper.mapCursorEventToAcp(
                    event,
                    event.session_id ?? toolSessionId,
                  );
                  if (EMIT_TOOL_UPDATES) {
                    for (const update of updates) {
                      controller.enqueue(encoder.encode(formatToolUpdateEvent(update)));
                    }
                  }

                  // Optional: forward tool calls to OpenCode tool executor.
                  if (FORWARD_TOOL_CALLS && toolRouter) {
                    const toolResult = await toolRouter.handleToolCall(event as any, { id, created, model });
                    if (toolResult) {
                      controller.enqueue(encoder.encode(`data: ${JSON.stringify(toolResult)}\n\n`));
                    }
                  }

                  if (!FORWARD_TOOL_CALLS) {
                    continue;
                  }
                }

                for (const sse of converter.handleEvent(event)) {
                  controller.enqueue(encoder.encode(sse));
                }
              }
            }

            for (const line of lineBuffer.flush()) {
              const event = parseStreamJsonLine(line);
              if (!event) {
                continue;
              }
              if (event.type === "tool_call") {
                const updates = await toolMapper.mapCursorEventToAcp(
                  event,
                  event.session_id ?? toolSessionId,
                );
                if (EMIT_TOOL_UPDATES) {
                  for (const update of updates) {
                    controller.enqueue(encoder.encode(formatToolUpdateEvent(update)));
                  }
                }

                if (!FORWARD_TOOL_CALLS) {
                  continue;
                }
              }
              for (const sse of converter.handleEvent(event)) {
                controller.enqueue(encoder.encode(sse));
              }
            }

            if (child.exitCode !== 0) {
              const stderrText = await new Response(child.stderr).text();
              const parsed = parseAgentError(stderrText);
              const msg = formatErrorForUser(parsed);
              log.error("cursor-cli streaming failed", { type: parsed.type });
              const errChunk = createChatCompletionChunk(id, created, model, msg, true);
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(errChunk)}\n\n`));
              controller.enqueue(encoder.encode(formatSseDone()));
              return;
            }

            const doneChunk = createChatCompletionChunk(id, created, model, "", true);
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(doneChunk)}\n\n`));
            controller.enqueue(encoder.encode(formatSseDone()));
          } finally {
            closed = true;
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

      let body = "";
      for await (const chunk of req) {
        body += chunk;
      }

      const bodyData: any = JSON.parse(body || "{}");
      const messages: Array<any> = Array.isArray(bodyData?.messages) ? bodyData.messages : [];
      const stream = bodyData?.stream === true;

      // Convert messages to prompt
      const lines: string[] = [];
      for (const message of messages) {
        const role = typeof message.role === "string" ? message.role : "user";
        const content = message.content;

        if (typeof content === "string") {
          lines.push(`${role.toUpperCase()}: ${content}`);
        } else if (Array.isArray(content)) {
          const textParts = content
            .map((part: any) => {
              if (part && typeof part === "object" && part.type === "text" && typeof part.text === "string") {
                return part.text;
              }
              return "";
            })
            .filter(Boolean);
          if (textParts.length) {
            lines.push(`${role.toUpperCase()}: ${textParts.join("\n")}`);
          }
        }
      }
      const prompt = lines.join("\n\n");
      const model = typeof bodyData?.model === "string" ? bodyData.model : "auto";

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

        child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
        child.stderr.on("data", (chunk) => stderrChunks.push(chunk));

        child.on("close", async (code) => {
          const stdout = Buffer.concat(stdoutChunks).toString().trim();
          const stderr = Buffer.concat(stderrChunks).toString().trim();
          const completion = extractCompletionFromStream(stdout);

          if (code !== 0 && stderr.length > 0) {
            const parsed = parseAgentError(stderr);
            const userError = formatErrorForUser(parsed);
            log.error("cursor-cli failed", { type: parsed.type, message: parsed.message });
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

        const converter = new StreamToSseConverter(model, { id, created });
        const lineBuffer = new LineBuffer();
        const toolMapper = new ToolMapper();
        const toolSessionId = id;

        child.stdout.on("data", async (chunk) => {
          for (const line of lineBuffer.push(chunk)) {
            const event = parseStreamJsonLine(line);
            if (!event) {
              continue;
            }

            if (event.type === "tool_call") {
              const updates = await toolMapper.mapCursorEventToAcp(
                event,
                event.session_id ?? toolSessionId,
              );
              if (EMIT_TOOL_UPDATES) {
                for (const update of updates) {
                  res.write(formatToolUpdateEvent(update));
                }
              }

              if (FORWARD_TOOL_CALLS && toolRouter) {
                const toolResult = await toolRouter.handleToolCall(event as any, { id, created, model });
                if (toolResult) {
                  res.write(`data: ${JSON.stringify(toolResult)}\n\n`);
                }
              }

              if (!FORWARD_TOOL_CALLS) {
                continue;
              }
            }

            for (const sse of converter.handleEvent(event)) {
              res.write(sse);
            }
          }
        });

        child.on("close", async (code) => {
          for (const line of lineBuffer.flush()) {
            const event = parseStreamJsonLine(line);
            if (!event) {
              continue;
            }

            if (event.type === "tool_call") {
              const updates = await toolMapper.mapCursorEventToAcp(
                event,
                event.session_id ?? toolSessionId,
              );
              if (EMIT_TOOL_UPDATES) {
                for (const update of updates) {
                  res.write(formatToolUpdateEvent(update));
                }
              }

              if (FORWARD_TOOL_CALLS && toolRouter) {
                const toolResult = await toolRouter.handleToolCall(event as any, { id, created, model });
                if (toolResult) {
                  res.write(`data: ${JSON.stringify(toolResult)}\n\n`);
                }
              }

              if (!FORWARD_TOOL_CALLS) {
                continue;
              }
            }

            for (const sse of converter.handleEvent(event)) {
              res.write(sse);
            }
          }

          if (code !== 0) {
            child.stderr.on("data", (chunk) => {
              const errChunk = {
                id,
                object: "chat.completion.chunk",
                created,
                model,
                choices: [
                  {
                    index: 0,
                    delta: { content: `cursor-agent failed: ${chunk.toString()}` },
                    finish_reason: "stop",
                  },
                ],
              };
              res.write(`data: ${JSON.stringify(errChunk)}\n\n`);
            });
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

  const server = http.createServer(requestHandler);

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

    // Start on random port
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
 * OpenCode plugin for Cursor Agent
 */
export const CursorPlugin: Plugin = async ({ $, directory, client, serverUrl }: PluginInput) => {
  log.info("Plugin initializing", { directory });
  await ensurePluginDirectory();

  // Tools (skills) discovery/execution wiring
  const toolsEnabled = process.env.CURSOR_ACP_ENABLE_OPENCODE_TOOLS !== "false"; // default ON
  // Build a client with serverUrl so SDK tool.list works even if the injected client isn't fully configured.
  const serverClient = toolsEnabled
    ? createOpencodeClient({ serverUrl: serverUrl.toString(), directory })
    : null;
  const discovery = toolsEnabled ? new OpenCodeToolDiscovery(serverClient ?? client) : null;
  const executor = toolsEnabled ? new OpenCodeToolExecutor(serverClient ?? client) : null;
  const toolsByName = new Map<string, any>();
  const router = toolsEnabled && executor ? new ToolRouter({ executor, toolsByName }) : null;
  let lastToolNames: string[] = [];
  let lastToolMap: Array<{ id: string; name: string }> = [];

  async function refreshTools() {
    if (!discovery || !router) return [];
    const list = await discovery.listTools();
    toolsByName.clear();
    list.forEach((t) => toolsByName.set(t.name, t));

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

    for (const t of list) {
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
    lastToolMap = list.map((t) => ({ id: t.id, name: t.name }));
    return toolEntries;
  }

  const proxyBaseURL = await ensureCursorProxyServer(directory, router);
  log.info("Proxy server started", { baseURL: proxyBaseURL });

  return {
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
      if (input.model.providerID !== CURSOR_PROVIDER_ID) {
        return;
      }

      // Always point to the actual proxy base URL (may be dynamically allocated).
      output.options = output.options || {};
      output.options.baseURL = proxyBaseURL || CURSOR_PROXY_DEFAULT_BASE_URL;
      output.options.apiKey = output.options.apiKey || "cursor-agent";

      // Inject OpenCode tools/skills for the model to call (optional)
      if (toolsEnabled) {
        try {
          const toolDefs = await refreshTools();
          if (toolDefs.length) {
            output.options.tools = toolDefs;
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
