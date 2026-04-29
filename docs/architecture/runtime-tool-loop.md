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
7. Prompt builder renders tool results into `TOOL_RESULT (call_id: ...)` blocks for the next `cursor-agent` invocation.

## Tool Ownership Model

### `opencode` mode (default)

- OpenCode owns execution of the active tool list.
- In `chat.params`, existing OpenCode tool definitions are preserved and passed through.
- `cursor-acp` does not execute SDK/MCP tools in this mode; it translates tool-call protocol boundaries.

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

## Operational Notes

- Proxy reuse is enabled by default (`CURSOR_ACP_REUSE_EXISTING_PROXY`); this can reuse an already-running process on port `32124`.
- During debugging or rollouts, disable reuse (`CURSOR_ACP_REUSE_EXISTING_PROXY=false`) or restart OpenCode to ensure the active proxy process matches the latest build.
- If `~/.config/opencode` is reset/wiped, reinstall or re-run model/config sync to restore provider config and plugin symlink.
