import { describe, it, expect } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { CursorPlugin } from "../../src/plugin";
import type { PluginInput } from "@opencode-ai/plugin";

function createMockInput(directory: string): PluginInput {
  return {
    directory,
    worktree: directory,
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

function createToolContext(directory: string): any {
  return {
    sessionID: "test-session",
    messageID: "test-message",
    agent: "test-agent",
    directory,
    worktree: directory,
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
  };
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
    expect(toolNames).toContain("read");
    expect(toolNames).toContain("write");
    expect(toolNames).toContain("edit");
    expect(toolNames).toContain("grep");
    expect(toolNames).toContain("ls");
    expect(toolNames).toContain("glob");

    // Verify tool structure (each should have description, args, execute)
    const bashTool = hooks.tool?.bash;
    expect(bashTool).toBeDefined();
    expect(bashTool?.description).toBeDefined();
    expect(bashTool?.args).toBeDefined();
    expect(typeof bashTool?.execute).toBe("function");
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
        createToolContext(projectDir),
      );

      const expectedPath = join(projectDir, "nested/output.txt");
      expect(readFileSync(expectedPath, "utf-8")).toBe("hello from context");
      expect(out).toContain(expectedPath);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
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
        createToolContext(projectDir),
      );

      expect(realpathSync((out || "").trim())).toBe(realpathSync(projectDir));
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
