import { describe, expect, it } from "bun:test";
import {
  discoverModelsFromCursorAgent,
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
