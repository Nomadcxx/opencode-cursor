// tests/tools/executor-chain.test.ts
import { describe, it, expect } from "bun:test";
import { executeWithChain } from "../../src/tools/core/executor.js";
import { LocalExecutor } from "../../src/tools/executors/local.js";
import { ToolRegistry } from "../../src/tools/core/registry.js";
import { registerDefaultTools } from "../../src/tools/defaults.js";
import type { IToolExecutor, ExecutionResult } from "../../src/tools/core/types.js";

describe("executeWithChain", () => {
  it("should use LocalExecutor for registered tools", async () => {
    const registry = new ToolRegistry();
    registerDefaultTools(registry);
    const chain: IToolExecutor[] = [new LocalExecutor(registry)];

    const result = await executeWithChain(chain, "ls", { path: "." });
    expect(result.status).toBe("success");
    expect(result.output).toBeDefined();
  });

  it("should return error when no executor handles the tool", async () => {
    const chain: IToolExecutor[] = [];
    const result = await executeWithChain(chain, "nonexistent", {});
    expect(result.status).toBe("error");
    expect(result.error).toContain("No executor");
  });

  it("should try executors in order and use first match", async () => {
    const calls: string[] = [];
    const first: IToolExecutor = {
      canExecute: () => { calls.push("first.can"); return false; },
      execute: async () => { calls.push("first.exec"); return { status: "success", output: "first" }; },
    };
    const second: IToolExecutor = {
      canExecute: () => { calls.push("second.can"); return true; },
      execute: async () => { calls.push("second.exec"); return { status: "success", output: "second" }; },
    };

    const result = await executeWithChain([first, second], "any", {});
    expect(result.output).toBe("second");
    expect(calls).toEqual(["first.can", "second.can", "second.exec"]);
  });
});
