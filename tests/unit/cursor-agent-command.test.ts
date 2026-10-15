import { describe, expect, test } from "bun:test";
import { buildCursorAgentSpawnCommand } from "../../src/utils/cursor-agent-command.mjs";

describe("Cursor Windows launcher", () => {
  const command = "C:\\Users\\One Drive\\AppData\\Local\\cursor-agent\\cursor-agent.cmd";
  const workspace = "C:\\OneDrive - Contoso, Inc\\project & %PATH% !bang! (draft)\\";
  const args = ["--workspace", workspace];
  test("bypasses batch delayed expansion with the installed PowerShell sibling", () => {
    expect(buildCursorAgentSpawnCommand(command, args, {
      platform: "win32", env: { SystemRoot: "C:\\Windows" }, existsSync: () => true,
    })).toEqual(["C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", command.replace(/\.cmd$/, ".ps1"), ...args,
    ]]);
  });
  test("preserves custom executables and does not pick a PowerShell file from cwd", () => {
    for (const executable of ["cursor-agent.cmd", "C:\\bin\\custom.exe"]) {
      expect(buildCursorAgentSpawnCommand(executable, args, {
        platform: "win32", existsSync: () => true,
      })).toEqual([executable, args]);
    }
    expect(buildCursorAgentSpawnCommand(command, args, {
      platform: "win32", existsSync: () => false,
    })).toEqual([command, args]);
    expect(buildCursorAgentSpawnCommand(command, args, {
      platform: "linux", existsSync: () => true,
    })).toEqual([command, args]);
  });
});
