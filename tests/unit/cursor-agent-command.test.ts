import { describe, expect, test } from "bun:test";
import { buildCursorAgentSpawnCommand, killCursorAgentTree } from "../../src/utils/cursor-agent-command.mjs";

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

describe("killCursorAgentTree", () => {
  const fakeChild = (pid?: number) => {
    const signals: Array<string | undefined> = [];
    return { pid, signals, kill: (signal?: string) => { signals.push(signal); return true; } };
  };
  const fakeTaskkill = (status: number | null, error?: Error) => {
    const calls: Array<{ cmd: string; args: string[]; opts: any }> = [];
    const spawnSync = ((cmd: string, args: string[], opts: any) => {
      calls.push({ cmd, args, opts });
      return { status, error };
    }) as any;
    return { calls, spawnSync };
  };

  test("takes the PowerShell launcher and the node.exe under it down together on Windows", () => {
    const child = fakeChild(4242);
    const { calls, spawnSync } = fakeTaskkill(0);
    killCursorAgentTree(child as any, "SIGKILL", { platform: "win32", spawnSync });
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe("taskkill");
    expect(calls[0].args).toEqual(["/pid", "4242", "/T", "/F"]);
    expect(calls[0].opts.windowsHide).toBe(true);
    expect(child.signals).toEqual([]);
  });

  test("falls back to the child's own kill when taskkill fails", () => {
    const child = fakeChild(4242);
    killCursorAgentTree(child as any, "SIGTERM", { platform: "win32", spawnSync: fakeTaskkill(128).spawnSync });
    killCursorAgentTree(child as any, "SIGTERM", {
      platform: "win32",
      spawnSync: fakeTaskkill(null, new Error("spawn taskkill ENOENT")).spawnSync,
    });
    expect(child.signals).toEqual(["SIGTERM", "SIGTERM"]);
  });

  test("signals the child directly off Windows and for wrappers without a pid", () => {
    const { calls, spawnSync } = fakeTaskkill(0);
    const unix = fakeChild(4242);
    killCursorAgentTree(unix as any, "SIGKILL", { platform: "linux", spawnSync });
    const wrapper = fakeChild();
    killCursorAgentTree(wrapper as any, undefined, { platform: "win32", spawnSync });
    expect(calls).toEqual([]);
    expect(unix.signals).toEqual(["SIGKILL"]);
    expect(wrapper.signals).toEqual(["SIGTERM"]);
  });

  test("ignores a missing child and a kill that throws", () => {
    expect(() => killCursorAgentTree(undefined)).not.toThrow();
    const exited = { kill: () => { throw new Error("ESRCH"); } };
    expect(() => killCursorAgentTree(exited as any, "SIGTERM", { platform: "linux" })).not.toThrow();
  });
});
