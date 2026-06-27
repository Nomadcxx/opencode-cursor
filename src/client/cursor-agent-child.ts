/**
 * cursor-agent-child.ts
 *
 * Persistent cursor-agent runner pool keyed by workspace + model.
 * Mirrors the SDK runner pattern in sdk-child.ts.
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createLogger } from "../utils/logger.js";
import { resolveCursorAgentBinary, resolveCursorAgentBinaryStrict } from "../utils/binary.js";
import { BinaryNotFoundError } from "../utils/errors.js";
import { extractEventJson, createSdkNodeChild } from "./sdk-child.js";

const log = createLogger("cursor-agent-child");

const DEFAULT_MAX_POOL_ENTRIES = 16;
const DEFAULT_IDLE_MS = 15 * 60 * 1000;

export function isAgentPoolEnabled(): boolean {
  const value = process.env.CURSOR_ACP_AGENT_POOL?.toLowerCase();
  return value === "1" || value === "true" || value === "on" || value === "yes";
}

export function parseAgentPoolIdleMs(): number {
  const value = process.env.CURSOR_ACP_AGENT_POOL_IDLE_MS?.trim();
  if (value == null || value === "") return DEFAULT_IDLE_MS;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_IDLE_MS;
  return Math.floor(parsed);
}

/** Pool key: workspace + model (null-byte separated). */
export function buildAgentPoolKey(workspace: string, model: string): string {
  return `${workspace}\0${model}`;
}

export function resolveCursorAgentRunnerPath(
  currentFile: string = fileURLToPath(import.meta.url),
  checkExists: (path: string) => boolean = existsSync,
  env: Pick<NodeJS.ProcessEnv, "CURSOR_ACP_CURSOR_AGENT_RUNNER_PATH"> = process.env,
): string {
  const override = env.CURSOR_ACP_CURSOR_AGENT_RUNNER_PATH?.trim();
  if (override) {
    if (checkExists(override)) {
      return override;
    }
    throw new Error(`CURSOR_ACP_CURSOR_AGENT_RUNNER_PATH does not exist: ${override}`);
  }

  const currentDir = dirname(currentFile);
  const candidates = [
    resolve(currentDir, "../../scripts/cursor-agent-runner.mjs"),
    resolve(currentDir, "../scripts/cursor-agent-runner.mjs"),
  ];

  for (const candidate of candidates) {
    if (checkExists(candidate)) {
      return candidate;
    }
  }

  throw new Error(`cursor-agent-runner.mjs not found. Tried: ${candidates.join(", ")}`);
}

function resolveNodeBinary(): string {
  return process.env.CURSOR_ACP_NODE_BIN || "node";
}

function generateRequestId(): string {
  return randomBytes(8).toString("hex");
}

interface PendingRequest {
  controller: {
    enqueue: (data: Uint8Array) => void;
    enqueueStderr: (data: Uint8Array) => void;
    close: () => void;
    closeStderr: () => void;
    error: (err: Error) => void;
  };
  promiseResolver: (code: number) => void;
  promiseRejector: (err: Error) => void;
}

interface AgentPoolRequest {
  model: string;
  cwd: string;
  prompt: string;
  resumeChatId?: string;
  force?: boolean;
}

class CursorAgentPoolRunner {
  private runnerProcess: ReturnType<typeof spawn> | null = null;
  private pendingRequests = new Map<string, PendingRequest>();
  private lineBuffer = "";
  private starting: Promise<void> | null = null;
  private readonly poolKey: string;
  private readonly onIdle: (poolKey: string) => void;
  /** True when resolveCursorAgentBinaryStrict() threw BinaryNotFoundError on win32. */
  binaryMissing = false;
  /** The path that was attempted when binaryMissing is true. */
  attemptedPath: string | null = null;

  constructor(poolKey: string, onIdle: (poolKey: string) => void) {
    this.poolKey = poolKey;
    this.onIdle = onIdle;
  }

  async ensureRunning(): Promise<void> {
    if (this.runnerProcess) return;
    if (this.starting) return this.starting;

    this.starting = this.doSpawn();
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  private async doSpawn(): Promise<void> {
    // On Windows, check strictly whether the binary exists before spawning.
    // If not found, set binaryMissing flag and return without spawning.
    try {
      resolveCursorAgentBinaryStrict();
    } catch (err) {
      if (err instanceof BinaryNotFoundError) {
        this.binaryMissing = true;
        this.attemptedPath = err.attemptedPath;
        log.warn("cursor-agent binary not found on Windows, falling back to SDK runner", {
          attemptedPath: err.attemptedPath,
          platform: process.platform,
          fallback: "sdk-runner",
        });
        return;
      }
      throw err;
    }

    const nodeBin = resolveNodeBinary();
    const runnerPath = resolveCursorAgentRunnerPath();

    log.info("spawning persistent cursor-agent runner", {
      poolKeyHash: this.poolKey.slice(0, 8) + "…",
      runnerPath,
      nodeBin,
    });

    this.runnerProcess = spawn(nodeBin, [runnerPath], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.runnerProcess.stdout?.on("data", (chunk) => {
      this.handleStdoutChunk(chunk);
    });

    this.runnerProcess.stderr?.on("data", (chunk) => {
      const text = chunk.toString("utf8").trimEnd();
      for (const line of text.split("\n")) {
        if (line) log.debug(`[runner stderr] ${line}`);
      }
    });

    this.runnerProcess.on("close", (code) => {
      log.error(`cursor-agent runner exited with code ${code}`, { poolKeyHash: this.poolKey.slice(0, 8) + "…" });
      this.runnerProcess = null;
      for (const [, pending] of this.pendingRequests.entries()) {
        pending.promiseRejector(new Error(`Runner exited with code ${code}`));
        pending.controller.error(new Error(`Runner exited with code ${code}`));
      }
      this.pendingRequests.clear();
    });

    this.runnerProcess.on("error", (err) => {
      log.error("cursor-agent runner spawn error", { error: err.message });
      this.runnerProcess = null;
      for (const [, pending] of this.pendingRequests.entries()) {
        pending.promiseRejector(err);
        pending.controller.error(err);
      }
      this.pendingRequests.clear();
    });
  }

  sendRequest(requestId: string, request: AgentPoolRequest): void {
    if (!this.runnerProcess?.stdin) {
      throw new Error("Runner process not ready");
    }

    const payload = {
      id: requestId,
      model: request.model,
      cwd: request.cwd,
      prompt: request.prompt,
      resumeChatId: request.resumeChatId,
      force: request.force ?? false,
      cursorAgent: resolveCursorAgentBinary(),
    };

    this.runnerProcess.stdin.write(JSON.stringify(payload) + "\n");
  }

  /**
   * Cancel an in-flight or queued request by id. Writes a {cancel: id} control
   * line to the runner's stdin; the runner kills the active cursor-agent child
   * (or drops the request if still queued) and emits done so the pending
   * request resolves. No-op if the runner stdin is not yet ready.
   */
  cancel(requestId: string): void {
    if (!this.runnerProcess?.stdin) {
      log.warn("cancel() called but runner stdin not ready", { requestId });
      return;
    }
    this.runnerProcess.stdin.write(JSON.stringify({ cancel: requestId }) + "\n");
  }

  private handleStdoutChunk(chunk: Buffer | Uint8Array): void {
    this.lineBuffer += chunk.toString("utf8");
    const lines = this.lineBuffer.split("\n");
    this.lineBuffer = lines.pop() ?? "";

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
          log.warn(`Received response for unknown request ${requestId}`);
          continue;
        }

        if (wrapped.done) {
          pending.controller.close();
          pending.controller.closeStderr();
          pending.promiseResolver(wrapped.exitCode ?? 0);
          this.pendingRequests.delete(requestId);
          this.notifyIdleIfEmpty();
        } else if (wrapped.stderr != null) {
          const text = typeof wrapped.stderr === "string" ? wrapped.stderr : String(wrapped.stderr);
          pending.controller.enqueueStderr(new TextEncoder().encode(text));
        } else if (wrapped.event) {
          const eventJson = extractEventJson(line);
          pending.controller.enqueue(new TextEncoder().encode(eventJson + "\n"));
        }
      } catch (err) {
        log.error("Failed to parse wrapped response line", {
          line,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  isIdle(): boolean {
    return this.pendingRequests.size === 0;
  }

  private notifyIdleIfEmpty(): void {
    if (this.pendingRequests.size === 0) {
      this.onIdle(this.poolKey);
    }
  }

  registerPending(
    controller: PendingRequest["controller"],
    promiseResolver: (code: number) => void,
    promiseRejector: (err: Error) => void,
  ): string {
    const id = generateRequestId();
    this.pendingRequests.set(id, { controller, promiseResolver, promiseRejector });
    return id;
  }

  /** Reject and error every pending request before tearing down the runner. */
  private failAllPending(err: Error): void {
    for (const [, pending] of this.pendingRequests.entries()) {
      pending.promiseRejector(err);
      pending.controller.error(err);
    }
    this.pendingRequests.clear();
  }

  kill(): void {
    if (this.runnerProcess) {
      try {
        this.runnerProcess.kill("SIGKILL");
      } catch {
        // ignore
      }
      this.runnerProcess = null;
    }
    // Settle in-flight requests so their callers reject instead of hanging;
    // a plain clear() would drop their terminal events.
    this.failAllPending(new Error("Runner killed"));
  }
}

class CursorAgentPoolManager {
  private runners = new Map<string, CursorAgentPoolRunner>();
  private idleTimers = new Map<string, ReturnType<typeof setTimeout>>();

  getRunner(poolKey: string): CursorAgentPoolRunner {
    this.clearIdleTimer(poolKey);
    let runner = this.runners.get(poolKey);
    if (!runner) {
      while (this.runners.size >= DEFAULT_MAX_POOL_ENTRIES) {
        const oldest = this.runners.keys().next().value;
        if (oldest === undefined) break;
        this.clearIdleTimer(oldest);
        this.runners.get(oldest)?.kill();
        this.runners.delete(oldest);
      }
      runner = new CursorAgentPoolRunner(poolKey, (idlePoolKey) => {
        this.scheduleIdleEviction(idlePoolKey);
      });
      this.runners.set(poolKey, runner);
    }
    return runner;
  }

  size(): number {
    return this.runners.size;
  }

  private clearIdleTimer(poolKey: string): void {
    const timer = this.idleTimers.get(poolKey);
    if (!timer) return;
    clearTimeout(timer);
    this.idleTimers.delete(poolKey);
  }

  private scheduleIdleEviction(poolKey: string): void {
    this.clearIdleTimer(poolKey);
    const idleMs = parseAgentPoolIdleMs();
    if (idleMs <= 0) return;
    const timer = setTimeout(() => {
      this.idleTimers.delete(poolKey);
      const runner = this.runners.get(poolKey);
      if (!runner || !runner.isIdle()) return;
      runner.kill();
      this.runners.delete(poolKey);
      log.debug("evicted idle cursor-agent runner", {
        poolKeyHash: poolKey.slice(0, 8) + "…",
        idleMs,
      });
    }, idleMs);
    timer.unref?.();
    this.idleTimers.set(poolKey, timer);
  }

  stopAll(): void {
    for (const timer of this.idleTimers.values()) {
      clearTimeout(timer);
    }
    this.idleTimers.clear();
    for (const runner of this.runners.values()) {
      runner.kill();
    }
    this.runners.clear();
  }
}

const poolManager = new CursorAgentPoolManager();

export function stopCursorAgentPool(): void {
  poolManager.stopAll();
}

/** @internal Testing only. */
export function _getCursorAgentPoolSizeForTests(): number {
  if (process.env.NODE_ENV !== "test") return 0;
  return poolManager.size();
}

/** @internal Testing only. */
export function _resetCursorAgentPoolForTests(): void {
  if (process.env.NODE_ENV !== "test") return;
  poolManager.stopAll();
}

export class CursorAgentPoolNodeChild extends EventEmitter {
  public readonly stdout: PassThrough = new PassThrough();
  public readonly stderr: PassThrough = new PassThrough();
  private requestId: string | null = null;
  private runner: CursorAgentPoolRunner | null = null;
  private sdkChild: ReturnType<typeof createSdkNodeChild> | null = null;
  private readonly sdkApiKey: string | undefined;

  constructor(sdkApiKey?: string) {
    super();
    this.sdkApiKey = sdkApiKey;
  }

  spawn(options: AgentPoolRequest & { poolKey: string }): void {
    void this.spawnInternal(options);
  }

  private async spawnInternal(options: AgentPoolRequest & { poolKey: string }): Promise<void> {
    try {
      const runner = poolManager.getRunner(options.poolKey);
      this.runner = runner;
      await runner.ensureRunning();

      // If binary is missing on Windows, fall back to SDK runner
      if (runner.binaryMissing) {
        if (!this.sdkApiKey) {
          throw new Error(
            `Pool binary unavailable (${runner.attemptedPath}); SDK fallback also failed: no sdkApiKey provided.`,
          );
        }
        try {
          const sdkChild = createSdkNodeChild({
            apiKey: this.sdkApiKey,
            model: options.model,
            prompt: options.prompt,
            cwd: options.cwd,
          });
          this.sdkChild = sdkChild;

          // Pipe SDK child streams to our streams
          sdkChild.stdout.on("data", (chunk: Buffer) => {
            this.stdout.write(chunk);
          });
          sdkChild.stderr.on("data", (chunk: Buffer) => {
            this.stderr.write(chunk);
          });
          sdkChild.on("close", (code: unknown) => {
            this.stderr.end();
            this.emit("close", code);
          });
          sdkChild.on("error", (err: Error) => {
            throw new Error(
              `Pool binary unavailable (${runner.attemptedPath}); SDK fallback also failed: ${err.message}`,
            );
          });

          log.debug("cursor-agent pool fallback to SDK runner", {
            poolKeyHash: options.poolKey.slice(0, 8) + "…",
          });
          return;
        } catch (sdkErr) {
          throw new Error(
            `Pool binary unavailable (${runner.attemptedPath}); SDK fallback also failed: ${sdkErr instanceof Error ? sdkErr.message : String(sdkErr)}`,
          );
        }
      }

      const controller = {
        enqueue: (data: Uint8Array) => {
          this.stdout.write(data);
        },
        enqueueStderr: (data: Uint8Array) => {
          this.stderr.write(data);
        },
        close: () => {
          this.stdout.end();
        },
        closeStderr: () => {
          this.stderr.end();
        },
        error: (err: Error) => {
          this.stdout.destroy(err);
        },
      };

      const requestId = runner.registerPending(
        controller,
        (code) => {
          this.stderr.end();
          this.emit("close", code);
        },
        (err) => {
          this.stderr.end();
          this.emit("error", err);
        },
      );

      this.requestId = requestId;
      runner.sendRequest(requestId, options);
      log.debug("cursor-agent pool request dispatched", {
        requestId,
        poolKeyHash: options.poolKey.slice(0, 8) + "…",
        resume: !!options.resumeChatId,
      });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      log.error("Failed to spawn cursor-agent pool child", { error: error.message });
      this.emit("error", error);
      // Ensure the consumer sees a terminal close event and the streams end,
      // otherwise an HTTP response can be left open on spawn failure. Do not
      // destroy stdout with the error object: the PassThrough has no error
      // listener and would turn it into an unhandled exception.
      this.stderr.end();
      this.stdout.end();
      this.emit("close", 1);
    }
  }

  kill(): void {
    if (this.runner && this.requestId) {
      log.debug(`kill() cancelling pool request ${this.requestId}`);
      this.runner.cancel(this.requestId);
    } else if (this.requestId) {
      log.debug(`kill() called before runner ready for ${this.requestId}`);
    }
    if (this.sdkChild) {
      this.sdkChild.kill();
    }
  }
}

export function createCursorAgentPoolNodeChild(options: {
  model: string;
  prompt: string;
  cwd: string;
  resumeChatId?: string;
  force?: boolean;
  sdkApiKey?: string;
}): CursorAgentPoolNodeChild {
  const poolKey = buildAgentPoolKey(options.cwd, options.model);
  const child = new CursorAgentPoolNodeChild(options.sdkApiKey);
  child.spawn({ ...options, poolKey });
  return child;
}
