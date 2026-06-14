import { describe, it, expect } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, mkdirSync, existsSync, symlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { CursorPlugin } from "../../src/plugin";
import type { PluginInput } from "@opencode-ai/plugin";

function createMockInput(directory: string, worktree: string = directory): PluginInput {
  return {
    directory,
    worktree,
    serverUrl: new URL("http://localhost:8080"),
    client: {
      tool: {
        list: async () => [],
      },
    } as any,
    project: {} as any,
    $: {} as any,
  };
}

function createToolContext(directory: string, worktree?: string, sessionID = "test-session"): any {
  const context: any = {
    sessionID,
    messageID: "test-message",
    agent: "test-agent",
    directory,
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
  };
  if (worktree !== undefined) {
    context.worktree = worktree;
  }
  return context;
}

describe("Plugin tool hook", () => {
  it("should register default tools via tool hook", async () => {
    const mockInput = createMockInput("/test/dir");

    // Initialize plugin
    const hooks = await CursorPlugin(mockInput);

    // Verify tool hook exists
    expect(hooks.tool).toBeDefined();
    expect(typeof hooks.tool).toBe("object");

    // Verify default tools are registered
    const toolNames = Object.keys(hooks.tool || {});
    expect(toolNames).toContain("bash");
    expect(toolNames).toContain("shell");
    expect(toolNames).toContain("read");
    expect(toolNames).toContain("write");
    expect(toolNames).toContain("edit");
    expect(toolNames).toContain("oc_edit");
    expect(toolNames).toContain("oc_write");
    expect(toolNames).toContain("oc_read");
    expect(toolNames).not.toContain("grep");
    expect(toolNames).toContain("ls");
    expect(toolNames).toContain("glob");

    // Verify tool structure (each should have description, args, execute)
    const bashTool = hooks.tool?.bash;
    expect(bashTool).toBeDefined();
    expect(bashTool?.description).toBeDefined();
    expect(bashTool?.args).toBeDefined();
    expect(typeof bashTool?.execute).toBe("function");

    const shellTool = hooks.tool?.shell;
    expect(shellTool).toBeDefined();
    expect(shellTool?.description).toBeDefined();
    expect(shellTool?.args).toBeDefined();
    expect(typeof shellTool?.execute).toBe("function");
  });

  it("resolves relative write paths against context directory", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "plugin-hook-write-"));
    try {
      const hooks = await CursorPlugin(createMockInput(projectDir));
      const out = await hooks.tool?.write?.execute(
        {
          path: "nested/output.txt",
          content: "hello from context",
        },
        createToolContext(projectDir, projectDir),
      );

      const expectedPath = join(projectDir, "nested/output.txt");
      expect(readFileSync(expectedPath, "utf-8")).toBe("hello from context");
      expect(out).toContain(expectedPath);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("prefers worktree when context.directory is the OpenCode config dir", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "plugin-hook-worktree-"));
    const xdgConfigHome = mkdtempSync(join(tmpdir(), "plugin-hook-xdg-"));
    const prevXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = xdgConfigHome;
    try {
      const configDir = join(xdgConfigHome, "opencode");
      mkdirSync(configDir, { recursive: true });

      const hooks = await CursorPlugin(createMockInput(configDir, projectDir));
      const out = await hooks.tool?.write?.execute(
        { path: "nested/output.txt", content: "hello from worktree" },
        createToolContext(configDir, projectDir),
      );

      const expectedPath = join(projectDir, "nested/output.txt");
      expect(readFileSync(expectedPath, "utf-8")).toBe("hello from worktree");
      expect(out).toContain(expectedPath);
    } finally {
      if (prevXdg === undefined) {
        delete process.env.XDG_CONFIG_HOME;
      } else {
        process.env.XDG_CONFIG_HOME = prevXdg;
      }
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(xdgConfigHome, { recursive: true, force: true });
    }
  });

  it("defaults bash cwd to context directory", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "plugin-hook-bash-"));
    try {
      const hooks = await CursorPlugin(createMockInput(projectDir));
      const out = await hooks.tool?.bash?.execute(
        {
          command: "pwd",
        },
        createToolContext(projectDir, projectDir),
      );

      expect(realpathSync((out || "").trim())).toBe(realpathSync(projectDir));
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  }, 15000);

  it("executes shell alias and defaults cwd to context directory", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "plugin-hook-shell-"));
    try {
      const hooks = await CursorPlugin(createMockInput(projectDir));
      const out = await hooks.tool?.shell?.execute(
        {
          command: "pwd",
        },
        createToolContext(projectDir, projectDir),
      );

      expect(realpathSync((out || "").trim())).toBe(realpathSync(projectDir));
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("executes oc_bash alias and defaults cwd to context directory", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "plugin-hook-oc-bash-"));
    try {
      const hooks = await CursorPlugin(createMockInput(projectDir));
      const out = await hooks.tool?.oc_bash?.execute(
        {
          command: "pwd",
        },
        createToolContext(projectDir, projectDir),
      );

      expect(realpathSync((out || "").trim())).toBe(realpathSync(projectDir));
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  }, 15000);

  it("executes oc_edit alias the same as edit", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "plugin-hook-oc-edit-"));
    try {
      const target = join(projectDir, "file.txt");
      const hooks = await CursorPlugin(createMockInput(projectDir));
      const { writeFileSync } = await import("fs");
      writeFileSync(target, "hello world", "utf-8");

      const out = await hooks.tool?.oc_edit?.execute(
        { path: target, old_string: "hello", new_string: "hi" },
        createToolContext(projectDir, projectDir),
      );

      expect(readFileSync(target, "utf-8")).toBe("hi world");
      expect(out).toContain("edited successfully");
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("rejects oc_edit with empty old_string without overwriting existing files", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "plugin-hook-oc-edit-empty-old-"));
    try {
      const target = join(projectDir, "file.txt");
      const hooks = await CursorPlugin(createMockInput(projectDir));
      const { writeFileSync } = await import("fs");
      writeFileSync(target, "alpha\nbeta\ngamma\n", "utf-8");

      await expect(
        hooks.tool?.oc_edit?.execute(
          { path: target, old_string: "", new_string: "beta changed" },
          createToolContext(projectDir, projectDir),
        ),
      ).rejects.toThrow("old_string");

      expect(readFileSync(target, "utf-8")).toBe("alpha\nbeta\ngamma\n");
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("rejects oc_write partial overwrites of existing files", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "plugin-hook-oc-write-partial-"));
    try {
      const target = join(projectDir, "file.txt");
      const hooks = await CursorPlugin(createMockInput(projectDir));
      const { writeFileSync } = await import("fs");
      const original = Array.from({ length: 100 }, (_, index) => String(index + 1)).join("\n") + "\n";
      writeFileSync(target, original, "utf-8");

      await expect(
        hooks.tool?.oc_write?.execute(
          { path: target, content: "test test" },
          createToolContext(projectDir, projectDir),
        ),
      ).rejects.toThrow("refusing suspicious partial overwrite");

      expect(readFileSync(target, "utf-8")).toBe(original);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("rejects malformed edit full-file payloads that look like partial overwrites", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "plugin-hook-edit-streamcontent-partial-"));
    try {
      const target = join(projectDir, "file.txt");
      const hooks = await CursorPlugin(createMockInput(projectDir));
      const { writeFileSync } = await import("fs");
      const original = Array.from({ length: 100 }, (_, index) => String(index + 1)).join("\n") + "\n";
      writeFileSync(target, original, "utf-8");

      await expect(
        hooks.tool?.edit?.execute(
          { path: target, streamContent: "test test" },
          createToolContext(projectDir, projectDir),
        ),
      ).rejects.toThrow("refusing suspicious partial overwrite");

      expect(readFileSync(target, "utf-8")).toBe(original);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("pins non-config workspace per session and reuses it when later context loses worktree", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "plugin-hook-session-pin-project-"));
    const xdgConfigHome = mkdtempSync(join(tmpdir(), "plugin-hook-session-pin-xdg-"));
    const unexpectedDir = mkdtempSync(join(tmpdir(), "plugin-hook-session-pin-unexpected-"));
    const prevXdg = process.env.XDG_CONFIG_HOME;

    try {
      process.env.XDG_CONFIG_HOME = xdgConfigHome;
      const configDir = join(xdgConfigHome, "opencode");
      mkdirSync(configDir, { recursive: true });

      const hooks = await CursorPlugin(createMockInput(configDir, configDir));

      const out1 = await hooks.tool?.write?.execute(
        { path: "nested/first.txt", content: "first" },
        createToolContext(configDir, projectDir, "session-pin-1"),
      );
      const out2 = await hooks.tool?.write?.execute(
        { path: "nested/second.txt", content: "second" },
        createToolContext(configDir, undefined, "session-pin-1"),
      );

      const expectedFirstPath = join(projectDir, "nested/first.txt");
      const expectedSecondPath = join(projectDir, "nested/second.txt");
      const unexpectedPath = join(unexpectedDir, "nested/second.txt");

      expect(readFileSync(expectedFirstPath, "utf-8")).toBe("first");
      expect(readFileSync(expectedSecondPath, "utf-8")).toBe("second");
      expect(out1).toContain(expectedFirstPath);
      expect(out2).toContain(expectedSecondPath);
      expect(existsSync(unexpectedPath)).toBe(false);
    } finally {
      if (prevXdg === undefined) {
        delete process.env.XDG_CONFIG_HOME;
      } else {
        process.env.XDG_CONFIG_HOME = prevXdg;
      }
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(xdgConfigHome, { recursive: true, force: true });
      rmSync(unexpectedDir, { recursive: true, force: true });
    }
  });

  it("treats config path aliases (symlink/case variants) as config and falls back to workspace", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "plugin-hook-config-alias-project-"));
    const xdgConfigHome = mkdtempSync(join(tmpdir(), "plugin-hook-config-alias-xdg-"));
    const aliasParentDir = mkdtempSync(join(tmpdir(), "plugin-hook-config-alias-parent-"));
    const aliasXdgHome = join(aliasParentDir, "xdg-home-alias");
    const prevXdg = process.env.XDG_CONFIG_HOME;

    try {
      process.env.XDG_CONFIG_HOME = xdgConfigHome;
      symlinkSync(xdgConfigHome, aliasXdgHome);

      const configDir = join(xdgConfigHome, "opencode");
      mkdirSync(configDir, { recursive: true });

      const aliasConfigDir = join(aliasXdgHome, "opencode");
      const filename = `symlink-alias-${Date.now()}.txt`;

      const hooks = await CursorPlugin(createMockInput(configDir, projectDir));
      const out = await hooks.tool?.write?.execute(
        { path: `nested/${filename}`, content: "alias fallback" },
        createToolContext(aliasConfigDir, undefined, "session-alias-1"),
      );

      const expectedPath = join(projectDir, `nested/${filename}`);
      const unexpectedPath = join(configDir, `nested/${filename}`);

      expect(readFileSync(expectedPath, "utf-8")).toBe("alias fallback");
      expect(out).toContain(expectedPath);
      expect(existsSync(unexpectedPath)).toBe(false);
    } finally {
      if (prevXdg === undefined) {
        delete process.env.XDG_CONFIG_HOME;
      } else {
        process.env.XDG_CONFIG_HOME = prevXdg;
      }
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(xdgConfigHome, { recursive: true, force: true });
      rmSync(aliasParentDir, { recursive: true, force: true });
    }
  });
});
