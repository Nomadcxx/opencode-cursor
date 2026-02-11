import { describe, it, expect } from "bun:test";
import { CursorPlugin } from "../../src/plugin";
import type { PluginInput } from "@opencode-ai/plugin";

describe("Plugin tool hook", () => {
  it("should register default tools via tool hook", async () => {
    // Mock PluginInput
    const mockInput: PluginInput = {
      directory: "/test/dir",
      worktree: "/test/dir",
      serverUrl: new URL("http://localhost:8080"),
      client: {
        tool: {
          list: async () => [],
        },
      } as any,
      project: {} as any,
      $: {} as any,
    };

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
});
