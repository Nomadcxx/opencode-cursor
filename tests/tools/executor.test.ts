import { describe, it, expect } from "bun:test";
import { ToolExecutor } from "../../src/tools/executor.js";
import { ToolRegistry } from "../../src/tools/core/registry.js";

describe("ToolExecutor", () => {
  it("should execute registered tool", async () => {
    const registry = new ToolRegistry();
    registry.register({
      id: "echo",
      name: "echo",
      description: "Echo text",
      parameters: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"]
      },
      source: "local"
    }, async (args) => args.text);

    const executor = new ToolExecutor(registry);
    const result = await executor.execute("echo", { text: "hello" });

    expect(result).toBe("hello");
  });

  it("should parse tool call JSON", () => {
    const executor = new ToolExecutor(new ToolRegistry());
    const json = '{"tool": "bash", "arguments": {"command": "ls"}}';

    const result = executor.parseToolCall(json);
    expect(result.name).toBe("bash");
    expect(result.arguments).toEqual({ command: "ls" });
  });

  it("should throw error for non-existent tool", async () => {
    const registry = new ToolRegistry();
    const executor = new ToolExecutor(registry);

    expect(async () => {
      await executor.execute("nonexistent", {});
    }).toThrow();
  });

  it("should parse OpenAI-style tool call", () => {
    const executor = new ToolExecutor(new ToolRegistry());
    const json = '{"name": "bash", "arguments": "{\\"command\\": \\"ls\\"}"}';

    const result = executor.parseToolCall(json);
    expect(result.name).toBe("bash");
    expect(result.arguments).toEqual({ command: "ls" });
  });
});