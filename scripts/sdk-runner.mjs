#!/usr/bin/env node
/**
 * sdk-runner.mjs
 *
 * Persistent Node.js runner for @cursor/sdk Agent.
 * Reads NDJSON lines from stdin: {"id":"<string>","model":"...","cwd":"...","prompt":"..."}
 * For each request, spawns/reuses an Agent and emits wrapped events to stdout:
 *   {"id":"<id>","event":{...StreamJsonEvent...}}
 * When request completes:
 *   {"id":"<id>","done":true,"exitCode":0|1}
 *
 * OPERATIONS:
 * - default: {"id","model","cwd","prompt"} -> runs a fresh Agent per request
 *   (no caching: conversation state must stay in OpenCode, see handleRequest)
 * - {"id","op":"listModels"} -> emits {"type":"models","models":[{id,name}]}
 *
 * ENVIRONMENT VARIABLES:
 * - CURSOR_API_KEY: Required. API key from cursor.com/settings.
 * - CURSOR_ACP_SETTING_SOURCES: (optional) CSV of setting sources to load.
 *   Defaults to empty (isolated mode: no Cursor env rules/skills/MCP per request).
 *   Examples: "all" (load everything), "user,project" (load user + project rules).
 *   See @cursor/sdk SettingSource type: "project"|"user"|"team"|"mdm"|"plugins"|"all".
 *
 * Usage:
 *   echo '{"id":"r1","model":"auto","cwd":".","prompt":"hello"}' | CURSOR_API_KEY=... node sdk-runner.mjs
 *   CURSOR_ACP_SETTING_SOURCES="user,project" CURSOR_API_KEY=... node sdk-runner.mjs < requests.ndjson
 *
 * Output: NDJSON wrapped events to stdout (one per line).
 * Diagnostics and timings: console.error only (never stdout).
 * Lifecycle: reads stdin indefinitely; on EOF, disposes agents and exits 0.
 */

import { pathToFileURL } from "node:url";

// Import Agent and Cursor dynamically after API key check to accelerate boot time
let Agent;
let Cursor;

// ─── Constants ──────────────────────────────────────────────────────────────

const STREAM_JSON_EVENT_BUFFER_SIZE = 64 * 1024; // 64KB for line buffering

/**
 * Parse CURSOR_ACP_SETTING_SOURCES env var (comma-separated, space-trimmed).
 * If undefined or empty, return [] (isolated: no Cursor env rules/skills/MCP per request).
 * Examples: "all" → ["all"], "user,project" → ["user","project"], "" → [].
 */
const SETTING_SOURCES = (() => {
  const raw = process.env.CURSOR_ACP_SETTING_SOURCES ?? "";
  if (!raw.trim()) return [];
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
})();

// ─── Protocol stdout protection ─────────────────────────────────────────────
// The Cursor SDK writes its own internal logs to process.stdout, which would
// pollute our NDJSON protocol. Redirect any stdout writes that don't come from
// our emit helpers to stderr, and keep a private handle to the real stdout.
const protocolWrite = process.stdout.write.bind(process.stdout);
const RUNNING_AS_MAIN = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;
if (RUNNING_AS_MAIN) {
  process.stdout.write = (chunk, ...args) => process.stderr.write(chunk, ...args);
}

/**
 * Write a line to the real (protocol) stdout.
 */
function writeProtocolLine(line) {
  return protocolWrite(line);
}

// ─── Utilities ──────────────────────────────────────────────────────────────

/**
 * Convert SDK message to StreamJsonEvent (portable copy from sdk-child.ts).
 */
export function namespaceMcpTool(serverName, toolName) {
  const sanitizedServer = String(serverName).replace(/[^a-zA-Z0-9]/g, "_");
  const sanitizedTool = String(toolName).replace(/[^a-zA-Z0-9]/g, "_");
  return `mcp__${sanitizedServer}__${sanitizedTool}`;
}

export function sdkMessageToStreamJson(msg) {
  switch (msg?.type) {
    case "assistant": {
      const content = msg.message?.content ?? [];
      const textBlocks = content.filter((b) => b.type === "text");
      if (textBlocks.length === 0) return null;
      return {
        type: "assistant",
        message: {
          role: "assistant",
          content: textBlocks.map((b) => ({
            type: "text",
            text: b.text,
          })),
        },
      };
    }
    case "thinking":
      if (!msg.text) return null;
      return {
        type: "thinking",
        subtype: "delta",
        text: msg.text,
        timestamp_ms: msg.thinking_duration_ms,
      };
    case "tool_call": {
      let name = msg.name;
      let args = msg.args;
      // The Cursor SDK emits MCP tool calls as a generic tool named "mcp"
      // with {providerIdentifier, toolName, args} inside. Remap to the
      // namespaced name OpenCode expects (mcp__<server>__<tool>) so the
      // tool-loop can intercept and execute it instead of failing with
      // "unavailable tool 'mcp'".
      if (name === "mcp" && args && typeof args === "object") {
        const provider = args.providerIdentifier;
        const toolName = args.toolName;
        if (provider && toolName) {
          name = namespaceMcpTool(provider, toolName);
          args = args.args ?? {};
          console.error(`[sdk-runner] Remapped mcp tool call -> ${name}`);
        } else {
          console.error(
            `[sdk-runner] mcp tool call missing provider/toolName: ${JSON.stringify(msg.args).slice(0, 200)}`,
          );
        }
      }
      return {
        type: "tool_call",
        call_id: msg.call_id,
        tool_call: {
          [name]: {
            args,
            result: msg.result,
          },
        },
      };
    }
    case "status": {
      const status = msg.status;
      if (status === "FINISHED") return { type: "result", subtype: "success" };
      if (status === "ERROR")
        return {
          type: "result",
          subtype: "error",
          is_error: true,
          error: { message: msg.message ?? "SDK error" },
        };
      return null;
    }
    case "system":
      return {
        type: "system",
        subtype: msg.subtype,
      };
    default:
      return null;
  }
}

/**
 * Emit a wrapped NDJSON error event to stdout (per-request).
 */
function emitErrorEvent(id, message) {
  const event = {
    type: "result",
    subtype: "error",
    is_error: true,
    error: { message },
  };
  writeProtocolLine(JSON.stringify({ id, event }) + "\n");
}

/**
 * Emit request completion marker.
 */
function emitDone(id, exitCode = 0) {
  writeProtocolLine(JSON.stringify({ id, done: true, exitCode }) + "\n");
}

/**
 * Emit a wrapped NDJSON event.
 */
function emitEvent(id, event) {
  writeProtocolLine(JSON.stringify({ id, event }) + "\n");
}

// ─── List Models Handler ───────────────────────────────────────────────────
/**
 * Handle a listModels request: call Cursor.models.list() and emit wrapped events.
 */
async function handleListModels(id) {
  try {
    console.error(`[sdk-runner] listModels request ${id}`);
    
    const models = await Cursor.models.list();
    
    const modelList = models.map((m) => ({
      id: m.id,
      name: m.displayName || m.id,
    }));
    
    const event = {
      type: "models",
      models: modelList,
    };
    
    emitEvent(id, event);
    console.error(`[sdk-runner] listModels request ${id} complete (${models.length} models)`);
    emitDone(id, 0);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[sdk-runner] listModels request ${id} error: ${message}`);
    emitErrorEvent(id, message);
    emitDone(id, 1);
  }
}

// ─── Request Handler ────────────────────────────────────────────────────────

/**
 * Handle a single request: execute the prompt and emit wrapped events.
 */
async function handleRequest(apiKey, request) {
  const { id, model, cwd, prompt } = request;

  // Validate required fields
  if (!id || !model || !cwd || !prompt) {
    console.error(`[sdk-runner] Invalid request missing fields:`, request);
    emitErrorEvent(id || "unknown", "Missing required fields: id, model, cwd, prompt");
    emitDone(id || "unknown", 1);
    return;
  }

  console.error(`[sdk-runner] Request ${id}: model=${model}, cwd=${cwd}`);

  // NOTE: a fresh Agent is created per request (NOT cached/reused).
  // The proxy sends the full conversation history in every prompt, so reusing
  // an Agent would duplicate context across requests and leak conversation
  // state between independent OpenCode sessions. Concurrent requests on a
  // shared Agent would also interleave. The persistent process still saves
  // the Node boot + SDK import cost (~2-3s) on every request after the first.
  let agent = null;
  const timelineStart = Date.now();
  try {
    // Timing: Agent.create
    const createStart = Date.now();
    agent = await Agent.create({
      apiKey,
      model: { id: model },
      mode: "agent",
      local: { cwd, settingSources: SETTING_SOURCES },
    });
    const createMs = Date.now() - createStart;
    console.error(`[sdk-runner] Agent ready, sending prompt for request ${id}`);

    // Timing: agent.send() until first event
    const sendStart = Date.now();
    const run = await agent.send(prompt);

    let sawFinished = false;
    let eventCount = 0;
    let firstEventMs = null;

    console.error(`[sdk-runner] Streaming events for request ${id}...`);
    for await (const msg of run.stream()) {
      // Capture timing of first event
      if (firstEventMs === null) {
        firstEventMs = Date.now() - sendStart;
      }

      if (++eventCount <= 3 || eventCount % 50 === 0) {
        console.error(`[sdk-runner] Request ${id} event ${eventCount}: type=${msg?.type}`);
      }
      const event = sdkMessageToStreamJson(msg);
      if (!event) continue;
      if (event.type === "result") sawFinished = true;
      emitEvent(id, event);
    }

    // Ensure we emit a result event
    if (!sawFinished) {
      const successEvent = { type: "result", subtype: "success" };
      emitEvent(id, successEvent);
    }

    const totalMs = Date.now() - timelineStart;
    console.error(`[sdk-runner] Request ${id} complete (${eventCount} events)`);
    console.error(`[sdk-runner] timings ${id}: create=${createMs}ms firstEvent=${firstEventMs ?? "N/A"}ms total=${totalMs}ms`);
    emitDone(id, 0);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const totalMs = Date.now() - timelineStart;
    console.error(`[sdk-runner] Request ${id} error: ${message}`);
    console.error(`[sdk-runner] timings ${id}: total=${totalMs}ms (error)`);
    emitErrorEvent(id, message);
    emitDone(id, 1);
  } finally {
    if (agent) {
      await agent[Symbol.asyncDispose]?.().catch(() => {});
    }
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  try {
    // Check API key early before import
    const apiKey = process.env.CURSOR_API_KEY;
    if (!apiKey || !apiKey.trim()) {
      // Can't emit wrapped error since we're not in a request context
      // Just exit early; the parent will timeout or detect EOF
      console.error("[sdk-runner] CURSOR_API_KEY not set");
      process.exit(1);
    }

    // Log settingSources config at boot
    console.error(`[sdk-runner] settingSources: ${JSON.stringify(SETTING_SOURCES)}`);

    // Import Agent dynamically now that API key is validated
    // This accelerates boot time if the runner is forked without a valid key
    try {
      const sdkModule = await import("@cursor/sdk");
      Agent = sdkModule.Agent;
      Cursor = sdkModule.Cursor;
    } catch (err) {
      console.error(`[sdk-runner] Failed to import @cursor/sdk: ${err.message}`);
      console.error("[sdk-runner] Note: sqlite3 native bindings may be incompatible with this platform");
      process.exit(1);
    }

    // Persistent loop: dispatch each NDJSON line from stdin AS IT ARRIVES.
    // Requests run concurrently (OpenCode fires e.g. title-gen + chat at once).
    console.error("[sdk-runner] Waiting for requests on stdin...");

    const inFlight = new Set();

    const dispatch = (request) => {
      let p;
      if (request.op === "listModels") {
        // Handle listModels operation
        p = handleListModels(request.id)
          .catch((err) => {
            const id = request?.id || "unknown";
            console.error(`[sdk-runner] Unhandled error in listModels ${id}: ${err.message}`);
            emitErrorEvent(id, `Unhandled error: ${err.message}`);
            emitDone(id, 1);
          })
          .finally(() => inFlight.delete(p));
      } else {
        // Handle regular agent request
        p = handleRequest(apiKey, request)
          .catch((err) => {
            const id = request?.id || "unknown";
            console.error(`[sdk-runner] Unhandled error processing request ${id}: ${err.message}`);
            emitErrorEvent(id, `Unhandled error: ${err.message}`);
            emitDone(id, 1);
          })
          .finally(() => inFlight.delete(p));
      }
      inFlight.add(p);
    };

    let buffer = "";
    const handleLine = (line) => {
      if (!line.trim()) return;
      try {
        dispatch(JSON.parse(line));
      } catch (err) {
        console.error(`[sdk-runner] Failed to parse NDJSON line: ${err.message}`);
      }
    };

    await new Promise((resolveEnd, rejectEnd) => {
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => {
        buffer += chunk;
        const parts = buffer.split("\n");
        buffer = parts.pop() ?? ""; // keep incomplete line
        for (const part of parts) handleLine(part);
      });
      process.stdin.on("end", () => {
        if (buffer.trim()) handleLine(buffer);
        resolveEnd();
      });
      process.stdin.on("error", rejectEnd);
    });

    // stdin closed: wait for in-flight requests, then shut down.
    console.error(`[sdk-runner] stdin closed, waiting for ${inFlight.size} in-flight request(s)`);
    await Promise.allSettled([...inFlight]);
    console.error("[sdk-runner] All requests processed, shutting down");

    // Flush stdout before exiting
    await new Promise((resolve) => protocolWrite("", resolve));
    process.exit(0);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[sdk-runner] Fatal error: ${message}`);
    process.exit(1);
  }
}

if (RUNNING_AS_MAIN) {
  main().catch((err) => {
    console.error(`[sdk-runner] Unhandled error in main:`, err);
    process.exit(1);
  });
}
