import { describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSdkNodeChild,
  listModelsViaRunner,
  resolveRunnerPath,
  stopSdkRunner,
} from "../../src/client/sdk-child.js";

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

  emit({
    id: request.id,
    event: {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "fake sdk response" }],
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

    try {
      const child = createSdkNodeChild({
        apiKey: "cursor_123",
        model: "auto",
        prompt: "hello",
        cwd: dir,
      });

      const [stdout, exitCode] = await Promise.all([
        streamToString(child.stdout),
        waitForClose(child),
      ]);

      expect(exitCode).toBe(0);
      expect(stdout).toContain("fake sdk response");

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
