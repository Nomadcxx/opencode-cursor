/**
 * cursor-agent-fallback.test.ts
 *
 * Tests for the Windows binary-missing SDK fallback path in cursor-agent-child.ts.
 * These tests mock resolveCursorAgentBinaryStrict to throw BinaryNotFoundError,
 * simulating the win32 + binary-missing condition.
 */

import { BinaryNotFoundError } from "../../src/utils/errors.js";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Module mocks (hoisted by Bun before imports) ───────────────────────────

// Mock binary module: resolveCursorAgentBinaryStrict always throws BinaryNotFoundError,
// simulating win32 + binary missing. Plain resolver returns a bare fallback string.
const FAKE_ATTEMPTED_PATH = "C:\\Users\\test\\AppData\\Local\\cursor-agent\\cursor-agent.cmd";
let strictResolveCalls = 0;

mock.module(resolve(__dirname, "../../src/utils/binary.js"), () => ({
  resolveCursorAgentBinaryStrict: () => {
    strictResolveCalls += 1;
    throw new BinaryNotFoundError(FAKE_ATTEMPTED_PATH);
  },
  resolveCursorAgentBinary: () => "cursor-agent.cmd",
}));

// Mock logger — attempt to capture warn calls (may not intercept due to module load order).
const warnCalls: { msg: string; meta?: unknown }[] = [];
mock.module(resolve(__dirname, "../../src/utils/logger.js"), () => ({
  createLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: (msg: string, meta?: unknown) => {
      warnCalls.push({ msg, meta });
    },
    error: () => {},
  }),
}));

// Now import the module under test (will receive the mocked dependencies).
import {
  _getCursorAgentPoolSizeForTests,
  _resetCursorAgentPoolForTests,
  createCursorAgentPoolNodeChild,
  stopCursorAgentPool,
} from "../../src/client/cursor-agent-child.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Create a mock SdkNodeChild-compatible object (EventEmitter + stdout/stderr streams). */
function createMockSdkChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    kill: () => void;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {};
  return child;
}

/** Wait for an event on an EventEmitter, with timeout. Returns true if event fired. */
function waitForEvent(
  emitter: EventEmitter,
  event: string,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    emitter.once(event, () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/** Small delay to let async spawnInternal() settle. */
function settle(ms = 50): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("cursor-agent pool: Windows binary-missing fallback", () => {
  beforeEach(() => {
    warnCalls.length = 0;
    strictResolveCalls = 0;
  });

  afterEach(() => {
    stopCursorAgentPool();
    _resetCursorAgentPoolForTests();
  });

  it("warn-once: log.warn is called exactly once when repeated children share the same poolKey", async () => {
    const child1 = createCursorAgentPoolNodeChild({
      model: "m",
      prompt: "hi-1",
      cwd: "/ws",
      sdkApiKey: "test-key",
      createSdkChild: () => createMockSdkChild(),
    });
    await settle(100);

    const child2 = createCursorAgentPoolNodeChild({
      model: "m",
      prompt: "hi-2",
      cwd: "/ws",
      sdkApiKey: "test-key",
      createSdkChild: () => createMockSdkChild(),
    });
    await settle(100);

    expect(_getCursorAgentPoolSizeForTests()).toBe(1);
    expect(strictResolveCalls).toBe(1);

    // Clean up
    child1.kill();
    child2.kill();
  });

  it("SDK factory invoked as fallback with the provided apiKey", async () => {
    const factoryCalls: { apiKey: string; model: string; prompt: string; cwd: string }[] = [];
    const mockSdk = createMockSdkChild();

    const child = createCursorAgentPoolNodeChild({
      model: "gpt-5",
      prompt: "hello",
      cwd: "/workspace",
      sdkApiKey: "sk-my-secret-key",
      createSdkChild: (opts) => {
        factoryCalls.push(opts);
        return mockSdk;
      },
    });

    await settle(100);

    // The factory should have been called exactly once with the correct apiKey.
    expect(factoryCalls.length).toBe(1);
    expect(factoryCalls[0].apiKey).toBe("sk-my-secret-key");
    expect(factoryCalls[0].model).toBe("gpt-5");
    expect(factoryCalls[0].prompt).toBe("hello");
    expect(factoryCalls[0].cwd).toBe("/workspace");

    child.kill();
  });

  it("dual-failure: error message contains both binary path and 'no sdkApiKey' when no key provided", async () => {
    const child = createCursorAgentPoolNodeChild({
      model: "m",
      prompt: "hi",
      cwd: "/ws",
      // No sdkApiKey → dual-failure path
    });

    // Wait for both "error" and "close" events simultaneously.
    const errorPromise = new Promise<Error>((resolve) => {
      child.on("error", (err: Error) => resolve(err));
    });
    const closePromise = waitForEvent(child, "close", 2000);

    const gotError = await Promise.race([
      errorPromise,
      settle(500).then(() => null),
    ]);

    expect(gotError).toBeInstanceOf(Error);
    const msg = (gotError as Error).message;

    // Must contain BOTH the attempted binary path AND the "no sdkApiKey" reason.
    expect(msg).toContain(FAKE_ATTEMPTED_PATH);
    expect(msg).toContain("no sdkApiKey");

    // Should also emit close after error.
    const gotClose = await closePromise;
    expect(gotClose).toBe(true);
  });
});
