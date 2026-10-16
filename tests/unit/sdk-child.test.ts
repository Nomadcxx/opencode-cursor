import { describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSdkBunChild,
  createSdkNodeChild,
  listModelsViaRunner,
  resolveRunnerPath,
  stopSdkRunner,
} from "../../src/client/sdk-child.js";
import { isSdkApiKeyRejected } from "../../src/auth.js";

const FAKE_RUNNER = `#!/usr/bin/env node
process.stdin.setEncoding("utf8");
let buffer = "";

function emit(payload) {
  process.stdout.write(JSON.stringify(payload) + "\\n");
}

function handle(line) {
  const request = JSON.parse(line);
  if (request.op === "listModels") {
    emit({
      id: request.id,
      event: {
        type: "models",
        models: [{ id: "fake-model", name: "Fake Model" }],
      },
    });
    emit({ id: request.id, done: true, exitCode: 0 });
    return;
  }

  const hasParams = Object.prototype.hasOwnProperty.call(request, "params");
  const echo = hasParams ? "params=" + JSON.stringify(request.params) : "params=ABSENT";
  emit({
    id: request.id,
    event: {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: echo }],
      },
    },
  });
  emit({ id: request.id, done: true, exitCode: 0 });
}

process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\\n");
  buffer = lines.pop() || "";
  for (const line of lines) {
    if (line.trim()) handle(line);
  }
});
`;

// Streams events for a request until it receives {"id","op":"cancel"} for it.
const STREAMING_RUNNER = `#!/usr/bin/env node
process.stdin.setEncoding("utf8");
let buffer = "";
const timers = new Map();

function emit(payload) {
  process.stdout.write(JSON.stringify(payload) + "\\n");
}

function handle(line) {
  const request = JSON.parse(line);
  if (request.op === "cancel") {
    const timer = timers.get(request.id);
    if (!timer) return;
    clearInterval(timer);
    timers.delete(request.id);
    emit({ id: request.id, done: true, exitCode: 130 });
    return;
  }
  let n = 0;
  timers.set(request.id, setInterval(() => {
    n++;
    emit({
      id: request.id,
      event: {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "tick-" + n }] },
      },
    });
  }, 10));
}

process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\\n");
  buffer = lines.pop() || "";
  for (const line of lines) {
    if (line.trim()) handle(line);
  }
});
`;

// Fails every request the way @cursor/sdk does for a key Cursor refuses.
const REJECTING_RUNNER = `#!/usr/bin/env node
process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\\n");
  buffer = lines.pop() || "";
  for (const line of lines) {
    if (!line.trim()) continue;
    const { id } = JSON.parse(line);
    const event = { type: "result", subtype: "error", is_error: true, error: { message: "Invalid User API Key" } };
    process.stdout.write(JSON.stringify({ id, event }) + "\\n");
    process.stdout.write(JSON.stringify({ id, done: true, exitCode: 1 }) + "\\n");
  }
});
`;

async function streamToString(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function waitForClose(child: NodeJS.EventEmitter): Promise<number> {
  return new Promise((resolve, reject) => {
    child.once("close", resolve);
    child.once("error", reject);
  });
}

describe("sdk-child runner path resolution", () => {
  it("resolves sdk-runner.mjs from source module layout", () => {
    const result = resolveRunnerPath("/pkg/src/client/sdk-child.ts", (candidate) =>
      candidate === "/pkg/scripts/sdk-runner.mjs",
    );

    expect(result).toBe("/pkg/scripts/sdk-runner.mjs");
  });

  it("resolves sdk-runner.mjs from bundled dist/plugin-entry.js layout", () => {
    const result = resolveRunnerPath("/pkg/dist/plugin-entry.js", (candidate) =>
      candidate === "/pkg/scripts/sdk-runner.mjs",
    );

    expect(result).toBe("/pkg/scripts/sdk-runner.mjs");
  });

  it("uses an explicit fake runner path for SDK chat and model-list smoke", async () => {
    const originalRunnerPath = process.env.CURSOR_ACP_SDK_RUNNER_PATH;
    const dir = mkdtempSync(join(tmpdir(), "open-cursor-fake-runner-"));
    const runnerPath = join(dir, "fake-runner.mjs");
    writeFileSync(runnerPath, FAKE_RUNNER, "utf8");
    chmodSync(runnerPath, 0o755);

    process.env.CURSOR_ACP_SDK_RUNNER_PATH = runnerPath;

    async function runChild(params?: Array<{ id: string; value: string }>) {
      const child = createSdkNodeChild({
        apiKey: "cursor_123",
        model: "auto",
        prompt: "hello",
        cwd: dir,
        params,
      });
      const [stdout, exitCode] = await Promise.all([
        streamToString(child.stdout),
        waitForClose(child),
      ]);
      return { stdout, exitCode };
    }

    try {
      // No params: the NDJSON request must omit the field entirely (ABSENT).
      const noParams = await runChild();
      expect(noParams.exitCode).toBe(0);
      expect(noParams.stdout).toContain("params=ABSENT");

      // With params: the NDJSON request carries them to the runner. The echo
      // text is JSON-encoded inside the event, so quotes appear escaped.
      const withParams = await runChild([
        { id: "effort", value: "max" },
        { id: "fast", value: "true" },
      ]);
      expect(withParams.exitCode).toBe(0);
      expect(withParams.stdout).toContain(
        "params=[{\\\"id\\\":\\\"effort\\\",\\\"value\\\":\\\"max\\\"},{\\\"id\\\":\\\"fast\\\",\\\"value\\\":\\\"true\\\"}]",
      );

      const models = await listModelsViaRunner("cursor_123");
      expect(models).toEqual([{ id: "fake-model", name: "Fake Model" }]);
    } finally {
      stopSdkRunner();
      if (originalRunnerPath === undefined) {
        delete process.env.CURSOR_ACP_SDK_RUNNER_PATH;
      } else {
        process.env.CURSOR_ACP_SDK_RUNNER_PATH = originalRunnerPath;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("sdk-child cancellation", () => {
  it("kill() cancels the in-flight runner request and drops its later events", async () => {
    const originalRunnerPath = process.env.CURSOR_ACP_SDK_RUNNER_PATH;
    const dir = mkdtempSync(join(tmpdir(), "open-cursor-streaming-runner-"));
    const runnerPath = join(dir, "streaming-runner.mjs");
    writeFileSync(runnerPath, STREAMING_RUNNER, "utf8");
    chmodSync(runnerPath, 0o755);
    stopSdkRunner();
    process.env.CURSOR_ACP_SDK_RUNNER_PATH = runnerPath;

    try {
      const child = createSdkNodeChild({
        apiKey: "cursor_123",
        model: "auto",
        prompt: "hello",
        cwd: dir,
      });
      const closed = waitForClose(child);

      let received = "";
      let killedAt = -1;
      await new Promise<void>((resolve) => {
        child.stdout.on("data", (chunk) => {
          received += chunk.toString("utf8");
          if (killedAt < 0 && received.includes("tick-3")) {
            killedAt = received.length;
            child.kill();
            resolve();
          }
        });
      });

      // The fake runner reports 130 only after it received the cancel op;
      // without it the request would stream forever and this would time out.
      expect(await closed).toBe(130);
      // Anything the runner streamed between kill() and done is dropped.
      expect(received.length).toBe(killedAt);
    } finally {
      stopSdkRunner();
      if (originalRunnerPath === undefined) {
        delete process.env.CURSOR_ACP_SDK_RUNNER_PATH;
      } else {
        process.env.CURSOR_ACP_SDK_RUNNER_PATH = originalRunnerPath;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  }, 10_000);
});

describe("sdk-child runner errors", () => {
  it("reports runner error events as request stderr and marks rejected keys", async () => {
    const originalRunnerPath = process.env.CURSOR_ACP_SDK_RUNNER_PATH;
    const dir = mkdtempSync(join(tmpdir(), "open-cursor-rejecting-runner-"));
    const runnerPath = join(dir, "rejecting-runner.mjs");
    writeFileSync(runnerPath, REJECTING_RUNNER, "utf8");
    process.env.CURSOR_ACP_SDK_RUNNER_PATH = runnerPath;
    const request = { model: "auto", prompt: "hello", cwd: dir };

    try {
      const nodeChild = createSdkNodeChild({ ...request, apiKey: "cursor_node_bad" });
      const [, nodeStderr, nodeExit] = await Promise.all([
        streamToString(nodeChild.stdout),
        streamToString(nodeChild.stderr),
        waitForClose(nodeChild),
      ]);
      expect(nodeExit).toBe(1);
      expect(nodeStderr).toBe("Invalid User API Key\n");
      expect(isSdkApiKeyRejected("cursor_node_bad")).toBe(true);

      const bunChild = createSdkBunChild({ ...request, apiKey: "cursor_bun_bad" });
      const [, bunExit] = await Promise.all([new Response(bunChild.stdout).text(), bunChild.exited]);
      expect(bunExit).toBe(1);
      expect(await new Response(bunChild.stderr).text()).toBe("Invalid User API Key\n");

      await expect(listModelsViaRunner("cursor_list_bad")).rejects.toThrow();
      expect(isSdkApiKeyRejected("cursor_list_bad")).toBe(true);
      expect(isSdkApiKeyRejected("cursor_never_used")).toBe(false);
    } finally {
      stopSdkRunner();
      if (originalRunnerPath === undefined) {
        delete process.env.CURSOR_ACP_SDK_RUNNER_PATH;
      } else {
        process.env.CURSOR_ACP_SDK_RUNNER_PATH = originalRunnerPath;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  }, 10_000);
});
