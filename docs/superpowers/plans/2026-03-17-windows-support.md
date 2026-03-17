# Windows Support + Multi-Instance Workspace Fix — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add proper Windows platform support by cherry-picking the useful parts of PR #52 and rewriting the broken parts correctly, crediting the original contributor.

**Architecture:** Five independent tasks committed separately. Binary resolution is extracted into `src/utils/binary.ts` with dependency injection for testability. Windows path comparison is fixed with a one-line change to `canonicalizePathForCompare`. Node fallback grep/glob are rewritten from scratch and exported for direct testing.

**Tech Stack:** TypeScript, Bun, Node.js child_process, bun:test

**Spec:** `docs/superpowers/specs/2026-03-17-windows-support-design.md`

**Credit:** All commits include `Co-authored-by: Finn Birich <intisy@users.noreply.github.com>`

---

## File Structure

| File | Action | Purpose |
|------|--------|---------|
| `src/utils/binary.ts` | **Create** | `resolveCursorAgentBinary(deps?)` — centralised cursor-agent path resolution |
| `tests/unit/utils/binary.test.ts` | **Create** | 9 cases covering all resolution branches |
| `src/plugin.ts` | **Modify** | `canonicalizePathForCompare` win32 lowercase; import binary; `execSync`→`execFileSync`; Node spawn shell flag |
| `src/auth.ts` | **Modify** | Import binary; add shell flag to spawn |
| `src/client/simple.ts` | **Modify** | Import binary; add shell flag to both spawns |
| `src/cli/opencode-cursor.ts` | **Modify** | Import binary; fix `checkCursorAgent()` to call once |
| `src/cli/model-discovery.ts` | **Modify** | Import binary; make `killSignal` platform-conditional |
| `src/models/discovery.ts` | **Modify** | Import binary; update Bun.spawn binary arg |
| `src/tools/executors/cli.ts` | **Modify** | Add shell flag to opencode spawn |
| `src/tools/defaults.ts` | **Modify** | Add `nodeFallbackGrep`/`nodeFallbackGlob` (exported, rewritten); add win32 guards |
| `tests/tools/node-fallbacks.test.ts` | **Create** | 12 cases for both fallback functions |
| `tests/unit/plugin-proxy-reuse.test.ts` | **Modify** | Add 3 Windows path comparison cases |
| `src/plugin-toggle.ts` | **Modify** | Add provider-based detection (from PR) |
| `tests/unit/plugin-toggle.test.ts` | **Modify** | Add 2 cases for new provider branch |
| `package.json` | **Modify** | Revert `"type"` to `"module"`, fix `prepublishOnly` |
| `README.md` | **Modify** | Add Windows badge, PowerShell install, update table, fix EOF newline |

---

## Chunk 1: Binary resolution + spawn fixes

### Task 1: Binary resolution module

**Files:**
- Create: `src/utils/binary.ts`
- Create: `tests/unit/utils/binary.test.ts`

- [ ] **Step 1: Create `tests/unit/utils/binary.test.ts` with all 9 failing tests**

```typescript
// tests/unit/utils/binary.test.ts
import { describe, test, expect } from "bun:test";
import { resolveCursorAgentBinary } from "../../../src/utils/binary.js";

const neverExists = () => false;

describe("resolveCursorAgentBinary", () => {
  test("env override takes priority and skips filesystem checks", () => {
    const result = resolveCursorAgentBinary({
      env: { CURSOR_AGENT_EXECUTABLE: "/custom/cursor-agent" },
      existsSync: neverExists,
    });
    expect(result).toBe("/custom/cursor-agent");
  });

  test("empty env override falls through to platform logic", () => {
    const result = resolveCursorAgentBinary({
      platform: "linux",
      env: { CURSOR_AGENT_EXECUTABLE: "" },
      existsSync: neverExists,
      homedir: () => "/home/user",
    });
    expect(result).toBe("cursor-agent");
  });

  test("win32: known path exists -> returns full .cmd path", () => {
    const result = resolveCursorAgentBinary({
      platform: "win32",
      env: { LOCALAPPDATA: "C:\\Users\\user\\AppData\\Local" },
      existsSync: (p) => p.endsWith("cursor-agent.cmd"),
      homedir: () => "C:\\Users\\user",
    });
    expect(result).toBe("C:\\Users\\user\\AppData\\Local\\cursor-agent\\cursor-agent.cmd");
  });

  test("win32: known path missing -> falls back to bare cursor-agent.cmd", () => {
    const result = resolveCursorAgentBinary({
      platform: "win32",
      env: { LOCALAPPDATA: "C:\\Users\\user\\AppData\\Local" },
      existsSync: neverExists,
      homedir: () => "C:\\Users\\user",
    });
    expect(result).toBe("cursor-agent.cmd");
  });

  test("win32: LOCALAPPDATA missing -> constructs from homedir, falls back to bare", () => {
    const result = resolveCursorAgentBinary({
      platform: "win32",
      env: {},
      existsSync: neverExists,
      homedir: () => "C:\\Users\\user",
    });
    expect(result).toBe("cursor-agent.cmd");
  });

  test("linux: first known path exists -> returns ~/.cursor-agent path", () => {
    const result = resolveCursorAgentBinary({
      platform: "linux",
      env: {},
      existsSync: (p) => p.includes(".cursor-agent"),
      homedir: () => "/home/user",
    });
    expect(result).toBe("/home/user/.cursor-agent/cursor-agent");
  });

  test("linux: first missing, second exists -> returns /usr/local/bin path", () => {
    const result = resolveCursorAgentBinary({
      platform: "linux",
      env: {},
      existsSync: (p) => p === "/usr/local/bin/cursor-agent",
      homedir: () => "/home/user",
    });
    expect(result).toBe("/usr/local/bin/cursor-agent");
  });

  test("linux: neither path exists -> falls back to bare cursor-agent", () => {
    const result = resolveCursorAgentBinary({
      platform: "linux",
      env: {},
      existsSync: neverExists,
      homedir: () => "/home/user",
    });
    expect(result).toBe("cursor-agent");
  });

  test("darwin: neither path exists -> falls back to cursor-agent (not .cmd)", () => {
    const result = resolveCursorAgentBinary({
      platform: "darwin",
      env: {},
      existsSync: neverExists,
      homedir: () => "/Users/user",
    });
    expect(result).toBe("cursor-agent");
  });
});
```

- [ ] **Step 2: Run tests to verify they all fail (module not found)**

```bash
cd /home/nomadx/opencode-cursor
bun test tests/unit/utils/binary.test.ts 2>&1 | head -20
```

Expected: `Cannot find module '../../../src/utils/binary.js'`

- [ ] **Step 3: Create `src/utils/binary.ts`**

```typescript
// src/utils/binary.ts
import { existsSync as fsExistsSync } from "fs";
import { join } from "path";
import { homedir as osHomedir } from "os";
import { createLogger } from "./logger.js";

const log = createLogger("binary");

export type BinaryDeps = {
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  existsSync?: (path: string) => boolean;
  homedir?: () => string;
};

export function resolveCursorAgentBinary(deps: BinaryDeps = {}): string {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const checkExists = deps.existsSync ?? fsExistsSync;
  const home = (deps.homedir ?? osHomedir)();

  const envOverride = env.CURSOR_AGENT_EXECUTABLE;
  if (envOverride && envOverride.length > 0) {
    return envOverride;
  }

  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA ?? join(home, "AppData", "Local");
    const knownPath = join(localAppData, "cursor-agent", "cursor-agent.cmd");
    if (checkExists(knownPath)) {
      return knownPath;
    }
    log.warn("cursor-agent not found at known Windows path, falling back to PATH", { checkedPath: knownPath });
    return "cursor-agent.cmd";
  }

  const knownPaths = [
    join(home, ".cursor-agent", "cursor-agent"),
    "/usr/local/bin/cursor-agent",
  ];
  for (const p of knownPaths) {
    if (checkExists(p)) {
      return p;
    }
  }

  log.warn("cursor-agent not found at known paths, falling back to PATH", { checkedPaths: knownPaths });
  return "cursor-agent";
}
```

- [ ] **Step 4: Run tests to verify all 9 pass**

```bash
bun test tests/unit/utils/binary.test.ts
```

Expected: `9 pass, 0 fail`

- [ ] **Step 5: Run full unit test suite to confirm no regressions**

```bash
bun test tests/unit/ 2>&1 | tail -5
```

Expected: all existing tests still pass

- [ ] **Step 6: Commit**

```bash
git add src/utils/binary.ts tests/unit/utils/binary.test.ts
git commit -m "feat: add resolveCursorAgentBinary for cross-platform binary resolution"
```

---

### Task 2: Windows spawn compatibility + execFileSync fix

**Files:**
- Modify: `src/auth.ts`
- Modify: `src/client/simple.ts`
- Modify: `src/cli/opencode-cursor.ts`
- Modify: `src/cli/model-discovery.ts`
- Modify: `src/models/discovery.ts`
- Modify: `src/tools/executors/cli.ts`
- Modify: `src/plugin.ts` (Node spawn + execSync→execFileSync + Bun.spawn binary)

> **Context:** `Bun.spawn()` (used in `src/plugin.ts` lines ~573 and ~681, and `src/models/discovery.ts`) has a different API from Node's `spawn()` and handles `.cmd` files natively on Windows. Only Node `spawn()` calls need `shell: process.platform === "win32"`. Do NOT add `shell` to Bun.spawn calls.

- [ ] **Step 1: Update `src/auth.ts`**

At line 4, add import:
```typescript
import { resolveCursorAgentBinary } from "./utils/binary.js";
```

At line 78, change:
```typescript
// Before:
const proc = spawn("cursor-agent", ["login"], {
  stdio: ["pipe", "pipe", "pipe"],
});

// After:
const proc = spawn(resolveCursorAgentBinary(), ["login"], {
  stdio: ["pipe", "pipe", "pipe"],
  shell: process.platform === "win32",
});
```

- [ ] **Step 2: Update `src/client/simple.ts`**

Add import at top (near other imports):
```typescript
import { resolveCursorAgentBinary } from '../utils/binary.js';
```

In the constructor config default, change:
```typescript
// Before:
cursorAgentPath: process.env.CURSOR_AGENT_EXECUTABLE || 'cursor-agent',

// After:
cursorAgentPath: resolveCursorAgentBinary(),
```

At line ~79 (`executePromptStream` spawn):
```typescript
// Before:
const child = spawn(this.config.cursorAgentPath, args, {
  cwd,
  stdio: ['pipe', 'pipe', 'pipe']
});

// After:
const child = spawn(this.config.cursorAgentPath, args, {
  cwd,
  stdio: ['pipe', 'pipe', 'pipe'],
  shell: process.platform === 'win32',
});
```

At line ~190 (`executePrompt` spawn):
```typescript
// Before:
const child = spawn(this.config.cursorAgentPath, args, {
  cwd,
  stdio: ['pipe', 'pipe', 'pipe']
});

// After:
const child = spawn(this.config.cursorAgentPath, args, {
  cwd,
  stdio: ['pipe', 'pipe', 'pipe'],
  shell: process.platform === 'win32',
});
```

- [ ] **Step 3: Update `src/cli/opencode-cursor.ts`**

Add import (near other imports at top):
```typescript
import { resolveCursorAgentBinary } from "../utils/binary.js";
```

Replace the entire `checkCursorAgent()` function:
```typescript
export function checkCursorAgent(): CheckResult {
  const binary = resolveCursorAgentBinary();
  try {
    const output = execFileSync(binary, ["--version"], { encoding: "utf8" }).trim();
    const version = output.split("\n")[0] || "installed";
    return { name: "cursor-agent", passed: true, message: version };
  } catch {
    return {
      name: "cursor-agent",
      passed: false,
      message: "not found - install with: curl -fsS https://cursor.com/install | bash",
    };
  }
}
```

Also update `checkCursorAgentLogin()` at line ~89:
```typescript
// Before:
execFileSync("cursor-agent", ["models"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

// After:
execFileSync(resolveCursorAgentBinary(), ["models"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
```

- [ ] **Step 4: Update `src/cli/model-discovery.ts`**

Add import:
```typescript
import { resolveCursorAgentBinary } from "../utils/binary.js";
```

Update the `execFileSync` call in `discoverModelsFromCursorAgent()`:
```typescript
// Before:
const raw = execFileSync("cursor-agent", ["models"], {
  encoding: "utf8",
  killSignal: "SIGTERM",
  stdio: ["ignore", "pipe", "pipe"],
  timeout: MODEL_DISCOVERY_TIMEOUT_MS,
});

// After:
const raw = execFileSync(resolveCursorAgentBinary(), ["models"], {
  encoding: "utf8",
  ...(process.platform !== "win32" && { killSignal: "SIGTERM" as const }),
  stdio: ["ignore", "pipe", "pipe"],
  timeout: MODEL_DISCOVERY_TIMEOUT_MS,
});
```

- [ ] **Step 5: Update `src/models/discovery.ts`**

Add import:
```typescript
import { resolveCursorAgentBinary } from "../utils/binary.js";
```

Update `queryViaCLI()` at line ~52:
```typescript
// Before:
const proc = bunAny.spawn(["cursor-agent", "models", "--json"], {

// After:
const proc = bunAny.spawn([resolveCursorAgentBinary(), "models", "--json"], {
```

Update `queryViaHelp()` at line ~79:
```typescript
// Before:
const proc = bunAny.spawn(["cursor-agent", "--help"], {

// After:
const proc = bunAny.spawn([resolveCursorAgentBinary(), "--help"], {
```

- [ ] **Step 6: Update `src/tools/executors/cli.ts`**

```typescript
// Before:
const child = spawn("opencode", ["tool", "run", toolId, "--json", JSON.stringify(args)], {
  stdio: ["ignore", "pipe", "pipe"],
});

// After:
const child = spawn("opencode", ["tool", "run", toolId, "--json", JSON.stringify(args)], {
  stdio: ["ignore", "pipe", "pipe"],
  shell: process.platform === "win32",
});
```

- [ ] **Step 7: Update `src/plugin.ts` — import + Bun.spawn binary args + Node spawn shell flag + execSync fix**

Add import (near other imports at top):
```typescript
import { resolveCursorAgentBinary } from "./utils/binary.js";
```

Update Bun.spawn in the `/v1/models` handler (line ~573):
```typescript
// Before:
const proc = bunAny.Bun.spawn(["cursor-agent", "models"], {

// After:
const proc = bunAny.Bun.spawn([resolveCursorAgentBinary(), "models"], {
```

Update Bun.spawn in the main request handler (line ~681):
```typescript
// Before:
const proc = bunAny.Bun.spawn(["cursor-agent", "--print", ...

// Note: this is an object-syntax Bun.spawn call. Update the cmd array:
// Before (inside the cmd array):
"cursor-agent",

// After:
resolveCursorAgentBinary(),
```

Fix the Node models endpoint `execSync` → `execFileSync` (line ~1058):
```typescript
// Before:
const { execSync } = await import("child_process");
const output = execSync("cursor-agent models", { encoding: "utf-8", timeout: 30000 });

// After:
const { execFileSync } = await import("child_process");
const output = execFileSync(resolveCursorAgentBinary(), ["models"], { encoding: "utf-8", timeout: 30000 });
```

Update the Node path `spawn` call (line ~1140):
```typescript
// Before:
const child = spawn(cmd[0], cmd.slice(1), { stdio: ["pipe", "pipe", "pipe"] });

// After:
const child = spawn(cmd[0], cmd.slice(1), {
  stdio: ["pipe", "pipe", "pipe"],
  shell: process.platform === "win32",
});
```

Also update the `cmd` array construction to use `resolveCursorAgentBinary()` instead of `"cursor-agent"` (there are two `cmd` arrays in the Node handler — around lines ~1119 and ~1655). Look for `"cursor-agent", "--print"` and replace the first element.

Also update the Bun path `/v1/models` Bun.spawn for model discovery (line ~560):
```typescript
// Before:
const proc = bunAny.Bun.spawn(["cursor-agent", "models"], {

// After:
const proc = bunAny.Bun.spawn([resolveCursorAgentBinary(), "models"], {
```

Also update the `proxyBaseURL` call near line ~2015 in the plugin registration that passes `"cursor-agent"` as a string argument to a helper function — change to `resolveCursorAgentBinary()`.

- [ ] **Step 8: Run full unit test suite**

```bash
bun test tests/unit/ 2>&1 | tail -10
```

Expected: all tests pass

- [ ] **Step 9: Run build to check TypeScript compilation**

```bash
bun run build 2>&1 | tail -10
```

Expected: no errors

- [ ] **Step 10: Commit**

```bash
git add src/auth.ts src/client/simple.ts src/cli/opencode-cursor.ts src/cli/model-discovery.ts src/models/discovery.ts src/tools/executors/cli.ts src/plugin.ts
git commit -m "feat: add Windows spawn compatibility and centralise binary resolution"
```

---

## Chunk 2: Path comparison fix + Node fallback tools

### Task 3: Windows path comparison fix

**Files:**
- Modify: `src/plugin.ts` (one line in `canonicalizePathForCompare`)
- Modify: `tests/unit/plugin-proxy-reuse.test.ts` (add 2 cases)

- [ ] **Step 1: Add 2 tests to `tests/unit/plugin-proxy-reuse.test.ts`**

Append inside the `describe("proxy health reuse guard", ...)` block:

```typescript
  test("normalizeWorkspaceForCompare produces consistent results for the same input", () => {
    // The one-line fix adds win32 to the toLowerCase() branch in canonicalizePathForCompare.
    // The toLowerCase() branch cannot be exercised from Linux CI (process.platform !== "win32").
    // This test validates the stable cross-platform contract: same path → same normalized form.
    const workspace = process.cwd(); // use a real path so realpathSync.native succeeds
    const a = normalizeWorkspaceForCompare(workspace);
    const b = normalizeWorkspaceForCompare(workspace);
    expect(a).toBe(b);
    expect(typeof a).toBe("string");
    expect(a.length).toBeGreaterThan(0);
  });

  test("rejects workspace mismatch after normalisation", () => {
    expect(
      isReusableProxyHealthPayload(
        { ok: true, workspaceDirectory: "/tmp/project-a" },
        "/tmp/project-b",
      ),
    ).toBe(false);
  });
```

> **Note on Windows coverage:** The `toLowerCase()` for `win32` in `canonicalizePathForCompare` cannot be exercised from Linux CI since `process.platform` is always `"linux"` there. The fix is a one-liner and its correctness is verified by code review. End-to-end validation requires a Windows runner.

- [ ] **Step 2: Run tests to verify they pass (these test existing logic)**

```bash
bun test tests/unit/plugin-proxy-reuse.test.ts
```

Expected: all 7 tests pass (the 2 new ones test invariants that already hold)

- [ ] **Step 3: Apply the one-line fix in `src/plugin.ts`**

Find `canonicalizePathForCompare` (line ~194):

```typescript
// Before:
  if (process.platform === "darwin") {
    return normalizedPath.toLowerCase();
  }

// After:
  if (process.platform === "darwin" || process.platform === "win32") {
    return normalizedPath.toLowerCase();
  }
```

- [ ] **Step 4: Run tests again to confirm still passing**

```bash
bun test tests/unit/plugin-proxy-reuse.test.ts
```

Expected: all 8 tests pass

- [ ] **Step 5: Run full unit suite**

```bash
bun test tests/unit/ 2>&1 | tail -5
```

Expected: all pass

- [ ] **Step 6: Commit**

```bash
git add src/plugin.ts tests/unit/plugin-proxy-reuse.test.ts
git commit -m "fix: canonicalizePathForCompare case-insensitive on win32 for correct multi-instance proxy reuse"
```

---

### Task 4: Node fallback grep/glob

**Files:**
- Modify: `src/tools/defaults.ts` (add exported fallback functions + win32 guards)
- Create: `tests/tools/node-fallbacks.test.ts`

> **Context:** The grep tool handler is registered around line ~259 in `defaults.ts`. The glob tool handler is around line ~365. Both currently use `execFile("grep", ...)` and `execFile("find", ...)` respectively. We add a Windows guard at the top of each handler that calls our new fallback functions. The fallback functions live at the bottom of the file and are exported.

- [ ] **Step 1: Create `tests/tools/node-fallbacks.test.ts` with all 12 failing tests**

```typescript
// tests/tools/node-fallbacks.test.ts
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { nodeFallbackGrep, nodeFallbackGlob } from "../../src/tools/defaults.js";

let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "fallback-test-"));

  // Create structure:
  // tmpDir/
  //   a.ts          (contains "hello world")
  //   b.ts          (contains "goodbye world")
  //   sub/
  //     c.ts        (contains "hello again")
  //     d.js        (contains "irrelevant")
  //   node_modules/
  //     pkg/
  //       e.ts      (contains "hello hidden" — should be SKIPPED)

  writeFileSync(join(tmpDir, "a.ts"), "hello world\nfoo bar\n");
  writeFileSync(join(tmpDir, "b.ts"), "goodbye world\n");
  mkdirSync(join(tmpDir, "sub"));
  writeFileSync(join(tmpDir, "sub", "c.ts"), "hello again\n");
  writeFileSync(join(tmpDir, "sub", "d.js"), "irrelevant\n");
  mkdirSync(join(tmpDir, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(tmpDir, "node_modules", "pkg", "e.ts"), "hello hidden\n");
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// --- nodeFallbackGrep ---

describe("nodeFallbackGrep", () => {
  test("finds match in a single file", async () => {
    const result = await nodeFallbackGrep("hello", join(tmpDir, "a.ts"));
    expect(result).toContain("hello world");
    expect(result).toContain("a.ts:1:");
  });

  test("finds matches across directory tree", async () => {
    const result = await nodeFallbackGrep("hello", tmpDir);
    expect(result).toContain("a.ts");
    expect(result).toContain("sub");
    // Both a.ts and sub/c.ts contain "hello"
    const lines = result.split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(2);
  });

  test("returns No matches found when pattern does not match", async () => {
    const result = await nodeFallbackGrep("zzznomatch", tmpDir);
    expect(result).toBe("No matches found");
  });

  test("returns Invalid regex pattern for bad regex", async () => {
    const result = await nodeFallbackGrep("[unclosed", tmpDir);
    expect(result).toBe("Invalid regex pattern");
  });

  test("include filter restricts to matching filenames", async () => {
    const result = await nodeFallbackGrep("hello", tmpDir, "*.ts");
    // Should match a.ts and sub/c.ts but NOT sub/d.js
    expect(result).not.toContain("d.js");
    expect(result).toContain(".ts");
  });

  test("skips node_modules directory", async () => {
    const result = await nodeFallbackGrep("hello", tmpDir);
    // e.ts inside node_modules should NOT appear
    expect(result).not.toContain("node_modules");
  });

  test("returns Path not found for non-existent path", async () => {
    const result = await nodeFallbackGrep("hello", join(tmpDir, "nonexistent"));
    expect(result).toBe("Path not found");
  });
});

// --- nodeFallbackGlob ---

describe("nodeFallbackGlob", () => {
  test("*.ts pattern matches only .ts files in root", async () => {
    const result = await nodeFallbackGlob("*.ts", tmpDir);
    const files = result.split("\n").filter(Boolean);
    expect(files.some(f => f.endsWith("a.ts"))).toBe(true);
    expect(files.some(f => f.endsWith("b.ts"))).toBe(true);
    // d.js should NOT appear
    expect(files.some(f => f.endsWith("d.js"))).toBe(false);
  });

  test("**/*.ts pattern matches .ts files in subdirectories", async () => {
    const result = await nodeFallbackGlob("**/*.ts", tmpDir);
    const files = result.split("\n").filter(Boolean);
    expect(files.some(f => f.includes("sub") && f.endsWith("c.ts"))).toBe(true);
  });

  test("returns No files found when pattern does not match", async () => {
    const result = await nodeFallbackGlob("*.xyz", tmpDir);
    expect(result).toBe("No files found");
  });

  test("skips node_modules directory", async () => {
    const result = await nodeFallbackGlob("**/*.ts", tmpDir);
    expect(result).not.toContain("node_modules");
  });

  test("returns No files found for non-existent search path", async () => {
    const result = await nodeFallbackGlob("*.ts", join(tmpDir, "nonexistent"));
    expect(result).toBe("No files found");
  });
});
```

- [ ] **Step 2: Run tests to verify they all fail (functions not exported yet)**

```bash
bun test tests/tools/node-fallbacks.test.ts 2>&1 | head -20
```

Expected: import errors or `nodeFallbackGrep is not a function`

- [ ] **Step 3: Add `nodeFallbackGrep` and `nodeFallbackGlob` to the bottom of `src/tools/defaults.ts`**

Append at the very end of the file (after the existing `getDefaultToolNames` function):

```typescript
const FALLBACK_SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build"]);
const fallbackLog = createLogger("tools:fallback");

export async function nodeFallbackGrep(
  pattern: string,
  searchPath: string,
  include?: string,
): Promise<string> {
  const fs = await import("fs/promises");
  const path = await import("path");

  let regex: RegExp;
  try {
    regex = new RegExp(pattern);
  } catch {
    try {
      regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    } catch {
      return "Invalid regex pattern";
    }
  }

  let includeRegex: RegExp | undefined;
  if (include) {
    const incPattern = include.replace(/\./g, "\\.").replace(/\*/g, ".*");
    includeRegex = new RegExp(`^${incPattern}$`);
  }

  const results: string[] = [];

  async function walk(dir: string): Promise<void> {
    if (results.length >= 100) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err: any) {
      if (err?.code !== "ENOENT" && err?.code !== "EACCES") {
        fallbackLog.error("Unexpected error reading directory", { dir, code: err?.code, message: err?.message });
      }
      return;
    }
    for (const entry of entries) {
      if (results.length >= 100) return;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!FALLBACK_SKIP_DIRS.has(entry.name)) {
          await walk(fullPath);
        }
      } else if (entry.isFile()) {
        if (includeRegex && !includeRegex.test(entry.name)) continue;
        let content: string;
        try {
          content = await fs.readFile(fullPath, "utf-8");
        } catch (err: any) {
          if (err?.code !== "ENOENT" && err?.code !== "EACCES") {
            fallbackLog.error("Unexpected error reading file", { path: fullPath, code: err?.code, message: err?.message });
          }
          continue;
        }
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (regex.test(lines[i])) {
            results.push(`${fullPath}:${i + 1}:${lines[i]}`);
            if (results.length >= 100) break;
          }
        }
      }
    }
  }

  let stat;
  try {
    stat = await fs.stat(searchPath);
  } catch {
    return "Path not found";
  }

  if (stat.isFile()) {
    let content: string;
    try {
      content = await fs.readFile(searchPath, "utf-8");
    } catch (err: any) {
      fallbackLog.error("Unexpected error reading file", { path: searchPath, code: err?.code, message: err?.message });
      return "Path not found";
    }
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (regex.test(lines[i])) {
        results.push(`${searchPath}:${i + 1}:${lines[i]}`);
        if (results.length >= 100) break;
      }
    }
  } else {
    await walk(searchPath);
  }

  return results.join("\n") || "No matches found";
}

export async function nodeFallbackGlob(
  pattern: string,
  searchPath: string,
): Promise<string> {
  const fs = await import("fs/promises");
  const path = await import("path");

  const results: string[] = [];
  const isPathPattern = pattern.includes("/");

  // Handle ** before * so double-star → .* and single-star → [^/]*
  let regexPattern = pattern
    .replace(/\./g, "\\.")
    .replace(/\*\*/g, "\x00") // placeholder for **
    .replace(/\*/g, "[^/]*")
    .replace(/\x00/g, ".*"); // restore ** as .*

  let regex: RegExp;
  try {
    regex = isPathPattern
      ? new RegExp(`${regexPattern}$`)
      : new RegExp(`^${regexPattern}$`);
  } catch {
    return "No files found";
  }

  async function walk(dir: string): Promise<void> {
    if (results.length >= 50) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err: any) {
      if (err?.code !== "ENOENT" && err?.code !== "EACCES") {
        fallbackLog.error("Unexpected error reading directory", { dir, code: err?.code, message: err?.message });
      }
      return;
    }
    for (const entry of entries) {
      if (results.length >= 50) return;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!FALLBACK_SKIP_DIRS.has(entry.name)) {
          await walk(fullPath);
        }
      } else if (entry.isFile()) {
        const matchTarget = isPathPattern
          ? fullPath.replace(/\\/g, "/")
          : entry.name;
        if (regex.test(matchTarget)) {
          results.push(fullPath);
        }
      }
    }
  }

  await walk(searchPath);
  return results.join("\n") || "No files found";
}
```

- [ ] **Step 4: Add win32 guards to grep and glob handlers in `src/tools/defaults.ts`**

In the grep handler (around line ~268, just before `const grepArgs = ["-r", "-n"];`):
```typescript
    if (process.platform === "win32") {
      return nodeFallbackGrep(pattern, path, include);
    }
```

In the glob handler (around line ~376, just before `const isPathPattern = normalizedPattern.includes("/");`):
```typescript
    if (process.platform === "win32") {
      return nodeFallbackGlob(normalizedPattern, cwd);
    }
```

- [ ] **Step 5: Run fallback tests**

```bash
bun test tests/tools/node-fallbacks.test.ts
```

Expected: `12 pass, 0 fail`

- [ ] **Step 6: Run full test suite**

```bash
bun test tests/ 2>&1 | tail -10
```

Expected: all pass

- [ ] **Step 7: Commit**

```bash
git add src/tools/defaults.ts tests/tools/node-fallbacks.test.ts
git commit -m "feat: add Windows-compatible Node.js fallback grep/glob for platforms without grep/find"
```

---

## Chunk 3: Miscellaneous + plugin-toggle

### Task 5: Miscellaneous fixes, plugin-toggle, and README

**Files:**
- Modify: `package.json`
- Modify: `src/plugin-toggle.ts`
- Modify: `tests/unit/plugin-toggle.test.ts`
- Modify: `README.md`

- [ ] **Step 1: Revert `package.json` changes from PR #52**

In `package.json`:
```json
// Before (PR introduced):
"type": "commonjs",

// After (revert to original):
"type": "module",
```

Also fix the `prepublishOnly` script if it has a literal `\n` injected — it should be:
```json
"prepublishOnly": "bun run build"
```

(Check by looking at the current file — if `prepublishOnly` is correct already, skip this.)

- [ ] **Step 2: Add provider detection to `src/plugin-toggle.ts`**

In `isCursorPluginEnabledInConfig`, add the provider check block just before the existing `if (Array.isArray(configObject.plugin))` check:

```typescript
  if (configObject.provider && typeof configObject.provider === "object") {
    if (CURSOR_PROVIDER_ID in (configObject.provider as Record<string, unknown>)) {
      return true;
    }
  }
```

Full updated function:
```typescript
export function isCursorPluginEnabledInConfig(config: unknown): boolean {
  if (!config || typeof config !== "object") {
    return true;
  }

  const configObject = config as { plugin?: unknown; provider?: unknown };

  if (configObject.provider && typeof configObject.provider === "object") {
    if (CURSOR_PROVIDER_ID in (configObject.provider as Record<string, unknown>)) {
      return true;
    }
  }

  if (Array.isArray(configObject.plugin)) {
    return configObject.plugin.some((entry) => matchesPlugin(entry));
  }

  return true;
}
```

- [ ] **Step 3: Add 2 tests to `tests/unit/plugin-toggle.test.ts`**

Add inside the `describe("plugin toggle", ...)` block:

```typescript
  it("enables plugin when provider object contains cursor-acp key (no plugin array)", () => {
    expect(isCursorPluginEnabledInConfig({ provider: { "cursor-acp": { model: "claude" } } })).toBe(true);
  });

  it("enables plugin via fallthrough when provider has only other providers (no plugin array)", () => {
    // Fallthrough — no plugin array, no cursor-acp in provider, returns true by default
    expect(isCursorPluginEnabledInConfig({ provider: { "other-provider": {} } })).toBe(true);
  });
```

- [ ] **Step 4: Run plugin-toggle tests**

```bash
bun test tests/unit/plugin-toggle.test.ts
```

Expected: all tests pass (including the 2 new ones)

- [ ] **Step 5: Update `README.md`**

Make the following changes to `README.md`:

1. Add Windows badge after the macOS badge in the badges section:
```html
<img src="https://img.shields.io/badge/Windows-0078D6?style=for-the-badge&logo=windows&logoColor=white" alt="Windows" />
```

2. Add Windows install section before the `<details>` block:
```markdown
**macOS/Linux:**
```bash
curl -fsSL https://raw.githubusercontent.com/Nomadcxx/opencode-cursor/main/install.sh | bash
```

**Windows (PowerShell):**
```powershell
iwr https://raw.githubusercontent.com/Nomadcxx/opencode-cursor/main/install.ps1 -UseBasicParsing | iex
```
```

3. Update config path note in two places (Option B section and MCP section):
```
~/.config/opencode/opencode.json (or %USERPROFILE%\.config\opencode\opencode.json on Windows)
```

4. Update the comparison table **Platform** row for open-cursor:
```
Linux, macOS, Windows
```

5. Ensure file ends with a newline character.

- [ ] **Step 6: Run full test suite one final time**

```bash
bun test tests/ 2>&1 | tail -10
```

Expected: all tests pass

- [ ] **Step 7: Run build**

```bash
bun run build 2>&1 | tail -5
```

Expected: no errors

- [ ] **Step 8: Commit**

```bash
git add package.json src/plugin-toggle.ts tests/unit/plugin-toggle.test.ts README.md
git commit -m "feat: add Windows platform support (binary resolution, spawn, path compare, fallback tools)"
```

---

## Final verification

- [ ] Run the full CI test suite:

```bash
bun test tests/tools/defaults.test.ts tests/tools/executor-chain.test.ts tests/tools/sdk-executor.test.ts tests/tools/mcp-executor.test.ts tests/tools/skills.test.ts tests/tools/registry.test.ts tests/unit/cli/model-discovery.test.ts tests/unit/proxy/prompt-builder.test.ts tests/unit/proxy/tool-loop.test.ts tests/unit/provider-boundary.test.ts tests/unit/provider-runtime-interception.test.ts tests/unit/provider-tool-schema-compat.test.ts tests/unit/provider-tool-loop-guard.test.ts tests/unit/plugin.test.ts tests/unit/plugin-tools-hook.test.ts tests/unit/plugin-tool-resolution.test.ts tests/unit/plugin-config.test.ts tests/unit/auth.test.ts tests/unit/streaming/line-buffer.test.ts tests/unit/streaming/parser.test.ts tests/unit/streaming/types.test.ts tests/unit/streaming/delta-tracker.test.ts tests/competitive/edge.test.ts 2>&1 | tail -10
```

Expected: all pass

- [ ] Verify `bun run build` produces no errors
