/**
 * sdk-child.ts
 *
 * Spawns sdk-runner.mjs as a persistent singleton process.
 * The runner reads NDJSON requests from stdin: {"id":"...","model":"...","cwd":"...","prompt":"..."}
 * and emits wrapped NDJSON responses to stdout: {"id":"...","event":{...}} or {"id":"...","done":true,"exitCode":...}
 *
 * This module demultiplexes per-request by:
 * 1. Maintaining a singleton runner process (lazy spawn on first use)
 * 2. Generating a unique request id per create*Child call
 * 3. Writing the request to runner stdin
 * 4. Filtering runner stdout by id to re-emit per-request events
 * 5. Closing the per-request stream when "done" is received
 *
 * Benefits:
 * - Agent.create overhead (~1s) paid only once per (model, cwd) pair (cached in runner)
 * - Node process boot overhead (~0.5s) paid once for all requests
 * - Remaining ~1s latency on first request comes from SDK initialization, not fork
 *
 * Limitations:
 * - kill() on a single child does not interrupt the runner (the request continues)
 *   This is acceptable since runner processes requests sequentially anyway
 * - If multiple apiKeys arrive (rare), the runner is re-spawned with the new key
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createLogger } from "../utils/logger.js";
import { randomBytes } from "node:crypto";

const log = createLogger("sdk-child");

// ─── Utilities ──────────────────────────────────────────────────────────────

/**
 * Resolve the Node binary path from PATH or environment override.
 */
function resolveNodeBinary(): string {
  return process.env.CURSOR_ACP_NODE_BIN || "node";
}

/**
 * Resolve the path to sdk-runner.mjs, handling both src/ (dev) and dist/ (built) contexts.
 * Returns the absolute path or throws if not found.
 */
function resolveRunnerPath(): string {
  const currentFile = fileURLToPath(import.meta.url);
  const currentDir = dirname(currentFile);

  // Candidates: ../../scripts/sdk-runner.mjs from both src/client/ and dist/client/
  const candidates = [
    resolve(currentDir, "../../scripts/sdk-runner.mjs"),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  log.error("Could not resolve sdk-runner.mjs", {
    currentFile,
    candidates,
  });

  throw new Error(
    `sdk-runner.mjs not found. Tried: ${candidates.join(", ")}`,
  );
}

/**
 * Generate a unique request id (hex string).
 */
function generateRequestId(): string {
  return randomBytes(8).toString("hex");
}

// ─── Singleton Runner ──────────────────────────────────────────────────────

interface PendingRequest {
  controller: ReadableStreamDefaultController<Uint8Array>;
  promiseResolver: (code: number) => void;
  promiseRejector: (err: Error) => void;
}

/**
 * Manages the persistent runner process and per-request demultiplexing.
 */
class SdkRunnerSingleton {
  private runnerProcess: ReturnType<typeof spawn> | null = null;
  private lastApiKey: string | null = null;
  private pendingRequests = new Map<string, PendingRequest>();
  private lineBuffer = "";
  private starting: Promise<void> | null = null;

  /**
   * Ensure the runner is spawned (or re-spawn if apiKey changed).
   * Concurrent callers share the same spawn (lock via this.starting) —
   * OpenCode fires multiple requests at once (e.g. title-gen + chat).
   */
  async ensureRunning(apiKey: string): Promise<void> {
    // If apiKey changed, kill the old process and respawn
    if (this.lastApiKey && this.lastApiKey !== apiKey) {
      log.info("API key changed, restarting runner");
      this.kill();
      this.starting = null;
    }

    if (this.runnerProcess) {
      return; // already running
    }
    if (this.starting) {
      return this.starting; // spawn already in progress
    }

    this.starting = this.doSpawn(apiKey);
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  private async doSpawn(apiKey: string): Promise<void> {
    const nodeBin = resolveNodeBinary();
    const runnerPath = resolveRunnerPath();

    log.info("spawning persistent sdk runner", {
      runnerPath,
      nodeBin,
    });

    this.lastApiKey = apiKey;

    this.runnerProcess = spawn(nodeBin, [runnerPath], {
      env: { ...process.env, CURSOR_API_KEY: apiKey },
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Handle runner stdout (demultiplex by request id)
    this.runnerProcess.stdout?.on("data", (chunk) => {
      this.handleStdoutChunk(chunk);
    });

    // Forward stderr to our logger (diagnostics only)
    this.runnerProcess.stderr?.on("data", (chunk) => {
      const text = chunk.toString("utf8").trimEnd();
      for (const line of text.split("\n")) {
        if (line) {
          log.debug(`[runner stderr] ${line}`);
        }
      }
    });

    // Handle runner exit
    this.runnerProcess.on("close", (code) => {
      log.error(`sdk runner exited with code ${code}`);
      this.runnerProcess = null;
      // Fail all pending requests
      for (const [id, pending] of this.pendingRequests.entries()) {
        pending.promiseRejector(new Error(`Runner exited with code ${code}`));
        pending.controller.error(new Error(`Runner exited with code ${code}`));
      }
      this.pendingRequests.clear();
    });

    this.runnerProcess.on("error", (err) => {
      log.error("sdk runner spawn error", { error: err.message });
      this.runnerProcess = null;
      // Fail all pending requests
      for (const [id, pending] of this.pendingRequests.entries()) {
        pending.promiseRejector(err);
        pending.controller.error(err);
      }
      this.pendingRequests.clear();
    });
  }

  /**
   * Send a request to the runner.
   */
  sendRequest(requestId: string, model: string, cwd: string, prompt: string): void {
    if (!this.runnerProcess || !this.runnerProcess.stdin) {
      throw new Error("Runner process not ready");
    }

    const request = { id: requestId, model, cwd, prompt };
    this.runnerProcess.stdin.write(JSON.stringify(request) + "\n");
  }

  /**
   * Handle a chunk of stdout from the runner.
   * Lines are wrapped: {"id":"...","event":{...}} or {"id":"...","done":true,"exitCode":...}
   */
  private handleStdoutChunk(chunk: Buffer | Uint8Array): void {
    this.lineBuffer += chunk.toString("utf8");
    const lines = this.lineBuffer.split("\n");
    this.lineBuffer = lines.pop() ?? ""; // keep incomplete line

    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        const wrapped = JSON.parse(line);
        const requestId = wrapped.id;
        if (!requestId) {
          log.warn("Wrapped response missing id", { wrapped });
          continue;
        }

        const pending = this.pendingRequests.get(requestId);
        if (!pending) {
          log.warn(`Received response for unknown request ${requestId}`, { wrapped });
          continue;
        }

        if (wrapped.done) {
          // Request complete
          log.info(`Request ${requestId} complete with exitCode ${wrapped.exitCode}`);
          pending.controller.close();
          pending.promiseResolver(wrapped.exitCode ?? 0);
          this.pendingRequests.delete(requestId);
        } else if (wrapped.event) {
          // Emit unwrapped event
          const event = JSON.stringify(wrapped.event) + "\n";
          pending.controller.enqueue(new TextEncoder().encode(event));
        }
      } catch (err) {
        log.error("Failed to parse wrapped response line", {
          line,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /**
   * Register a pending request and return the id.
   */
  registerPending(
    controller: ReadableStreamDefaultController<Uint8Array>,
    promiseResolver: (code: number) => void,
    promiseRejector: (err: Error) => void,
  ): string {
    const id = generateRequestId();
    this.pendingRequests.set(id, { controller, promiseResolver, promiseRejector });
    return id;
  }

  /**
   * Kill the runner process (hard kill).
   */
  kill(): void {
    if (this.runnerProcess) {
      try {
        this.runnerProcess.kill("SIGKILL");
      } catch {
        // ignore
      }
      this.runnerProcess = null;
    }
  }
}

const singleton = new SdkRunnerSingleton();

// ─── BUN-compatible child ──────────────────────────────────────────────────

export interface SdkBunChild {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(): void;
}

/**
 * Creates a Bun-spawn-compatible object using the persistent runner.
 * Each call returns a fresh per-request pair of streams.
 */
export function createSdkBunChild(options: {
  apiKey: string;
  model: string;
  prompt: string;
  cwd: string;
}): SdkBunChild {
  log.info("creating sdk bun child", {
    model: options.model,
    cwd: options.cwd,
  });

  let requestId: string;
  let resolveExited!: (code: number) => void;
  let rejectExited!: (err: Error) => void;

  const exited = new Promise<number>((resolve, reject) => {
    resolveExited = resolve;
    rejectExited = reject;
  });

  const stdout = new ReadableStream<Uint8Array>({
    start: async (controller) => {
      try {
        // Ensure runner is alive with this apiKey
        await singleton.ensureRunning(options.apiKey);

        // Register this request
        requestId = singleton.registerPending(controller, resolveExited, rejectExited);
        log.info(`request ${requestId} registered (bun)`);

        // Send the request to the runner
        singleton.sendRequest(requestId, options.model, options.cwd, options.prompt);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        log.error("Failed to start request (bun)", { error: error.message });
        controller.error(error);
        rejectExited(error);
      }
    },
    cancel() {
      // Best-effort: could stop forwarding events, but runner continues
      // For now, just log it
      log.debug(`request ${requestId} cancelled (bun)`);
    },
  });

  // Stub stderr (runner diagnostics go to parent stderr via logger)
  const stderr = new ReadableStream<Uint8Array>({
    start(controller) {
      // No stderr for individual requests; it's global to the runner process
      controller.close();
    },
  });

  return {
    stdout,
    stderr,
    exited,
    kill() {
      log.debug(`kill() called on bun child ${requestId}` );
      // Best-effort cancellation; runner process stays alive
    },
  };
}

// ─── Node-compatible child ─────────────────────────────────────────────────

/**
 * EventEmitter-based child that mirrors the shape of Node child_process.spawn().
 * Emits "close" with exit code and "error" on failure.
 */
export class SdkNodeChild extends EventEmitter {
  public readonly stdout: PassThrough = new PassThrough();
  public readonly stderr: PassThrough = new PassThrough();

  private requestId: string | null = null;

  async spawn(options: { apiKey: string; model: string; prompt: string; cwd: string }) {
    try {
      log.info("spawning (via singleton) sdk node child", {
        model: options.model,
        cwd: options.cwd,
      });

      // Ensure runner is alive with this apiKey
      await singleton.ensureRunning(options.apiKey);

      // Create a ReadableStream to demultiplex from the singleton
      let requestId: string;
      let resolveExited: (code: number) => void;
      let rejectExited: (err: Error) => void;

      const exited = new Promise<number>((resolve, reject) => {
        resolveExited = resolve;
        rejectExited = reject;
      });

      const dummyController = {
        enqueue: (data: Uint8Array) => {
          this.stdout.write(data);
        },
        close: () => {
          this.stdout.end();
        },
        error: (err: Error) => {
          this.stdout.destroy(err);
        },
      } as unknown as ReadableStreamDefaultController<Uint8Array>;

      // Register this request
      requestId = singleton.registerPending(dummyController, (code) => {
        this.stderr.end();
        this.emit("close", code);
        resolveExited(code);
      }, (err) => {
        this.stderr.end();
        this.emit("error", err);
        rejectExited(err);
      });

      this.requestId = requestId;
      log.info(`request ${requestId} registered (node)`);

      // Send the request to the runner
      singleton.sendRequest(requestId, options.model, options.cwd, options.prompt);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      log.error("Failed to spawn sdk node child", { error: error.message });
      this.emit("error", error);
    }
  }

  kill() {
    if (this.requestId) {
      log.debug(`kill() called on node child ${this.requestId}`);
    }
    // Best-effort: runner process stays alive; individual request cannot be interrupted
  }
}

export function createSdkNodeChild(options: {
  apiKey: string;
  model: string;
  prompt: string;
  cwd: string;
}): SdkNodeChild {
  const child = new SdkNodeChild();
  child.spawn(options).catch((err) => {
    log.error("Spawn error", { error: err instanceof Error ? err.message : String(err) });
  });
  return child;
}
