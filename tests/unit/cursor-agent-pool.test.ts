import { afterEach, describe, expect, it } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { PassThrough } from "node:stream";
import {
  _getCursorAgentPoolSizeForTests,
  _resetCursorAgentPoolForTests,
  createCursorAgentPoolNodeChild,
  stopCursorAgentPool,
} from "../../src/client/cursor-agent-child.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const mockPath = resolve(__dirname, "../fixtures/mock-cursor-agent.mjs");
const runnerPath = resolve(process.cwd(), "scripts/cursor-agent-runner.mjs");

// Ensure the mock fixture is executable (shebang-based spawn on Linux).
try {
  chmodSync(mockPath, 0o755);
} catch {
  // chmod may fail on some filesystems; spawn will surface a real error if so.
}

/** Resolve true once predicate holds, or false after timeoutMs. */
function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  return new Promise((resolveFn) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      if (predicate()) return resolveFn(true);
      if (Date.now() >= deadline) return resolveFn(false);
      setTimeout(tick, 15);
    };
    tick();
  });
}

/** Resolve on the first `data` chunk of a stream, or null after timeoutMs. */
function firstChunk(stream: PassThrough, timeoutMs: number): Promise<Buffer | null> {
  return new Promise((resolveFn) => {
    const timer = setTimeout(() => {
      stream.removeListener("data", onData);
      resolveFn(null);
    }, timeoutMs);
    const onData = (chunk: Buffer) => {
      clearTimeout(timer);
      stream.removeListener("data", onData);
      resolveFn(chunk);
    };
    stream.once("data", onData);
  });
}

/** Resolve true if `event` fires within timeoutMs, else false. */
function waitForEvent(emitter: { once: (e: string, cb: (...a: unknown[]) => void) => void }, event: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolveFn) => {
    const timer = setTimeout(() => resolveFn(false), timeoutMs);
    emitter.once(event, (..._args: unknown[]) => {
      clearTimeout(timer);
      resolveFn(true);
    });
  });
}

function waitForClose(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  return waitForEvent(child, "close", timeoutMs);
}

describe("cursor-agent pool: cancellation + demux", () => {
  afterEach(() => {
    stopCursorAgentPool();
    _resetCursorAgentPoolForTests();
    delete process.env.CURSOR_AGENT_EXECUTABLE;
    delete process.env.CURSOR_ACP_AGENT_POOL_IDLE_MS;
  });

  it("runner cancels an in-flight request and emits done promptly", async () => {
    const runner = spawn("node", [runnerPath], { stdio: ["pipe", "pipe", "pipe"] });

    const lines: string[] = [];
    let buf = "";
    runner.stdout.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const parts = buf.split("\n");
      buf = parts.pop() ?? "";
      for (const line of parts) if (line.trim()) lines.push(line);
    });

    // Request targeting the hanging mock. The mock never exits on its own, so
    // a `done` line for r1 can only appear if the runner kills the child.
    runner.stdin.write(
      JSON.stringify({ id: "r1", model: "m", cwd: tmpdir(), prompt: "hi", cursorAgent: mockPath }) + "\n",
    );

    const sawEvent = await waitFor(
      () => lines.some((l) => l.includes('"id":"r1"') && l.includes('"event"')),
      6000,
    );
    expect(sawEvent).toBe(true);

    runner.stdin.write(JSON.stringify({ cancel: "r1" }) + "\n");

    const sawDone = await waitFor(
      () => lines.some((l) => l.includes('"id":"r1"') && l.includes('"done"')),
      3000,
    );
    expect(sawDone).toBe(true);

    runner.stdin.end();
    expect(await waitForClose(runner, 3000)).toBe(true);
  });

  it("runner drops a queued (not-yet-started) request on cancel", async () => {
    const runner = spawn("node", [runnerPath], { stdio: ["pipe", "pipe", "pipe"] });

    const lines: string[] = [];
    let buf = "";
    runner.stdout.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const parts = buf.split("\n");
      buf = parts.pop() ?? "";
      for (const line of parts) if (line.trim()) lines.push(line);
    });

    // r1 hangs (occupies the single serial slot); r2 queues behind it.
    runner.stdin.write(
      JSON.stringify({ id: "r1", model: "m", cwd: tmpdir(), prompt: "hi", cursorAgent: mockPath }) + "\n",
    );
    const r1Started = await waitFor(
      () => lines.some((l) => l.includes('"id":"r1"') && l.includes('"event"')),
      6000,
    );
    expect(r1Started).toBe(true);
    runner.stdin.write(
      JSON.stringify({ id: "r2", model: "m", cwd: tmpdir(), prompt: "hi", cursorAgent: mockPath }) + "\n",
    );

    // Cancel the queued r2 (it has not started) -> runner emits done without running it.
    runner.stdin.write(JSON.stringify({ cancel: "r2" }) + "\n");
    const r2Done = await waitFor(
      () => lines.some((l) => l.includes('"id":"r2"') && l.includes('"done"')),
      3000,
    );
    expect(r2Done).toBe(true);
    // r2 never produced an event line (it was dropped before start).
    expect(lines.some((l) => l.includes('"id":"r2"') && l.includes('"event"'))).toBe(false);

    // Clean up the still-running r1.
    runner.stdin.write(JSON.stringify({ cancel: "r1" }) + "\n");
    await waitFor(() => lines.some((l) => l.includes('"id":"r1"') && l.includes('"done"')), 3000);
    runner.stdin.end();
    expect(await waitForClose(runner, 3000)).toBe(true);
  });

  it("createCursorAgentPoolNodeChild.kill() cancels the in-flight request end-to-end", async () => {
    process.env.CURSOR_AGENT_EXECUTABLE = mockPath;
    const child = createCursorAgentPoolNodeChild({ model: "m", prompt: "hi", cwd: tmpdir() });

    // First stdout chunk proves the mock is running through the full chain.
    const first = await firstChunk(child.stdout as unknown as PassThrough, 6000);
    expect(first?.toString("utf8")).toContain("mock-chat-1");

    // kill() must actually cancel the hanging mock; without cancel, "close"
    // would never fire (the mock stays alive).
    child.kill();
    expect(await waitForEvent(child, "close", 3000)).toBe(true);
  });

  it("routes events to the correct request id (demux)", async () => {
    process.env.CURSOR_AGENT_EXECUTABLE = mockPath;

    // Two concurrent children on the same pool key share one serial runner.
    const a = createCursorAgentPoolNodeChild({ model: "m", prompt: "hi-a", cwd: tmpdir() });
    const aFirst = firstChunk(a.stdout as unknown as PassThrough, 6000);
    // Let 'a' start, then cancel it so the runner proceeds to 'b'.
    expect((await aFirst)?.toString("utf8")).toContain("mock-chat-1");
    a.kill();
    expect(await waitForEvent(a, "close", 3000)).toBe(true);

    const b = createCursorAgentPoolNodeChild({ model: "m", prompt: "hi-b", cwd: tmpdir() });
    const bFirst = await firstChunk(b.stdout as unknown as PassThrough, 6000);
    expect(bFirst?.toString("utf8")).toContain("mock-chat-1");
    b.kill();
    expect(await waitForEvent(b, "close", 3000)).toBe(true);
  });

  it("emits close and error when runner spawn fails", async () => {
    process.env.CURSOR_ACP_CURSOR_AGENT_RUNNER_PATH = "/nonexistent/runner.mjs";
    const child = createCursorAgentPoolNodeChild({ model: "m", prompt: "hi", cwd: tmpdir() });

    const errorPromise = waitForEvent(child, "error", 3000);
    const closePromise = waitForEvent(child, "close", 3000);
    expect(await errorPromise).toBe(true);
    expect(await closePromise).toBe(true);

    delete process.env.CURSOR_ACP_CURSOR_AGENT_RUNNER_PATH;
  });

  it("evicts idle runners after the configured idle timeout", async () => {
    process.env.CURSOR_AGENT_EXECUTABLE = mockPath;
    process.env.CURSOR_ACP_AGENT_POOL_IDLE_MS = "25";

    const child = createCursorAgentPoolNodeChild({ model: "m", prompt: "hi", cwd: tmpdir() });
    const first = await firstChunk(child.stdout as unknown as PassThrough, 3000);
    expect(first?.toString("utf8")).toContain("mock-chat-1");
    child.kill();
    expect(await waitForEvent(child, "close", 3000)).toBe(true);
    expect(_getCursorAgentPoolSizeForTests()).toBe(1);

    const evicted = await waitFor(() => _getCursorAgentPoolSizeForTests() === 0, 1000);
    expect(evicted).toBe(true);
  });
});
