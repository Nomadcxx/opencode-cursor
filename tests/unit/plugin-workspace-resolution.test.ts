import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { homedir, tmpdir } from "os";
import { join, resolve } from "path";

import { resolveWorkspaceDirectory, isRootPath } from "../../src/plugin";

describe("isRootPath", () => {
  it("recognises the POSIX root", () => {
    expect(isRootPath("/")).toBe(true);
  });

  it.if(process.platform === "win32")("recognises Windows drive roots", () => {
    expect(isRootPath("C:\\")).toBe(true);
    expect(isRootPath("D:/")).toBe(true);
    expect(isRootPath("C:")).toBe(true);
  });

  it("rejects ordinary paths", () => {
    expect(isRootPath("/home/user")).toBe(false);
    expect(isRootPath("/tmp")).toBe(false);
    expect(isRootPath("")).toBe(false);
  });
});

describe("resolveWorkspaceDirectory", () => {
  let previousXdgConfigHome: string | undefined;
  let previousWorkspaceEnv: string | undefined;
  let previousProjectDirEnv: string | undefined;
  let previousCwd: string;
  let tempConfigHome: string;
  let tempWorkspace: string;

  beforeEach(() => {
    previousXdgConfigHome = process.env.XDG_CONFIG_HOME;
    previousWorkspaceEnv = process.env.CURSOR_ACP_WORKSPACE;
    previousProjectDirEnv = process.env.OPENCODE_CURSOR_PROJECT_DIR;
    previousCwd = process.cwd();

    tempConfigHome = mkdtempSync(join(tmpdir(), "opencode-cursor-cfg-"));
    tempWorkspace = mkdtempSync(join(tmpdir(), "opencode-cursor-ws-"));
    process.env.XDG_CONFIG_HOME = tempConfigHome;
    delete process.env.CURSOR_ACP_WORKSPACE;
    delete process.env.OPENCODE_CURSOR_PROJECT_DIR;
  });

  afterEach(() => {
    try {
      process.chdir(previousCwd);
    } catch {
      // best-effort restore
    }

    if (previousXdgConfigHome === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = previousXdgConfigHome;
    }
    if (previousWorkspaceEnv === undefined) {
      delete process.env.CURSOR_ACP_WORKSPACE;
    } else {
      process.env.CURSOR_ACP_WORKSPACE = previousWorkspaceEnv;
    }
    if (previousProjectDirEnv === undefined) {
      delete process.env.OPENCODE_CURSOR_PROJECT_DIR;
    } else {
      process.env.OPENCODE_CURSOR_PROJECT_DIR = previousProjectDirEnv;
    }

    rmSync(tempConfigHome, { recursive: true, force: true });
    rmSync(tempWorkspace, { recursive: true, force: true });
  });

  it("prefers a real worktree over cwd", () => {
    const result = resolveWorkspaceDirectory(tempWorkspace, undefined);
    expect(result).toBe(resolve(tempWorkspace));
  });

  it("prefers directory when worktree is missing", () => {
    const result = resolveWorkspaceDirectory(undefined, tempWorkspace);
    expect(result).toBe(resolve(tempWorkspace));
  });

  it("rejects '/' from worktree and directory and falls back to cwd", () => {
    process.chdir(tempWorkspace);
    const result = resolveWorkspaceDirectory("/", "/");
    expect(result).toBe(resolve(tempWorkspace));
  });

  it("falls back to $HOME when worktree, directory, and cwd are all '/'", () => {
    process.chdir("/");
    const result = resolveWorkspaceDirectory("/", "/");
    expect(result).toBe(resolve(homedir()));
    expect(result).not.toBe("/");
  });

  it("rejects '/' provided via CURSOR_ACP_WORKSPACE", () => {
    process.env.CURSOR_ACP_WORKSPACE = "/";
    process.chdir(tempWorkspace);
    const result = resolveWorkspaceDirectory(undefined, undefined);
    expect(result).toBe(resolve(tempWorkspace));
  });

  it("rejects '/' provided via OPENCODE_CURSOR_PROJECT_DIR", () => {
    process.env.OPENCODE_CURSOR_PROJECT_DIR = "/";
    process.chdir(tempWorkspace);
    const result = resolveWorkspaceDirectory(undefined, undefined);
    expect(result).toBe(resolve(tempWorkspace));
  });

  it("respects CURSOR_ACP_WORKSPACE when it is a real directory", () => {
    process.env.CURSOR_ACP_WORKSPACE = tempWorkspace;
    const result = resolveWorkspaceDirectory(undefined, undefined);
    expect(result).toBe(resolve(tempWorkspace));
  });

  it("skips paths inside the opencode config prefix", () => {
    const insideConfig = join(tempConfigHome, "opencode", "plugin");
    const result = resolveWorkspaceDirectory(insideConfig, insideConfig);
    expect(result).not.toBe(insideConfig);
  });
});
