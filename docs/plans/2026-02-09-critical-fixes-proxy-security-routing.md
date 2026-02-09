# Critical Fixes: Proxy, Security & Tool Routing

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix command injection in grep/glob tools, wire up the proxy prompt builder for tool message handling, fix tool routing bugs (SdkExecutor, env var inconsistency, MCP source filter), add CI/CD, and add SdkExecutor tests.

**Architecture:** Replace shell-interpolated `exec()` with `execFile()` to eliminate injection. Replace inline message-to-prompt conversion in both proxy handlers with the existing `buildPromptFromMessages()` function. Fix executor `canExecute()` to use toolId-based gating. Unify env var parsing to a single constant.

**Tech Stack:** TypeScript, bun:test, Node.js `child_process.execFile`, GitHub Actions

---

### Task 1: Fix command injection in grep and glob tools

**Files:**
- Modify: `src/tools/defaults.ts:203-222` (grep handler)
- Modify: `src/tools/defaults.ts:280-298` (glob handler)
- Test: `tests/tools/defaults.test.ts`

**Step 1: Write failing tests for injection-safe grep and glob**

In `tests/tools/defaults.test.ts`, add these tests at the end of the `describe` block:

```typescript
  it("should execute grep tool safely with special characters in pattern", async () => {
    const registry = new ToolRegistry();
    registerDefaultTools(registry);
    const executor = new LocalExecutor(registry);

    const fs = await import("fs");
    const tmpFile = `/tmp/test-grep-${Date.now()}.txt`;
    fs.writeFileSync(tmpFile, "hello world\nfoo bar\n", "utf-8");

    const result = await executeWithChain([executor], "grep", {
      pattern: "hello",
      path: tmpFile
    });

    expect(result.status).toBe("success");
    expect(result.output).toContain("hello world");

    fs.unlinkSync(tmpFile);
  });

  it("should execute glob tool safely", async () => {
    const registry = new ToolRegistry();
    registerDefaultTools(registry);
    const executor = new LocalExecutor(registry);

    const result = await executeWithChain([executor], "glob", {
      pattern: "*.ts",
      path: "src/tools"
    });

    expect(result.status).toBe("success");
    expect(result.output).toContain(".ts");
  });
```

**Step 2: Run tests to verify they pass (baseline)**

Run: `bun test tests/tools/defaults.test.ts`
Expected: ALL PASS (tests work with current implementation too)

**Step 3: Rewrite grep handler to use execFile**

In `src/tools/defaults.ts`, replace the grep handler body (lines 203-222). Change from `exec()` with string interpolation to `execFile()` with argument array:

Replace this entire handler callback:
```typescript
  }, async (args) => {
    const { exec } = await import("child_process");
    const { promisify } = await import("util");
    const execAsync = promisify(exec);

    try {
      const pattern = args.pattern as string;
      const path = args.path as string;
      const include = args.include as string | undefined;
      const includeFlag = include ? `--include="${include}"` : "";
      const { stdout } = await execAsync(
        `grep -r ${includeFlag} -n "${pattern}" "${path}" 2>/dev/null || true`,
        { timeout: 30000 }
      );

      return stdout || "No matches found";
    } catch (error: any) {
      throw error;
    }
  });
```

With:
```typescript
  }, async (args) => {
    const { execFile } = await import("child_process");
    const { promisify } = await import("util");
    const execFileAsync = promisify(execFile);

    const pattern = args.pattern as string;
    const path = args.path as string;
    const include = args.include as string | undefined;

    const grepArgs = ["-r", "-n"];
    if (include) {
      grepArgs.push(`--include=${include}`);
    }
    grepArgs.push(pattern, path);

    try {
      const { stdout } = await execFileAsync("grep", grepArgs, { timeout: 30000 });
      return stdout || "No matches found";
    } catch (error: any) {
      // grep exits with code 1 when no matches found — not an error
      if (error.code === 1) {
        return "No matches found";
      }
      throw error;
    }
  });
```

**Step 4: Rewrite glob handler to use execFile**

In `src/tools/defaults.ts`, replace the glob handler body (lines 280-298). Change from `exec()` with string interpolation to `execFile()` with argument array:

Replace this entire handler callback:
```typescript
  }, async (args) => {
    const { exec } = await import("child_process");
    const { promisify } = await import("util");
    const execAsync = promisify(exec);

    try {
      const pattern = args.pattern as string;
      const path = args.path as string | undefined;
      const cwd = path || ".";
      const { stdout } = await execAsync(
        `find "${cwd}" -type f -name "${pattern}" 2>/dev/null | head -50`,
        { timeout: 30000 }
      );

      return stdout || "No files found";
    } catch (error: any) {
      throw error;
    }
  });
```

With:
```typescript
  }, async (args) => {
    const { execFile } = await import("child_process");
    const { promisify } = await import("util");
    const execFileAsync = promisify(execFile);

    const pattern = args.pattern as string;
    const path = args.path as string | undefined;
    const cwd = path || ".";

    try {
      const { stdout } = await execFileAsync(
        "find", [cwd, "-type", "f", "-name", pattern],
        { timeout: 30000 }
      );
      // Limit output to 50 lines (replaces piped `| head -50`)
      const lines = (stdout || "").split("\n").filter(Boolean);
      return lines.slice(0, 50).join("\n") || "No files found";
    } catch (error: any) {
      throw error;
    }
  });
```

**Step 5: Run tests**

Run: `bun test tests/tools/defaults.test.ts`
Expected: ALL PASS

**Step 6: Commit**

```bash
git add src/tools/defaults.ts tests/tools/defaults.test.ts
git commit -m "fix: eliminate command injection in grep and glob tools using execFile"
```

---

### Task 2: Wire up prompt builder for proxy handlers

**Files:**
- Modify: `src/plugin.ts:209-231` (Bun handler message conversion)
- Modify: `src/plugin.ts:491-513` (Node.js handler message conversion)
- Reference: `src/proxy/prompt-builder.ts` (already tested, already handles role:tool and body.tools)
- Test: `tests/unit/proxy/prompt-builder.test.ts` (already exists with 9 tests)

**Step 1: Add import for buildPromptFromMessages**

At the top of `src/plugin.ts`, add after the existing imports (around line 14):

```typescript
import { buildPromptFromMessages } from "./proxy/prompt-builder.js";
```

**Step 2: Replace Bun handler message conversion (lines 209-231)**

Find the block (inside the Bun `handler` function):
```typescript
      // Convert messages to prompt
      const lines: string[] = [];
      for (const message of messages) {
        const role = typeof message.role === "string" ? message.role : "user";
        const content = message.content;

        if (typeof content === "string") {
          lines.push(`${role.toUpperCase()}: ${content}`);
        } else if (Array.isArray(content)) {
          const textParts = content
            .map((part: any) => {
              if (part && typeof part === "object" && part.type === "text" && typeof part.text === "string") {
                return part.text;
              }
              return "";
            })
            .filter(Boolean);
          if (textParts.length) {
            lines.push(`${role.toUpperCase()}: ${textParts.join("\n")}`);
          }
        }
      }
      const prompt = lines.join("\n\n");
```

Replace with:
```typescript
      const prompt = buildPromptFromMessages(messages, tools);
```

**Step 3: Replace Node.js handler message conversion (lines 491-513)**

Find the identical block (inside the Node.js `requestHandler` function):
```typescript
      // Convert messages to prompt
      const lines: string[] = [];
      for (const message of messages) {
        const role = typeof message.role === "string" ? message.role : "user";
        const content = message.content;

        if (typeof content === "string") {
          lines.push(`${role.toUpperCase()}: ${content}`);
        } else if (Array.isArray(content)) {
          const textParts = content
            .map((part: any) => {
              if (part && typeof part === "object" && part.type === "text" && typeof part.text === "string") {
                return part.text;
              }
              return "";
            })
            .filter(Boolean);
          if (textParts.length) {
            lines.push(`${role.toUpperCase()}: ${textParts.join("\n")}`);
          }
        }
      }
      const prompt = lines.join("\n\n");
```

Replace with:
```typescript
      const prompt = buildPromptFromMessages(messages, tools);
```

Note: The Node.js handler also needs `tools` extracted. Find this line (around line 489):
```typescript
      const stream = bodyData?.stream === true;
```
Add after it:
```typescript
      const tools = Array.isArray(bodyData?.tools) ? bodyData.tools : [];
```

**Step 4: Run prompt builder tests to confirm they still pass**

Run: `bun test tests/unit/proxy/prompt-builder.test.ts`
Expected: ALL 9 PASS

**Step 5: Run full test suite**

Run: `bun test tests/tools/defaults.test.ts tests/tools/executor-chain.test.ts tests/integration/comprehensive.test.ts tests/unit/plugin.test.ts`
Expected: ALL PASS

**Step 6: Commit**

```bash
git add src/plugin.ts
git commit -m "fix: use prompt builder for tool message handling in proxy"
```

---

### Task 3: Fix SdkExecutor, env var, and MCP source filter

**Files:**
- Modify: `src/tools/executors/sdk.ts:6-11`
- Modify: `src/plugin.ts:52,841,885-889`
- Create: `tests/tools/sdk-executor.test.ts`

**Step 1: Write SdkExecutor tests**

Create `tests/tools/sdk-executor.test.ts`:

```typescript
import { describe, it, expect } from "bun:test";
import { SdkExecutor } from "../../src/tools/executors/sdk.js";

describe("SdkExecutor", () => {
  it("should return false for canExecute when no client", () => {
    const exec = new SdkExecutor(null, 5000);
    expect(exec.canExecute("any-tool")).toBe(false);
  });

  it("should return false for canExecute when client lacks tool.invoke", () => {
    const exec = new SdkExecutor({}, 5000);
    expect(exec.canExecute("any-tool")).toBe(false);
  });

  it("should return false for canExecute when toolId not registered", () => {
    const client = { tool: { invoke: async () => "ok" } };
    const exec = new SdkExecutor(client, 5000);
    // No tool IDs set — should reject
    expect(exec.canExecute("unknown-tool")).toBe(false);
  });

  it("should return true for canExecute when toolId is registered", () => {
    const client = { tool: { invoke: async () => "ok" } };
    const exec = new SdkExecutor(client, 5000);
    exec.setToolIds(["my-tool", "other-tool"]);
    expect(exec.canExecute("my-tool")).toBe(true);
    expect(exec.canExecute("other-tool")).toBe(true);
    expect(exec.canExecute("nope")).toBe(false);
  });

  it("should execute and return string output", async () => {
    const client = { tool: { invoke: async (_id: string, _args: any) => "hello world" } };
    const exec = new SdkExecutor(client, 5000);
    exec.setToolIds(["test-tool"]);

    const result = await exec.execute("test-tool", {});
    expect(result.status).toBe("success");
    expect(result.output).toBe("hello world");
  });

  it("should JSON-stringify non-string output", async () => {
    const client = { tool: { invoke: async () => ({ key: "value" }) } };
    const exec = new SdkExecutor(client, 5000);
    exec.setToolIds(["test-tool"]);

    const result = await exec.execute("test-tool", {});
    expect(result.status).toBe("success");
    expect(result.output).toBe('{"key":"value"}');
  });

  it("should return error when invoke throws", async () => {
    const client = { tool: { invoke: async () => { throw new Error("sdk failure"); } } };
    const exec = new SdkExecutor(client, 5000);
    exec.setToolIds(["test-tool"]);

    const result = await exec.execute("test-tool", {});
    expect(result.status).toBe("error");
    expect(result.error).toContain("sdk failure");
  });

  it("should return error on timeout", async () => {
    const client = {
      tool: {
        invoke: async () => new Promise((resolve) => setTimeout(() => resolve("late"), 10000))
      }
    };
    const exec = new SdkExecutor(client, 50); // 50ms timeout
    exec.setToolIds(["test-tool"]);

    const result = await exec.execute("test-tool", {});
    expect(result.status).toBe("error");
    expect(result.error).toContain("timeout");
  });

  it("should return error when canExecute is false", async () => {
    const exec = new SdkExecutor(null, 5000);
    const result = await exec.execute("any-tool", {});
    expect(result.status).toBe("error");
    expect(result.error).toContain("unavailable");
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test tests/tools/sdk-executor.test.ts`
Expected: FAIL — `setToolIds` doesn't exist on SdkExecutor yet, and `canExecute` doesn't accept toolId

**Step 3: Add `setToolIds` and toolId-aware `canExecute` to SdkExecutor**

Replace the full content of `src/tools/executors/sdk.ts` with:

```typescript
import type { IToolExecutor, ExecutionResult } from "../core/types.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("tools:executor:sdk");

export class SdkExecutor implements IToolExecutor {
  private toolIds = new Set<string>();

  constructor(private client: any, private timeoutMs: number) {}

  setToolIds(ids: Iterable<string>): void {
    this.toolIds = new Set(ids);
  }

  canExecute(toolId: string): boolean {
    return this.toolIds.has(toolId) && Boolean(this.client?.tool?.invoke);
  }

  async execute(toolId: string, args: Record<string, unknown>): Promise<ExecutionResult> {
    if (!this.canExecute(toolId)) return { status: "error", error: "SDK invoke unavailable" };
    try {
      const p = this.client.tool.invoke(toolId, args);
      const res = await this.runWithTimeout(p);
      const out = typeof res === "string" ? res : JSON.stringify(res);
      return { status: "success", output: out };
    } catch (err: any) {
      log.warn("SDK tool execution failed", { toolId, error: String(err?.message || err) });
      return { status: "error", error: String(err?.message || err) };
    }
  }

  private async runWithTimeout<T>(p: Promise<T>): Promise<T> {
    if (!this.timeoutMs) return p;
    return await Promise.race([
      p,
      new Promise<T>((_, reject) => setTimeout(() => reject(new Error("tool execution timeout")), this.timeoutMs)),
    ]);
  }
}
```

**Step 4: Fix env var inconsistency and MCP source filter in plugin.ts**

In `src/plugin.ts`, make these three changes:

**Change 1:** Remove the local `forwardToolCalls` variable (line 841). Change:
```typescript
  const forwardToolCalls = process.env.CURSOR_ACP_FORWARD_TOOL_CALLS !== "false"; // default ON
```
To:
```typescript
  // forwardToolCalls uses the module-level FORWARD_TOOL_CALLS constant (line 52)
```

Then find all 4 occurrences of `toolRouter && forwardToolCalls` (around lines 342, 603, 639, and any other) and change to `toolRouter && FORWARD_TOOL_CALLS`:
```typescript
if (toolRouter && FORWARD_TOOL_CALLS) {
```

**Change 2:** Fix the MCP/SDK source filter (lines 885-889). Replace:
```typescript
    // Populate MCP executor with discovered SDK tool IDs
    if (mcpExec) {
      const sdkToolIds = list.filter((t) => t.source === "sdk").map((t) => t.id);
      mcpExec.setToolIds(sdkToolIds);
    }
```
With:
```typescript
    // Populate executors with their respective tool IDs
    if (sdkExec) {
      sdkExec.setToolIds(list.filter((t) => t.source === "sdk").map((t) => t.id));
    }
    if (mcpExec) {
      mcpExec.setToolIds(list.filter((t) => t.source === "mcp").map((t) => t.id));
    }
```

**Step 5: Run all tests**

Run: `bun test tests/tools/sdk-executor.test.ts tests/tools/executor-chain.test.ts tests/tools/defaults.test.ts tests/integration/comprehensive.test.ts`
Expected: ALL PASS

**Step 6: Commit**

```bash
git add src/tools/executors/sdk.ts src/plugin.ts tests/tools/sdk-executor.test.ts
git commit -m "fix: SdkExecutor toolId gating, env var consistency, MCP source filter"
```

---

### Task 4: Add CI/CD pipeline

**Files:**
- Create: `.github/workflows/ci.yml`

**Step 1: Create the workflow file**

Create `.github/workflows/ci.yml`:

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest

      - run: bun install

      - run: bun run build

      - name: Run tests
        run: |
          bun test \
            tests/tools/defaults.test.ts \
            tests/tools/executor-chain.test.ts \
            tests/tools/sdk-executor.test.ts \
            tests/tools/mcp-executor.test.ts \
            tests/tools/skills.test.ts \
            tests/tools/registry.test.ts \
            tests/integration/comprehensive.test.ts \
            tests/integration/tools-router.integration.test.ts \
            tests/unit/proxy/prompt-builder.test.ts \
            tests/unit/plugin.test.ts \
            tests/unit/plugin-tools-hook.test.ts \
            tests/unit/plugin-config.test.ts \
            tests/unit/auth.test.ts \
            tests/unit/streaming/line-buffer.test.ts \
            tests/unit/streaming/parser.test.ts \
            tests/unit/streaming/types.test.ts \
            tests/unit/streaming/delta-tracker.test.ts \
            tests/competitive/edge.test.ts
```

Note: Tests are listed explicitly to avoid picking up `temp_repo/` files. The streaming openai-sse tests are excluded because they have pre-existing failures (fixture mismatch with `timestamp_ms` — separate fix).

**Step 2: Verify the workflow file is valid YAML**

Run: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/ci.yml'))"`
Expected: No output (valid YAML)

**Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: add GitHub Actions workflow for testing"
```

---

## Verification

After all tasks are complete, run the full test suite to verify nothing is broken:

```bash
bun test \
  tests/tools/defaults.test.ts \
  tests/tools/executor-chain.test.ts \
  tests/tools/sdk-executor.test.ts \
  tests/tools/mcp-executor.test.ts \
  tests/tools/skills.test.ts \
  tests/tools/registry.test.ts \
  tests/integration/comprehensive.test.ts \
  tests/integration/tools-router.integration.test.ts \
  tests/unit/proxy/prompt-builder.test.ts \
  tests/unit/plugin.test.ts \
  tests/unit/plugin-tools-hook.test.ts \
  tests/competitive/edge.test.ts
```

Expected: ALL PASS

Then verify with debug logging:
```bash
CURSOR_ACP_LOG_LEVEL=debug bun test tests/tools/sdk-executor.test.ts 2>&1 | grep "tools:executor:sdk"
```
