# Runtime Architecture: Cursor Agent + OpenCode Tool Loop

This document describes the current runtime architecture on `main`, with the default settings:

- `CURSOR_ACP_TOOL_LOOP_MODE=opencode`
- `CURSOR_ACP_PROVIDER_BOUNDARY=v1`
- `CURSOR_ACP_PROVIDER_BOUNDARY_AUTOFALLBACK=true`

## High-Level Flow

1. OpenCode sends chat requests to the `cursor-acp` provider (`/v1/chat/completions`).
2. The plugin proxy spawns `cursor-agent` per request and streams NDJSON (`stream-json` format).
3. Assistant text/thinking streams back to OpenCode as SSE.
4. `tool_call` events are intercepted at the provider boundary.
5. Intercepted calls are normalized and guarded, then returned as OpenAI `tool_calls`.
6. OpenCode executes tools locally and sends results back as `role: "tool"` messages in the next turn.
7. Prompt builder renders named tool results into `TOOL_RESULT (name: ..., call_id: ...)` blocks for the next `cursor-agent` invocation.

## Tool Ownership Model

### `opencode` mode (default)

- OpenCode owns execution of the active tool list.
- In `chat.params`, existing OpenCode tool definitions are preserved and passed through.
- `cursor-acp` does not execute SDK/MCP tools in this mode; it translates tool-call protocol boundaries.

### Cursor-native tool side effects

The `cursor-agent --print --output-format stream-json` path can still execute Cursor-native tools inside the Cursor subprocess. Live tracing on Cursor Agent `2026.06.26-7079533` showed the Cursor child process opening the target file with `O_WRONLY|O_CREAT|O_TRUNC` while OpenCode only read it. The plugin can prevent a suspicious Cursor `streamContent` edit from being rerouted into an OpenCode `write`, but it cannot prevent Cursor's subprocess from mutating the file first.

Prompt shape does not change that ownership boundary. A richer `LOCAL OPENCODE TOOL RESULT` prompt, with SDK-shaped completed tool-result data, still produced a Cursor `editToolCall` and a direct file mutation in live Composer 2.5 testing. That format may improve continuation quality, but it should not be treated as a write-control mechanism.

Cursor CLI flags did not provide a drop-in fix:

- `--sandbox enabled` still allowed Cursor's edit tool to change the file.
- `--mode plan` kept the file unchanged, but returned planning/read-only behavior instead of an OpenCode-owned edit request.

### `proxy-exec` mode (legacy/compat mode)

- `cursor-acp` can inject tool definitions and execute via internal router:
  - Local tools
  - SDK-discovered tools
  - MCP-discovered tools
- Used as compatibility path and fallback strategy.

### `off` mode

- Tool-loop behavior is disabled.

## Provider Boundary (`legacy` vs `v1`)

The boundary abstraction is implemented in `src/provider/boundary.ts` and runtime handling in `src/provider/runtime-interception.ts`.

- `v1` (default): shared extraction/interception path for Bun + Node proxy handlers.
- `legacy`: previous extraction/runtime behavior.

`v1` adds:

- Tool name alias resolution (`shell`, `runCommand`, `delegateTask`, `skillMcp`, etc.)
- Schema compatibility normalization (`src/provider/tool-schema-compat.ts`)
- Optional edit-to-write reroute for malformed full-file replacement edits
- Tool-loop guard with fingerprinting (`src/provider/tool-loop-guard.ts`)
- Guarded fallback to `legacy` when enabled and specific termination/error conditions are met

## Model Variant Resolution

OpenCode sends custom model option fields in the provider request body. When a model variant defines `cursorModel`, OpenCode merges the selected variant value into `body.cursorModel` before the request reaches `cursor-acp`.

The provider boundary resolves the runtime Cursor model in this order:

1. Use `body.cursorModel` when it is a non-empty string.
2. Otherwise normalize `body.model` by stripping the `cursor-acp/` provider prefix.
3. Fall back to `auto` when no model is available.

This lets a compact OpenCode model such as `cursor-acp/gpt-5.3-codex` call a concrete Cursor model like `gpt-5.3-codex-high` when the selected variant provides that mapping.

`open-cursor sync-models --variants` generates those compact entries from `cursor-agent models`. The default `sync-models` command still writes direct raw Cursor model IDs. Add `--compact` with `--variants` to remove raw model entries that were folded into generated variant groups while preserving custom and unknown entries.

Use `--dry-run` to preview the model sync without writing the config. Sync output includes added, updated, removed, priced, and skipped counts so repeated syncs are easy to audit before applying them.

Use `open-cursor sync-models --json` when automation needs the same sync summary as structured output. Use `open-cursor models --explain` to inspect the generated model families, default Cursor targets, variant mappings, and direct models without modifying the config.

Use `open-cursor doctor --deep` after install or sync to check Cursor model discovery, provider model config, compact variant presence, and whether configured `cursorModel` targets still exist in the current `cursor-agent models` output.

## Loop Safety and Error Handling

`v1` loop safety is driven by two mechanisms:

- Schema validation guard: tracks repeated schema-invalid calls by tool + schema signature.
- Tool-loop guard: tracks repeated calls using fingerprints with error class awareness.

The guard classifies outcomes (`validation`, `not_found`, `permission`, `timeout`, `tool_error`, `success`, `unknown`) and terminates repetitive loops before they spin indefinitely.

## Plugin Tool Hook Layer

The OpenCode plugin tool hook (`buildToolHookEntries` in `src/plugin.ts`) registers local tools (`bash`, `read`, `write`, `edit`, `grep`, `ls`, `glob`, `mkdir`, `rm`, `stat`) and compatibility aliases such as `shell -> bash`.

When tool-hook execution is used, path/cwd defaults are normalized against tool context (`worktree` / `directory`) to keep file and shell behavior workspace-aware.

In default `opencode` mode, OpenCode owns the native `write` tool. The plugin does not register its own native-name `write` hook in that mode, because duplicate native `write` handling can turn a successful OpenCode write into a plugin guard error. The plugin still exposes `oc_write` for compatibility paths and direct local-tool execution.

When debugging tool loops, isolate the failing boundary before changing behavior: the model may emit a malformed tool call, `cursor-agent` may transport an unexpected shape, the plugin may normalize or intercept it incorrectly, or OpenCode may execute/report it differently than the model expects. For post-tool stalls, first verify that a second turn containing the prior `role: "tool"` result can reach a normal assistant `stop`.

## Usage Metrics

`cursor-agent --output-format stream-json` emits a final `result` event with token usage when Cursor reports it. The proxy maps that payload to OpenAI-compatible usage so OpenCode can emit `step-finish` token data for tools such as OpenCode TokenSpeed Monitor.

Cursor fields are mapped as follows:

- `inputTokens + cacheReadTokens + cacheWriteTokens` -> `usage.prompt_tokens`
- `outputTokens` -> `usage.completion_tokens`
- `reasoningTokens` -> `usage.completion_tokens_details.reasoning_tokens`
- `cacheReadTokens` -> `usage.prompt_tokens_details.cached_tokens`
- `cacheWriteTokens` -> `usage.prompt_tokens_details.cache_write_tokens`

`prompt_tokens` includes cache tokens because OpenAI-compatible parsers treat `cached_tokens` as a subset of total prompt tokens.

Non-stream responses include `usage` on the chat completion response. Stream responses emit the normal final stop chunk, then a usage-only chunk with `choices: []`, then `[DONE]`.

If Cursor omits the final `result.usage` payload, the proxy omits `usage` instead of inventing zero-token metrics. This lets OpenCode and TokenSpeed fall back to their normal behavior without receiving misleading token counts.

Cost is passed through when a provider reports it as `cost`, `totalCost`, or `total_cost`. Cursor currently reports tokens but not request cost, so `open-cursor install` and `open-cursor sync-models` also write OpenCode `cost` config for known Cursor models using the official prices from [Cursor Models & Pricing](https://cursor.com/docs/models-and-pricing). Prices are stored per million tokens as `input`, `output`, `cache_read`, `cache_write`, and `context_over_200k` when Cursor documents a long-context rate.

Run `bun run check:pricing` to compare the current `cursor-agent models` output with the local official pricing map and warn when the Cursor pricing page markers change. Run `bun run check:pricing:fixture` for an offline fixture-based coverage check that does not require Cursor auth or network access.

## Operational Notes

- Proxy reuse is enabled by default (`CURSOR_ACP_REUSE_EXISTING_PROXY`); this can reuse an already-running process on port `32124`.
- During debugging or rollouts, disable reuse (`CURSOR_ACP_REUSE_EXISTING_PROXY=false`) or restart OpenCode to ensure the active proxy process matches the latest build.
- If `~/.config/opencode` is reset/wiped, reinstall or re-run model/config sync to restore provider config and plugin symlink.
