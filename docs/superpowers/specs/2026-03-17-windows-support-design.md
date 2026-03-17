# Windows Support + Multi-Instance Workspace Fix — Design Spec

**Date:** 2026-03-17
**PR reference:** #52 (intisy / Finn Birich) — cherry-picking useful parts, rewriting broken parts
**Issue:** Windows platform support + proxy reuse regression on Windows multi-instance setups

---

## Problem

PR #52 introduces Windows support with several critical bugs:

1. `package.json` `"type"` changed to `"commonjs"` — breaks all ESM consumers of the dist
2. `isReusableProxyHealthPayload` gutted to `return true` — cross-workspace proxy hijack regression, breaks 3 existing tests
3. `execSync(binary + " models")` string concat — command injection vector on paths with spaces
4. `nodeFallbackGrep`/`nodeFallbackGlob` have broken regex escaping, literal `\n` strings instead of newlines, and empty `catch {}` blocks
5. `chat.headers` hook used — does not exist in the OpenCode plugin SDK (`Hooks` interface only defines `event`, `auth`, `chat.message`, `chat.params`, `permission.ask`, `tool.execute.before`, `tool.execute.after`)
6. Zero test coverage on all new code

The actual multi-instance workspace bug on Windows is caused by `canonicalizePathForCompare` not lowercasing on `win32` (Windows filesystem is case-insensitive). The one-line fix is sufficient — no proxy architecture changes required.

---

## Approach: Simple fix (Option A)

Each OpenCode instance owns its own proxy. The workspace guard in `isReusableProxyHealthPayload` stays intact. With path comparison fixed for Windows, the existing multi-instance logic works correctly on all platforms.

Rejected: "shared proxy with per-request workspace header" (Option B) — requires `chat.headers` hook which does not exist in the SDK, and adds unsanitised header → CLI arg attack surface.

---

## Components

### 1. Binary resolution — `src/utils/binary.ts` (new file, borrow from PR)

Centralises cursor-agent binary resolution. Called from all spawn/exec sites instead of hardcoding `"cursor-agent"`.

**Resolution priority:**
1. `CURSOR_AGENT_EXECUTABLE` env var (if non-empty)
2. Windows: `%LOCALAPPDATA%\cursor-agent\cursor-agent.cmd` if exists
3. Unix: `~/.cursor-agent/cursor-agent` if exists, then `/usr/local/bin/cursor-agent` if exists
4. Fallback: bare `"cursor-agent.cmd"` on Windows, `"cursor-agent"` on Unix (PATH lookup)

**Requirements:**
- Import `createLogger("binary")` and log at `warn` level whenever a fallback path is taken, including which known path was checked and missed
- Pure function, no side effects beyond `existsSync` calls

### 2. Windows spawn compatibility

Add `shell: process.platform === "win32"` to every **Node.js** `spawn()` call that invokes cursor-agent or opencode:
- `src/auth.ts` — `spawn(resolveCursorAgentBinary(), ["login"], ...)`
- `src/client/simple.ts` — two `spawn()` calls
- `src/plugin.ts` — one `spawn()` call in the Node handler (line ~1140)
- `src/tools/executors/cli.ts` — `spawn("opencode", ...)`

Note: `src/plugin.ts` also contains `Bun.spawn()` calls (Bun path, lines ~573 and ~681). `Bun.spawn()` has a different API and does not take a `shell` option. Bun handles `.cmd` files natively on Windows — no changes needed to the Bun spawn calls.

Fix command injection in `src/plugin.ts` Node models endpoint:
```typescript
// Before (vulnerable):
execSync(resolveCursorAgentBinary() + " models", { encoding: "utf-8", timeout: 30000 })

// After (safe):
execFileSync(resolveCursorAgentBinary(), ["models"], { encoding: "utf-8", timeout: 30000 })
```

Verify `stdio: ["ignore", "pipe", "pipe"]` remains in `src/cli/model-discovery.ts` (PR dropped it; current `main` already has it restored — ensure it is not dropped again). Make `killSignal` platform-conditional:
```typescript
killSignal: process.platform === "win32" ? undefined : "SIGTERM"
```

### 3. Windows path comparison — the actual multi-instance fix

**One line change** in `canonicalizePathForCompare` in `src/plugin.ts`:

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

`resolve()` and `realpathSync.native` are already platform-aware and normalise slash direction on Windows. Lowercasing handles case-insensitive filesystem comparison. No other changes to path comparison logic.

`isReusableProxyHealthPayload` is **not modified**.

### 4. Node fallback grep/glob — `src/tools/defaults.ts` (rewrite)

Windows lacks `grep` and `find`. The PR's direction is correct but the implementation is buggy.

**`nodeFallbackGrep(pattern, searchPath, include?)`**
- Export the function for direct unit testing
- Regex construction: `new RegExp(pattern)` first; on failure, escape with `/[.*+?^${}()|[\]\\]/g` → `'\\$&'` (standard JS metachar escape)
- Line splitting: `content.split('\n')` (newline char, not the two-char string `\n`)
- `include` filter: escape literal dots with `/\./g` → `'\\.'`, then `*` → `.*`
- Catch blocks: distinguish `ENOENT`/`EACCES` (skip silently) from unexpected errors (log via `createLogger("tools:fallback")` at `error` level). No empty `catch {}` blocks.
- 100-result cap, skip `node_modules`, `.git`, `dist`, `build`

**`nodeFallbackGlob(pattern, searchPath)`**
- Export the function for direct unit testing
- Handle `**` before `*` in pattern transformation so `**` → `.*` and `*` → `[^/]*`
- Backslash normalisation: `fullPath.replace(/\\/g, '/')` (single backslash regex `/\\/g`)
- Catch blocks: same discriminated pattern as grep fallback
- 50-result cap, same directory skip list

Both functions are only called when `process.platform === "win32"` — the existing `grep`/`find` paths are unchanged on Linux/macOS.

### 5. Miscellaneous

**`package.json`:**
- Revert `"type"` back to `"module"`
- Revert `prepublishOnly` script (PR injected a literal `\n` into it)
- Do not bump version (that happens at release)

**`src/plugin-toggle.ts`:**
- Keep the provider detection addition from PR (clean, correct, low risk)

**`src/cli/opencode-cursor.ts` — `checkCursorAgent()`:**
- Call `resolveCursorAgentBinary()` once into a `binary` local variable
- Use `binary` for `execFileSync` call
- Keep hardcoded `"cursor-agent"` string as the display `name` in both return paths

**`README.md`:**
- Keep Windows badge, PowerShell install snippet, updated comparison table platform column
- Restore missing newline at end of file

---

## Tests

### `tests/unit/utils/binary.test.ts` (new)

Mock `existsSync` and `process.platform`. Cases:
- `CURSOR_AGENT_EXECUTABLE` set → returns env value without filesystem check
- `CURSOR_AGENT_EXECUTABLE` empty string → falls through to platform logic
- `win32` + known path exists → returns `.cmd` path
- `win32` + known path missing → returns `"cursor-agent.cmd"`
- `win32` + `LOCALAPPDATA` env missing → constructs fallback from `homedir()`
- Linux + first known path exists → returns that path
- Linux + first missing, second exists → returns second path
- Linux + neither exists → returns `"cursor-agent"`
- macOS + neither exists → returns `"cursor-agent"` (not `"cursor-agent.cmd"`)

### `tests/tools/node-fallbacks.test.ts` (new)

Test `nodeFallbackGrep` and `nodeFallbackGlob` against a real temp directory (no mocks needed — pure Node fs):
- `nodeFallbackGrep`: match in single file, match across tree, no match, invalid regex, include filter, `node_modules` skipped, 100-result cap
- `nodeFallbackGlob`: `*.ts` pattern, `**/*.ts` pattern, no match, 50-result cap, `node_modules` skipped

### `tests/unit/plugin-proxy-reuse.test.ts` (additions)

- Windows-style backslash path and forward-slash equivalent compare as equal
- Windows paths with different cases compare as equal
- Mixed case + backslash path compares equal to lowercase forward-slash equivalent

### `tests/unit/plugin-toggle.test.ts` (additions)

- `{ provider: { "cursor-acp": {} } }` with no `plugin` key → `true` (provider branch fires)
- `{ provider: { "other-provider": {} } }` with no `plugin` key → `true` (fallthrough, not provider branch)

---

## Credit

Commit message includes `Co-authored-by: Finn Birich <intisy@users.noreply.github.com>`. PR description credits @intisy and references PR #52.

---

## Out of scope

- Shared proxy / per-request workspace header (Option B) — deferred, requires SDK hook verification first
- Windows installer script (`install.ps1`) — separate concern, not part of plugin code
- Any changes to the tool loop guard or schema injection (separate PR #51 work)
