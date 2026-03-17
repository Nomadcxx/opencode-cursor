# Spec: Task Tool Guard + Schema Fix

**Date:** 2026-03-17
**Issue:** #51 (follow-up)

## Problem

Two failure modes remain after v2.3.19 graduated response fix:

1. **Parallel batching.** Model launches 3–5 `task` calls simultaneously. With `maxRepeat=2`, the 3rd identical validation failure triggers the guard mid-batch before the model sees any hint.

2. **Model doesn't know valid `subagent_type` values.** The schema exposes `subagent_type` as a plain `string` with no enum. Model reliably omits it or passes `undefined`, producing validation errors on every attempt.

---

## Fix 1 — Raise strict error threshold for exploration tools

### File: `src/provider/tool-loop-guard.ts`

**Part A — Add `"task"` to `EXPLORATION_TOOLS`**

Disables coarse fingerprint tracking for `task` (parallel calls with different prompts don't aggregate). Necessary but not sufficient — Part B is required too.

**Part B — Apply `EXPLORATION_LIMIT_MULTIPLIER` to strict threshold in `evaluateWithFingerprints` error path**

This is the primary code change to be made. Currently the multiplier is only applied in the success branch of `evaluate()` (lines 123–128). The `evaluateWithFingerprints` helper — used by both `evaluate()` error path and `evaluateValidation()` — uses plain `maxRepeat` for the strict threshold check (line 516) and returns `maxRepeat: maxRepeat` (raw) in the early-return for exploration tools (lines 519–528). Fix:

```typescript
function evaluateWithFingerprints(
  toolName: string,
  errorClass: ToolLoopErrorClass,
  strictFingerprint: string,
  coarseFingerprint: string,
  strictCounts: Map<string, number>,
  coarseCounts: Map<string, number>,
  maxRepeat: number,
  coarseMaxRepeat: number,
): ToolLoopGuardDecision {
  if (errorClass === "success") { /* unchanged */ }

  const isExplorationTool = EXPLORATION_TOOLS.has(toolName.toLowerCase());
  const effectiveMaxRepeat = isExplorationTool
    ? maxRepeat * EXPLORATION_LIMIT_MULTIPLIER
    : maxRepeat;

  const strictRepeatCount = (strictCounts.get(strictFingerprint) ?? 0) + 1;
  strictCounts.set(strictFingerprint, strictRepeatCount);
  const strictTriggered = strictRepeatCount > effectiveMaxRepeat;

  if (isExplorationTool) {
    return {
      fingerprint: strictFingerprint,
      repeatCount: strictRepeatCount,
      maxRepeat: effectiveMaxRepeat,  // MUST be effectiveMaxRepeat, not maxRepeat
      errorClass,
      triggered: strictTriggered,
      tracked: true,
    };
  }
  // ... coarse logic unchanged
}
```

**Critical:** `maxRepeat` in the returned decision must be `effectiveMaxRepeat`. The caller in `runtime-interception.ts` computes `isFirstTrigger = decision.repeatCount === decision.maxRepeat + 1` to decide soft vs hard kill. Returning raw `maxRepeat` (2) instead of `effectiveMaxRepeat` (10) would make every trigger after count=3 appear as "not first trigger" and emit a hard kill rather than a soft hint.

**Side effect on existing `EXPLORATION_TOOLS` members:** `read`, `grep`, `glob`, `bash`, `shell`, `webfetch`, `semsearch` also get their strict error-path threshold raised to `maxRepeat × 5`. This is intentional — these tools already had 5x on the success path; error-path parity is correct behaviour. Document and test explicitly.

**Combined effect (default `maxRepeat=2`):**
- Strict threshold: 10 (was 2)
- Coarse tracking: disabled for `task`
- Batch of 3–5 identical failing calls: no trigger
- 10+ identical failing calls: hard kill (with soft block at call 11)

---

## Fix 2 — Inject valid `subagent_type` values into the system prompt

### New function: `readSubagentNames()` in `src/mcp/config.ts`

Co-locate with `readMcpConfigs` (same file-read pattern, same config path). The `agent` section of `opencode.json` follows this schema (example from the project's own config):

```json
"agent": {
  "build":      { "mode": "primary",  "model": "openai/gpt-5.2", ... },
  "codemachine": { "mode": "subagent", "model": "kimi/kimi-k2.5", ... },
  "review":     { "mode": "subagent", "model": "google/...",      ... }
}
```

Agent names are top-level keys; `mode` is `"primary"` or `"subagent"`. Export:

```typescript
export function readSubagentNames(): string[]
```

Logic (in priority order):
1. Read `opencode.json` — find `agent` section
2. If agents with `mode: "subagent"` exist → return those names only
3. If no subagent-mode agents but other agents exist → return all agent names
4. If `agent` section absent, empty (`{}`), or `opencode.json` unreadable/malformed → return `["general-purpose"]` (silent fallback, same pattern as `readMcpConfigs`)

### Injection A — cursor-agent mode (`src/plugin.ts`)

The `experimental.chat.system.transform` hook (line ~2059) calls `buildAvailableToolsSystemMessage(...)`. Keep `buildAvailableToolsSystemMessage` pure — do not read config inside it. Instead, call `readSubagentNames()` in the hook and pass the result as a new parameter:

```typescript
// in the hook:
const subagentNames = readSubagentNames();
const systemMessage = buildAvailableToolsSystemMessage(
  lastToolNames, lastToolMap, mcpToolDefs, mcpToolSummaries,
  subagentNames,  // new param
);
```

`buildAvailableToolsSystemMessage` appends to the returned string:
> `When calling the task tool, set subagent_type to one of: <agent1>, <agent2>. Do not omit this parameter.`

Only append when `subagentNames.length > 0` (always true given fallback, but guard defensively).

### Injection B — proxy mode (`src/plugin.ts`)

`buildPromptFromMessages(messages, tools)` is called from `plugin.ts` lines 631 and 1095. The `tools` array contains whatever OpenCode sends — which includes `task` when OpenCode passes its tool definitions. Add `subagentNames` as an **optional** third parameter (default `[]`) and append the same guidance to the tool description block when `tools` contains a tool named `task` and `subagentNames.length > 0`.

---

## Testing Requirements

### Unit tests — `evaluateWithFingerprints` error-path threshold

- `task` with 5 identical validation failures → no trigger; `decision.maxRepeat === 10`
- `task` with 10 identical validation failures → no trigger (count=10, not > 10)
- `task` with 11 identical validation failures → **soft block** (count=11 > 10, first trigger)
- `task` with 12 identical validation failures → **hard kill** (second trigger)
- Non-task tool `edit` with 3 identical validation failures → still triggers at count=3 (unchanged)
- `read` (already in EXPLORATION_TOOLS) with 5 identical `tool_error` failures → no trigger; `decision.maxRepeat === 10` (documents intentional error-path parity change)
- `evaluateValidation` for `task` with 11 failures → soft block (confirms fix applies to validation path too)

### Unit tests — parallel batch / coarse tracking

- `task` batch of 5 calls each with different prompts but same error class → no coarse trigger (coarse disabled for `task`)
- Non-exploration tool with 5 different-fingerprint calls same error class → coarse trigger fires (existing behaviour preserved)

### Unit tests — `readSubagentNames()`

- Config with `{ codemachine: { mode: "subagent" }, review: { mode: "subagent" }, build: { mode: "primary" } }` → `["codemachine", "review"]`
- Config with `{ build: { mode: "primary" } }` (no subagents) → `["build"]`
- Config with `{ "agent": {} }` (empty object) → `["general-purpose"]`
- Config with no `agent` key → `["general-purpose"]`
- Config file unreadable → `["general-purpose"]`
- Config file malformed JSON → `["general-purpose"]`

### Unit tests — system message injection

- `buildAvailableToolsSystemMessage` with `subagentNames=["codemachine","review"]` → output contains `codemachine, review`
- `buildPromptFromMessages` with tools including `task` + `subagentNames=["general-purpose"]` → output contains guidance
- `buildPromptFromMessages` with tools NOT including `task` → guidance absent

### Regression

- All pre-existing tests pass **except `ISSUE_51`** — that test documents old broken behaviour (triggers at count=3) and must be updated to reflect new threshold (triggers at count=11)
- Soft/hard graduated response tests pass (v2.3.19 changes)
- EXPLORATION_TOOLS success-path behaviour for `read`/`grep`/`glob` unchanged

### Manual / production test

- Run `analyze this repo, tell me potential issues` in OpenCode
- Verify model uses a valid `subagent_type` from injected list — no `undefined` validation errors
- Verify parallel `task` calls complete without triggering guard
- Simulate doom-loop: confirm 11+ identical failures still trigger soft then hard kill
