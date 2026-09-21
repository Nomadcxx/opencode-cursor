import { describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSdkNodeChild,
  stopSdkRunner,
} from "../../src/client/sdk-child.js";

// Fake runner that forwards images passthrough: it mimics the real
// sdk-runner.mjs contract and records what the proxy actually sent on stdin,
// so we can assert that images appear in the NDJSON when provided and are
// absent otherwise (backward compatible). The received `images` array (or
// null) is written to IMAGES_OUT as JSON for the test to assert on — the raw
// image payload itself is not logged, only its JSON shape.
const FAKE_RUNNER = `#!/usr/bin/env node
import fs from "node:fs";
process.stdin.setEncoding("utf8");
let buffer = "";
function emit(payload) { process.stdout.write(JSON.stringify(payload) + "\\n"); }
function handle(line) {
  const request = JSON.parse(line);
  if (request.op === "listModels") {
    emit({ id: request.id, event: { type: "models", models: [{ id: "fake-model", name: "Fake" }] } });
    emit({ id: request.id, done: true, exitCode: 0 });
    return;
  }
  // Record what the proxy sent for the images field (undefined if absent).
  const outPath = process.env.IMAGES_OUT;
  if (outPath) fs.writeFileSync(outPath, JSON.stringify("images" in request ? request.images : null));
  emit({ id: request.id, event: { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "fake sdk response" }] } } });
  emit({ id: request.id, done: true, exitCode: 0 });
}
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\\n");
  buffer = lines.pop() || "";
  for (const line of lines) if (line.trim()) handle(line);
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

describe("sdk-child images passthrough", () => {
  it("includes images in the NDJSON request when provided, and omits them when not", async () => {
    const originalRunnerPath = process.env.CURSOR_ACP_SDK_RUNNER_PATH;
    const originalOut = process.env.IMAGES_OUT;
    const dir = mkdtempSync(join(tmpdir(), "open-cursor-imgs-runner-"));
    const runnerPath = join(dir, "fake-runner.mjs");
    const outPath = join(dir, "recorded.json");
    writeFileSync(runnerPath, FAKE_RUNNER, "utf8");
    chmodSync(runnerPath, 0o755);

    process.env.CURSOR_ACP_SDK_RUNNER_PATH = runnerPath;
    process.env.IMAGES_OUT = outPath;

    try {
      // Case 1: with images → present in NDJSON.
      const child = createSdkNodeChild({
        apiKey: "cursor_123",
        model: "auto",
        prompt: "describe this",
        cwd: dir,
        images: [{ data: "AAAB", mimeType: "image/png" }],
      });
      await Promise.all([streamToString(child.stdout), waitForClose(child)]);
      expect(JSON.parse(readFileSync(outPath, "utf8"))).toEqual([
        { data: "AAAB", mimeType: "image/png" },
      ]);

      // Case 2: no images → field absent entirely (backward compatible).
      const child2 = createSdkNodeChild({
        apiKey: "cursor_123",
        model: "auto",
        prompt: "no image",
        cwd: dir,
      });
      await Promise.all([streamToString(child2.stdout), waitForClose(child2)]);
      expect(JSON.parse(readFileSync(outPath, "utf8"))).toBeNull();
    } finally {
      stopSdkRunner();
      if (originalRunnerPath === undefined) {
        delete process.env.CURSOR_ACP_SDK_RUNNER_PATH;
      } else {
        process.env.CURSOR_ACP_SDK_RUNNER_PATH = originalRunnerPath;
      }
      if (originalOut === undefined) {
        delete process.env.IMAGES_OUT;
      } else {
        process.env.IMAGES_OUT = originalOut;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
