/**
 * Verifies that plugin-executed tools enforce Kilo `permission` constraints.
 *
 * In Kilo, enforcement lives inside each native tool via `ctx.ask({ permission, patterns,
 * always })`. Plugin tool hooks (oc_* aliases and plugin-only tools) do not go through the
 * native implementations, so the plugin must issue the same `ctx.ask` requests itself.
 *
 * `resolvePermissionKey` maps aliases to the native permission key:
 *   oc_read  -> read     oc_bash -> bash (shell -> bash)
 *   oc_edit  -> edit     oc_write -> edit (write shares the native edit action)
 *   oc_glob  -> glob     plugin-only tools (ls/mkdir/rm/stat) -> their own name
 */
import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { CursorPlugin, resolvePermissionKey } from "../../src/plugin";
import type { PluginInput } from "@kilocode/plugin";

function createMockInput(directory: string, worktree: string = directory): PluginInput {
  return {
    directory,
    worktree,
    serverUrl: new URL("http://localhost:8080"),
    client: { tool: { list: async () => [] } } as any,
    project: {} as any,
    $: {} as any,
  };
}

/** A context that records every ask() and can deny by throwing (mirrors DeniedError). */
function createRecordingContext(directory: string, worktree: string = directory, deny = false): { ctx: any; asks: any[] } {
  const asks: any[] = [];
  const ctx: any = {
    sessionID: "test-session",
    messageID: "test-message",
    agent: "test-agent",
    directory,
    worktree,
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async (input: any) => {
      asks.push(input);
      if (deny) throw new Error(`PermissionDenied: ${input.permission}`);
    },
  };
  return { ctx, asks };
}

describe("resolvePermissionKey maps plugin names to native permission keys", () => {
  it("maps oc_* aliases to their native base name", () => {
    expect(resolvePermissionKey("oc_read")).toBe("read");
    expect(resolvePermissionKey("oc_edit")).toBe("edit");
    expect(resolvePermissionKey("oc_glob")).toBe("glob");
    expect(resolvePermissionKey("oc_grep")).toBe("grep");
  });

  it("maps shell/write onto the native bash/edit keys", () => {
    expect(resolvePermissionKey("bash")).toBe("bash");
    expect(resolvePermissionKey("shell")).toBe("bash");
    expect(resolvePermissionKey("oc_bash")).toBe("bash");
    expect(resolvePermissionKey("write")).toBe("edit");
    expect(resolvePermissionKey("oc_write")).toBe("edit");
  });

  it("keeps plugin-only tool names as their own key", () => {
    expect(resolvePermissionKey("ls")).toBe("ls");
    expect(resolvePermissionKey("mkdir")).toBe("mkdir");
    expect(resolvePermissionKey("rm")).toBe("rm");
    expect(resolvePermissionKey("stat")).toBe("stat");
  });
});

describe("plugin tool hooks issue ctx.ask with the mapped permission key", () => {
  it("oc_read asks with permission `read`", async () => {
    const dir = mkdtempSync(join(tmpdir(), "perm-read-"));
    try {
      const target = join(dir, "file.txt");
      writeFileSync(target, "contents", "utf-8");
      const hooks = await CursorPlugin(createMockInput(dir));
      const { ctx, asks } = createRecordingContext(dir);

      await hooks.tool?.oc_read?.execute({ path: target }, ctx);

      expect(asks.some((a) => a.permission === "read")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  it("oc_edit and oc_write ask with permission `edit`", async () => {
    const dir = mkdtempSync(join(tmpdir(), "perm-edit-"));
    try {
      const target = join(dir, "file.txt");
      writeFileSync(target, "hello world", "utf-8");
      const hooks = await CursorPlugin(createMockInput(dir));

      const edit = createRecordingContext(dir);
      await hooks.tool?.oc_edit?.execute({ path: target, old_string: "hello", new_string: "goodbye" }, edit.ctx);
      expect(edit.asks.some((a) => a.permission === "edit")).toBe(true);

      const write = createRecordingContext(dir);
      await hooks.tool?.oc_write?.execute({ path: join(dir, "new.txt"), content: "x" }, write.ctx);
      expect(write.asks.some((a) => a.permission === "edit")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  it("oc_bash asks with permission `bash`", async () => {
    const dir = mkdtempSync(join(tmpdir(), "perm-bash-"));
    try {
      const hooks = await CursorPlugin(createMockInput(dir));
      const { ctx, asks } = createRecordingContext(dir);

      await hooks.tool?.oc_bash?.execute({ command: "echo hi" }, ctx);

      expect(asks.some((a) => a.permission === "bash")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  it("plugin-only ls/mkdir/rm/stat ask under their own permission key", async () => {
    const dir = mkdtempSync(join(tmpdir(), "perm-own-"));
    try {
      const hooks = await CursorPlugin(createMockInput(dir));

      const mk = createRecordingContext(dir);
      await hooks.tool?.mkdir?.execute({ path: join(dir, "sub") }, mk.ctx);
      expect(mk.asks.some((a) => a.permission === "mkdir")).toBe(true);

      const ls = createRecordingContext(dir);
      await hooks.tool?.ls?.execute({ path: dir }, ls.ctx);
      expect(ls.asks.some((a) => a.permission === "ls")).toBe(true);

      const st = createRecordingContext(dir);
      await hooks.tool?.stat?.execute({ path: join(dir, "sub") }, st.ctx);
      expect(st.asks.some((a) => a.permission === "stat")).toBe(true);

      const del = createRecordingContext(dir);
      await hooks.tool?.rm?.execute({ path: join(dir, "sub"), force: true }, del.ctx);
      expect(del.asks.some((a) => a.permission === "rm")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);
});

describe("plugin tool hooks enforce a deny reply", () => {
  it("propagates the denial and does not perform the edit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "perm-deny-"));
    try {
      const target = join(dir, "file.txt");
      writeFileSync(target, "hello world", "utf-8");
      const hooks = await CursorPlugin(createMockInput(dir));
      const { ctx } = createRecordingContext(dir, dir, true); // deny = true

      await expect(
        hooks.tool?.oc_edit?.execute({ path: target, old_string: "hello", new_string: "goodbye" }, ctx),
      ).rejects.toThrow(/PermissionDenied/);

      // The file must be untouched because the permission was denied before execution.
      expect(readFileSync(target, "utf-8")).toBe("hello world");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  it("propagates the denial and does not run the command", async () => {
    const dir = mkdtempSync(join(tmpdir(), "perm-deny-bash-"));
    try {
      const marker = join(dir, "marker.txt");
      const hooks = await CursorPlugin(createMockInput(dir));
      const { ctx } = createRecordingContext(dir, dir, true);

      await expect(
        hooks.tool?.oc_bash?.execute({ command: `touch ${marker}` }, ctx),
      ).rejects.toThrow(/PermissionDenied/);

      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);
});

describe("external_directory is requested for targets outside the workspace", () => {
  it("asks external_directory for a read outside the worktree", async () => {
    const dir = mkdtempSync(join(tmpdir(), "perm-ext-ws-"));
    const outside = mkdtempSync(join(tmpdir(), "perm-ext-out-"));
    try {
      const target = join(outside, "secret.txt");
      writeFileSync(target, "secret", "utf-8");
      const hooks = await CursorPlugin(createMockInput(dir));
      const { ctx, asks } = createRecordingContext(dir);

      await hooks.tool?.oc_read?.execute({ path: target }, ctx);

      expect(asks.some((a) => a.permission === "external_directory")).toBe(true);
      expect(asks.some((a) => a.permission === "read")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  }, 30000);

  it("does not ask external_directory for a target inside the worktree", async () => {
    const dir = mkdtempSync(join(tmpdir(), "perm-int-"));
    try {
      const target = join(dir, "inside.txt");
      writeFileSync(target, "inside", "utf-8");
      const hooks = await CursorPlugin(createMockInput(dir));
      const { ctx, asks } = createRecordingContext(dir);

      await hooks.tool?.oc_read?.execute({ path: target }, ctx);

      expect(asks.some((a) => a.permission === "external_directory")).toBe(false);
      expect(asks.some((a) => a.permission === "read")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);
});
