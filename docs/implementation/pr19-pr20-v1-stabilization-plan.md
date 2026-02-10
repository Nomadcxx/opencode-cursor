# PR19/PR20 Implementation Plan (Auto Model, Production-First)

## Status (Tuesday, February 10, 2026)

- PR #17 merged into `main` at `2026-02-10T07:23:53Z`.
- PR #18 merged into `main` at `2026-02-10T07:26:53Z`.
- Baseline production behavior (model `cursor-acp/auto`):
  - `v1` intercepts tool calls but repeatedly fails on `edit` argument/schema mismatch.
  - `legacy` and `v1+autofallback` execute more useful calls (`todowrite`/`read`) but still show long tool-loop runs on the travel prompt.

## Goal

Make `v1` reliably compatible with OpenCode tool schemas in production, while preserving legacy fallback safety.

## PR #19: v1 Schema Compatibility + Argument Normalization

### Scope

1. Add a compatibility layer for intercepted `tool_call` arguments.
2. Normalize model-generated argument variants into OpenCode tool schema shape.
3. Define deterministic behavior when normalized args still fail schema validation.
4. Clarify schema source for OpenCode-owned tools (including `todowrite`).

### Implementation

1. Add `src/provider/tool-schema-compat.ts`.
2. Add generic key alias normalization:
   - `filePath|file|target_file` -> `path`
   - `contents|text|streamContent` -> `content`
   - `oldString` -> `old_string`
   - `newString` -> `new_string`
3. Add alias collision rule:
   - If canonical key already exists, aliases do not overwrite it.
   - Aliases that collide are dropped and logged.
4. Add tool-specific normalization (no lossy semantic rewrite by default):
   - `edit`: normalize key names only. Do not silently rewrite to `write`.
   - `todowrite`: normalize status values (`todo|pending` -> `pending`, `in-progress` -> `in_progress`, `done` -> `completed`), default `priority=medium` when missing.
5. Schema source and ownership:
   - Build runtime `toolSchemaMap` from request `body.tools[]` in `src/plugin.ts`.
   - `todowrite` is treated as OpenCode-owned (remote) schema, not part of local default tools.
6. Validation behavior after normalization:
   - If schema exists and args validate: intercept with normalized args.
   - If schema exists and args still fail: do not rewrite semantics; forward the normalized call to OpenCode and rely on native tool validation error for model self-repair.
   - Log structured compat error (`tool`, `missing`, `unexpected`, `repairHint`) for loop-guard consumption.
7. Wire compat into v1 interception path only in `src/provider/runtime-interception.ts`.
8. Add debug logs for `tool`, `originalArgKeys`, `normalizedArgKeys`, `collisionKeys`, `validationOk`, `repairHint`.

### Explicit Safety Decision

- `edit -> write` rewrite is disabled in PR #19 to avoid destructive semantic drift.
- Optional rewrite (if ever added) must be explicitly env-gated and only when file does not exist.

### Tests

1. `tests/unit/provider-tool-schema-compat.test.ts`
2. Extend `tests/unit/provider-runtime-interception.test.ts` for v1 normalization/validation paths.
3. Add tests for alias collisions and canonical precedence.
4. Extend `tests/integration/opencode-loop.integration.test.ts` with invalid `edit` args + model repair loop scenario (no rewrite).

### Acceptance

1. Travel prompt no longer loops on `edit` type/path errors in v1.
2. No regression in legacy behavior.
3. Unit + integration suites pass.

## PR #20: Loop Guard + Controlled Auto-Fallback + Production Hardening

### Scope

1. Prevent infinite repeated tool-call failures.
2. Add explicit per-request guard plumbing used by both v1 and legacy handlers.
3. Add optional emergency fallback from v1 to legacy on repeated failures.
4. Define exact termination ownership and chunk format in stream/non-stream handlers.
5. Improve production diagnostics for faster incident triage.

### Implementation

1. Add `src/provider/tool-loop-guard.ts` with per-request state.
2. Extend `HandleToolLoopEventBaseOptions` in `src/provider/runtime-interception.ts` with `toolLoopGuard`.
3. Guard fingerprint:
   - `tool + normalizedArgShape + errorClass`.
   - `errorClass` derived from prior `role:"tool"` result content in request messages when available; fallback `unknown`.
4. Add per-request guard threshold (env):
   - `CURSOR_ACP_TOOL_LOOP_MAX_REPEAT` (default `3`).
5. Thread guard through Bun/Node stream handlers in `src/plugin.ts`:
   - Create one guard per incoming chat request.
   - Pass guard into every `handleToolLoopEventWithFallback` call.
6. On threshold breach:
   - If `CURSOR_ACP_PROVIDER_BOUNDARY_AUTOFALLBACK=true` and boundary is v1:
     - call `boundaryContext.activateLegacyFallback("toolLoopGuard", error)`;
     - continue with legacy for subsequent events in the same request.
   - Else:
     - return terminal error signal from runtime interception;
     - plugin stream driver emits terminal assistant chunk using `createChatCompletionChunk(..., done=true)` and `[DONE]`.
     - non-stream driver returns `createChatCompletionResponse` with explicit error text.
7. Add structured logs:
   - `loopGuardTriggered`, `fingerprint`, `repeatCount`, `fallbackActivated`.
8. Document env flags and behavior in `README.md`.

### Ownership Clarification

- Runtime interception decides `allow/fallback/terminate`.
- `src/plugin.ts` owns SSE/non-stream emission and stream termination mechanics.

### Tests

1. Unit tests for loop guard counting and reset semantics.
2. Integration test for repeated invalid `edit` calls:
   - `v1` with no fallback -> terminal error chunk.
   - `v1` with fallback -> switch to legacy after threshold.
3. Parity tests in both modes (`v1`, `legacy`) for core scenarios.
4. Test that fallback still only auto-triggers on configured guard condition or boundary extraction failures.

### Acceptance

1. No unbounded loop on repeated invalid calls.
2. Fallback behavior is deterministic and gated by env.
3. Production run completes with actionable output or explicit terminal error.

## Execution Sequence

1. Branch `feat/pr19-v1-schema-compat` from updated `main`; open PR #19.
2. Validate production matrix (`auto` only) and CI.
3. Branch `feat/pr20-loop-guard-fallback` from PR #19; open PR #20.
4. Validate matrix again, then merge #19 followed by #20.
