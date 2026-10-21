import { describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  discoverModelsFromCursorAgent,
  discoverModelsFromCursorAgentAsync,
  parseCursorModelsOutput,
} from "../../../src/cli/model-discovery.js";

describe("cli/model-discovery", () => {
  it("parses model ids and names from cursor-agent output", () => {
    const output = `
auto - Auto (current) (default)
sonnet-4.5 - Claude 4.5 Sonnet
gpt-5.2 - GPT-5.2
`;

    const models = parseCursorModelsOutput(output);
    expect(models).toEqual([
      { id: "auto", name: "Auto" },
      { id: "sonnet-4.5", name: "Claude 4.5 Sonnet" },
      { id: "gpt-5.2", name: "GPT-5.2" },
    ]);
  });

  it("ignores noise and de-duplicates ids", () => {
    const output = `
\u001b[32mauto - Auto (current)\u001b[0m
Tip: run cursor-agent login
auto - Auto
`;

    const models = parseCursorModelsOutput(output);
    expect(models).toEqual([{ id: "auto", name: "Auto" }]);
  });
});

describe("cli/model-discovery discoverModelsFromCursorAgent", () => {
  it("passes the raw binary and arguments to the escaped spawn implementation on Windows", () => {
    const calls: Array<{ cmd: string; args: string[]; opts: any }> = [];
    const exec = (cmd: string, args: string[], opts: any) => {
      calls.push({ cmd, args, opts });
      return { status: 0, stdout: "auto - Auto\n", stderr: "" };
    };

    const models = discoverModelsFromCursorAgent({
      platform: "win32",
      spawnSync: exec as any,
      resolveBinary: () => "C:\\Users\\Walter Meier\\AppData\\Local\\cursor-agent\\cursor-agent.cmd",
    });

    expect(models).toEqual([{ id: "auto", name: "Auto" }]);
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe("C:\\Users\\Walter Meier\\AppData\\Local\\cursor-agent\\cursor-agent.cmd");
    expect(calls[0].args).toEqual(["models"]);
    expect(calls[0].opts.shell).toBeUndefined();
  });

  it("does not use shell mode on non-Windows platforms", () => {
    const calls: Array<{ cmd: string; args: string[]; opts: any }> = [];
    const exec = (cmd: string, args: string[], opts: any) => {
      calls.push({ cmd, args, opts });
      return { status: 0, stdout: "auto - Auto\n", stderr: "" };
    };

    discoverModelsFromCursorAgent({
      platform: "linux",
      spawnSync: exec as any,
      resolveBinary: () => "/home/walter meier/.cursor-agent/cursor-agent",
    });

    // no shell on posix, so the path is passed through unquoted
    expect(calls[0].cmd).toBe("/home/walter meier/.cursor-agent/cursor-agent");
    expect(calls[0].opts.shell).toBeUndefined();
    expect(calls[0].opts.killSignal).toBe("SIGTERM");
  });

  it("reports nonzero exit status instead of parsing partial model output", () => {
    expect(() => discoverModelsFromCursorAgent({
      spawnSync: (() => ({ status: 1, stdout: "auto - Auto\n", stderr: "workspace trust required" })) as any,
      resolveBinary: () => "cursor-agent",
    })).toThrow("workspace trust required");
  });
});

describe("cli/model-discovery discoverModelsFromCursorAgentAsync", () => {
  type FakeChild = EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: (signal?: string) => void; killed?: string };

  function fakeSpawn(run: (child: FakeChild) => void) {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const spawn = (cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill(signal?: string) { child.killed = signal; },
      }) as FakeChild;
      queueMicrotask(() => run(child));
      return child;
    };
    return { spawn: spawn as any, calls };
  }

  function exit(child: FakeChild, status: number, stdout = "", stderr = "") {
    child.stdout.end(stdout);
    child.stderr.end(stderr);
    // `close` follows the stdio streams; give their data events a turn first.
    setTimeout(() => child.emit("close", status), 0);
  }

  it("parses models without blocking on the child", async () => {
    const { spawn, calls } = fakeSpawn((child) => exit(child, 0, "auto - Auto\nglm-5.2-high - GLM 5.2\n"));

    const pending = discoverModelsFromCursorAgentAsync({ spawn, resolveBinary: () => "cursor-agent" });
    expect(calls).toEqual([{ cmd: "cursor-agent", args: ["models"] }]);

    expect(await pending).toEqual([
      { id: "auto", name: "Auto" },
      { id: "glm-5.2-high", name: "GLM 5.2" },
    ]);
  });

  it("reports a nonzero exit with stderr instead of parsing partial output", async () => {
    const { spawn } = fakeSpawn((child) => exit(child, 1, "auto - Auto\n", "workspace trust required"));

    await expect(discoverModelsFromCursorAgentAsync({ spawn, resolveBinary: () => "cursor-agent" }))
      .rejects.toThrow("workspace trust required");
  });

  it("rejects a spawn error", async () => {
    const { spawn } = fakeSpawn((child) => child.emit("error", new Error("spawn cursor-agent ENOENT")));

    await expect(discoverModelsFromCursorAgentAsync({ spawn, resolveBinary: () => "cursor-agent" }))
      .rejects.toThrow("ENOENT");
  });

  it("kills a hung child after the timeout", async () => {
    let hung: FakeChild | undefined;
    const { spawn } = fakeSpawn((child) => { hung = child; });

    await expect(discoverModelsFromCursorAgentAsync({ spawn, resolveBinary: () => "cursor-agent", timeoutMs: 10 }))
      .rejects.toThrow("timed out after 10ms");
    expect(hung?.killed).toBe("SIGTERM");
  });
});
