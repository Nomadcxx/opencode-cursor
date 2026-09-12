# kilo-cursor-plugin

Transparent bridge between **Kilo Code** and **cursor-agent**, based on [opencode-cursor](https://github.com/Nomadcxx/opencode-cursor).

Kilo is an OpenCode fork. This plugin reuses the same architecture (proxy, streaming, tool loop, `@kilocode/plugin` hooks) with Kilo-specific config, OAuth, and MCP.

Reference: [Kilo Plugins](https://kilo.ai/docs/automate/extending/plugins)

## What it does

- Connects Cursor subscription models to Kilo via `cursor-agent` or `@cursor/sdk` (API key)
- **OAuth PKCE** via `kilo auth login --provider cursor` (JWT → cursor-agent; `sk-...` API key → SDK)
- **Maps native tools**: `glob`, `read`, `websearch`, `bash`, and similar Cursor calls → Kilo tools
- **MCP catalog on Kilo names**: `GetDynamicTools` / `GetMcpTools` list the same names Kilo executes (`openviking_search`, `context7_query-docs`, `browser-harness_browser_list_tabs`). No `mcp__` prefix in the visible catalog
- **Hybrid tool snapshot**: polls MCP while servers are pending, then fingerprint-caches `chat.params` so late tools appear without a Kilo reload
- **Session resume** (cursor-agent, on by default): keyed per Kilo session; Cursor chat is reset after Kilo compaction so context-usage % does not stick
- **OpenAI-compatible usage** on final responses (omitted on intermediate `tool_calls` chunks)
- **Subagents**: Cursor `Task` calls are guided to Kilo subagents instead of Cursor-native task types
- **Model sync**: authenticated catalog with fast/standard tiers, pricing, and `limit.context` / `limit.output`
- Hooks: `tool`, `auth`, `chat.params`, `experimental.chat.system.transform`

## Prerequisites

- [Kilo Code](https://kilo.ai) CLI ≥ 7.0 or the VS Code extension
- A Cursor subscription and authentication

```bash
curl -fsS https://cursor.com/install | bash
kilo auth login --provider cursor
# or: cursor-agent login  /  CURSOR_API_KEY=sk-...
```

## Install

### Option 1 — official Kilo command (recommended)

```bash
kilo plugin kilo-cursor-plugin --global
kilo-cursor install --skip-models
kilo-cursor sync-models
```

### Option 2 — this package’s CLI

```bash
npm install -g kilo-cursor-plugin
kilo-cursor install
kilo-cursor sync-models
```

### Option 3 — local development

```bash
bun install && bun run build
kilo-cursor install
# or symlink local-kilo/.kilo/kilo.jsonc → dist/plugin-entry.js
```

### Resulting config (~/.config/kilo/kilo.jsonc)

```jsonc
{
  "$schema": "https://app.kilo.ai/config.json",
  "plugin": ["kilo-cursor-plugin"],
  "provider": {
    "cursor": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Cursor",
      "options": {
        "baseURL": "http://127.0.0.1:32124/v1"
      },
      "models": { /* sync via kilo-cursor sync-models */ }
    }
  }
}
```

> **IDs:** `"kilo-cursor-plugin"` in the `plugin` array loads the plugin; `"cursor"` under `provider` registers the model provider (internal provider ID: `cursor`). JSONC comments and trailing commas are accepted when syncing models.

## Usage

```bash
kilo run "Summarize this repo" --model cursor/auto
kilo auth login --provider cursor
```

Pick `cursor/*` in the model picker (reasoning-effort variants when the catalog exposes them).

## Native tool bridge

```
cursor-agent ──glob/read/bash──► proxy (intercept) ──► Kilo executes natively
```

Default mode: `CURSOR_KILO_TOOL_LOOP_MODE=opencode` — Kilo owns the tool list; the plugin only translates `stream-json` → OpenAI `tool_calls`.

## MCP bridge

Two complementary paths. Visible names always match Kilo: `<server>_<tool>`, keeping hyphens (`context7_query-docs`, `openviking_search`, `browser-harness_browser_list_tabs`).

### 1. Passthrough (always on)

MCP registered **in Kilo** (panel, plugins such as OpenViking, `client.mcp.tool.list()` / `client.tool.ids()`):

| Kilo (execution + catalog) | Hidden remap (allowlist only) |
|----------------------------|-------------------------------|
| `context7_resolve-library-id` | `mcp__context7__resolve_library_id` |

- `chat.params` merges tools through a **hybrid snapshot** (`src/mcp/tool-snapshot.ts`): poll while MCP servers are `connecting`/`pending`, then reuse a fingerprint cache
- **`GetDynamicTools`** (and Cursor `GetMcpTools`) returns that catalog, including when Composer queries namespace `"cursor"`. Kilo natives (`agent_manager`, `background_process`, …) and OpenViking `viking_*` wrappers stay on the request/prompt, not in this MCP list
- Hyphen vs underscore aliases collapse to the hyphenated Kilo name (`context7_query-docs`, not both)
- If `mcp.tool.list()` is still empty, the catalog is filled from `client.tool.ids()` and tools already on the proxy wire (plugin MCP such as `openviking_*`)
- **`skill` / `skill_mcp`**: backfilled into `chat.params` and intercepted even as `unknownToolCall`. Call with `skill({ name: "<id>" })` — `name` is required. `CallDynamicTool({ namespace: "kilo", toolName: "skill", arguments: { name } })` is a fallback remap. Listed under **Kilo core tools** in `GetDynamicTools`
- **`CallDynamicTool`** remaps to the Kilo name, including Composer envelopes (`tool_call.function`, `unknownToolCall`). Namespace `"cursor"` (`CreateGoal`, `GenerateImage`, `UpdateGoal`) still runs natively
- Native cursor-agent MCP is always denied via `.cursor/cli.json` `deny: ["Mcp(*:*)"]` (Write/Shell/Edit/Delete are denied only when direct MCP is off)

### 2. Direct MCP (default ON)

Connects servers declared in `kilo.jsonc` → `mcp` over stdio and registers plugin tool hooks:

```jsonc
{
  "mcp": {
    "my-server": {
      "type": "local",
      "command": ["npx", "-y", "my-mcp-server"]
    }
  }
}
```

Disable with `CURSOR_KILO_DIRECT_MCP=false` (legacy alias: `CURSOR_KILO_MCP_BRIDGE=false`).

## Session resume and usage

- **Resume** (`CURSOR_KILO_SESSION_RESUME`, default on, cursor-agent only): maps a Kilo tab to a Cursor `--resume` chat ID. Isolated per Kilo session ID so two chats in the same workspace do not share Cursor state
- After **Kilo compaction**, the cached Cursor chat is dropped so the next turn starts a fresh context window (usage % does not carry over)
- **Usage** is emitted in OpenAI-compatible form on the final assistant response; intermediate `tool_calls` chunks omit usage so Kilo does not double-count tokens

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `CURSOR_KILO_TOOL_LOOP_MODE` | `opencode` | `opencode` \| `proxy-exec` \| `off` |
| `CURSOR_KILO_DIRECT_MCP` | `true` | stdio bridge from `kilo.jsonc` `mcp` |
| `CURSOR_KILO_MCP_BRIDGE` | — | Legacy alias of `CURSOR_KILO_DIRECT_MCP` |
| `CURSOR_KILO_MCP_DISCOVERY` | `true` | Poll `mcp.status` until servers settle |
| `CURSOR_KILO_MCP_DISCOVERY_MAX_WAIT_MS` | `2000` | Max wait while MCP is pending |
| `CURSOR_KILO_MCP_DISCOVERY_POLL_MS` | `200` | Poll interval |
| `CURSOR_KILO_MCP_DISCOVERY_STABLE_POLLS` | `2` | Consecutive settled polls required |
| `CURSOR_KILO_SESSION_RESUME` | `true` | cursor-agent `--resume` cache |
| `CURSOR_KILO_BACKEND` | `auto` | `auto` \| `cursor-agent` \| `sdk` |
| `CURSOR_KILO_BRIDGE_JSON` | `true` | JSON bridge for the `write` tool |
| `CURSOR_KILO_PROVIDER_BOUNDARY` | `v1` | Tool-intercept boundary |
| `KILO_PURE=1` | — | Disable external plugins (Kilo docs) |

The legacy `CURSOR_ACP_*` prefix is still read in several places.

## Commands

```bash
kilo-cursor install       # cursor provider + plugin
kilo-cursor sync-models   # authenticated models (Kilo OAuth / API key)
kilo-cursor status
kilo-cursor doctor
mcptool tools             # debug direct MCP bridge
kilo-cursor uninstall
```

## Further documentation

| File | Contents |
|---|---|
| [docs/architecture/runtime-tool-loop.md](docs/architecture/runtime-tool-loop.md) | Tool loop, boundary, bridge JSON |
| [docs/cursor-agent-tools.md](docs/cursor-agent-tools.md) | cursor-agent tool inventory |
| [docs/architecture/cursor-acp-mcp-future.md](docs/architecture/cursor-acp-mcp-future.md) | ACP/MCP roadmap (reference) |

Docs under `docs/architecture/*` whose names start with `opencode` or `cursor-acp` describe the upstream fork or historical decisions. The Kilo runtime uses `CURSOR_KILO_*` and provider ID `cursor`.

## Development

```bash
bun install
bun run build
bun test
kilo --print-logs --log-level DEBUG
```

After changing `src/`, rebuild (`bun run build`) and restart Kilo. If the plugin is installed from `~/.config/kilo/plugin/kilo-cursor-plugin`, copy sources there and rebuild that copy — Kilo loads `dist/plugin-entry.js`, not TypeScript.

## License

BSD-3-Clause
