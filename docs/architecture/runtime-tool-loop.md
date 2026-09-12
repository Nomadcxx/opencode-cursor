# Runtime Architecture: Cursor Agent + Kilo Tool Loop

This document describes the current runtime architecture with default settings:

- `CURSOR_KILO_TOOL_LOOP_MODE=opencode`
- `CURSOR_KILO_PROVIDER_BOUNDARY=v1`
- `CURSOR_KILO_PROVIDER_BOUNDARY_AUTOFALLBACK=true`

Legacy env prefix `CURSOR_ACP_*` is still accepted as an alias.

## High-Level Flow

1. Kilo sends chat requests to the `cursor` provider (`/v1/chat/completions` → local proxy `:32124`).
2. The plugin proxy spawns `cursor-agent` (or `@cursor/sdk` when backend is `sdk`) and streams NDJSON (`stream-json`).
3. Assistant text/thinking streams back to Kilo as SSE.
4. `tool_call` events are intercepted at the provider boundary.
5. Intercepted calls are normalized and returned as OpenAI `tool_calls`.
6. Kilo executes tools locally and sends results as `role: "tool"` messages on the next turn.
7. Prompt builder renders tool results into `TOOL_RESULT (name: ..., call_id: ...)` blocks.

## Tool Ownership Model

### `opencode` mode (default)

- Kilo owns execution of the active tool list.
- In `chat.params`, Kilo-provided tool definitions are preserved and augmented (MCP aliases, native MCP merge).
- The plugin does not execute SDK/MCP tools in this mode; it translates tool-call protocol boundaries.

### Cursor-native tool side effects

The `cursor-agent --print --output-format stream-json` path can still execute Cursor-native tools inside the subprocess unless blocked via `.cursor/cli.json`. The passthrough MCP bridge writes `deny: ["Mcp(*:*)"]` when direct MCP is disabled; native filesystem tools may still run if not denied.

### Cursor bridge JSON

Enabled by default (`CURSOR_KILO_BRIDGE_JSON`, legacy `CURSOR_ACP_BRIDGE_JSON`). When Kilo offers `write`, the proxy can accept a single JSON object `{"name":"write","arguments":{...}}` and convert it to an OpenAI `write` tool call.

Set `CURSOR_KILO_BRIDGE_JSON=0` to disable.

### `proxy-exec` mode (legacy)

- Plugin injects tool definitions and can execute via internal router (local, SDK, MCP).
- Used for compatibility only.

### `off` mode

- Tool-loop interception disabled.

## MCP Bridge (Kilo adaptation)

Two layers:

1. **Passthrough (always on)** — Kilo-registered MCP tools (`context7_*`, `openviking_*`, etc.):
   - Merged from `client.mcp.tool.list()` in `chat.params` via hybrid snapshot (`src/mcp/tool-snapshot.ts`)
   - **Cache hit** when tool fingerprint is unchanged (one `mcp.tool.list()` per request, no re-merge)
   - **Poll + settle** only while `mcp.status` reports servers `connecting`/`pending` (bootstrap for async plugin MCP registration)
   - Aliases `mcp__server__tool` added for the cursor-agent prompt
   - Interception maps `mcp__*` / `CallMcpTool` back to Kilo native names
   - Blocks `GetMcpTools` passthrough; cursor-agent has no MCP servers in this mode
   - Env: `CURSOR_KILO_MCP_DISCOVERY` (default on), `CURSOR_KILO_MCP_DISCOVERY_MAX_WAIT_MS`, `CURSOR_KILO_MCP_DISCOVERY_POLL_MS`, `CURSOR_KILO_MCP_DISCOVERY_STABLE_POLLS`

2. **Direct MCP (default ON)** — `CURSOR_KILO_DIRECT_MCP` (legacy `CURSOR_KILO_MCP_BRIDGE`):
   - Reads `mcp` section from `kilo.jsonc`, connects via stdio, registers plugin tool hooks
   - Set `CURSOR_KILO_DIRECT_MCP=false` to disable

Implementation: `src/mcp/kilo-bridge.ts`, `src/mcp/tool-snapshot.ts`, `src/kilo/cursor-cli-bridge.ts`, `src/proxy/tool-loop.ts`.

## Provider Boundary (`legacy` vs `v1`)

Implemented in `src/provider/boundary.ts` and `src/provider/runtime-interception.ts`.

- `v1` (default): shared extraction/interception for Bun + Node proxy handlers.
- `legacy`: previous behavior; optional autofallback.

Features: alias resolution, schema compat, edit→write reroute, tool-loop guard.

## Model Variant Resolution

Kilo sends `cursorModel` in request options when a model variant defines `options.cursorModel`. The plugin resolves wire model from catalog + reasoning effort (`src/models/runtime-catalog.ts`). Effort may arrive as Kilo `message.model.variant`, `reasoning.effort`, or OpenAI-compatible `reasoning_effort` on the proxy body.

Model sync: `kilo-cursor sync-models` (authenticated via Kilo auth store).

## Auth

- OAuth JWT (Kilo auth store) → `cursor-agent` backend
- API key `sk-...` → `@cursor/sdk` backend when `CURSOR_KILO_BACKEND=auto|sdk`
- Login: `kilo auth login --provider cursor`

## Loop Safety and Error Handling

See `src/provider/tool-loop-guard.ts` and `src/provider/runtime-interception.ts`.

## Usage reporting

Cursor `result.usage` is mapped to OpenAI-compatible `usage` on each provider response. Kilo records a `step-finish` per HTTP round-trip in the tool loop; intermediate `finish_reason: tool_calls` responses **omit** the usage chunk so inflated per-step cache counts do not spike the context meter. Usage is emitted only on the final `stop` response for that round.

## Operational Notes

- Proxy default: `http://127.0.0.1:32124/v1`
- Reuse: `CURSOR_KILO_REUSE_EXISTING_PROXY` (default true)
- Logs: `CURSOR_KILO_LOG_LEVEL`, `CURSOR_KILO_LOG_DIR`
- After config wipe, re-run `kilo-cursor install` and `sync-models`
