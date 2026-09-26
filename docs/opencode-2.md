# OpenCode 2.0 setup

Dedicated entrypoint: `@rama_nigg/open-cursor/plugin/opencode2`.

Do **not** also load the classic root package entry under OpenCode 2.0 — that
path targets OpenCode 1.x (and the next-era `ctx.catalog` dual export). Stable
OpenCode 2.0 removed `ctx.catalog`; the dedicated entry uses
`ctx.provider.transform` and publishes Cursor models **in memory**.

## Install

```json
{
  "plugin": ["@rama_nigg/open-cursor/plugin/opencode2"]
}
```

Pin a version if you want: `"@rama_nigg/open-cursor@2.5.8/plugin/opencode2"`.

Prefer a dedicated config directory so 1.x `plugin` / `provider` entries and
2.0 `plugins/` do not share one file:

```bash
export OPENCODE_CONFIG_DIR=~/.config/opencode2
```

## Authenticate

Inside OpenCode 2.0, run `/connect`, choose **Cursor**, then enter an API key
from [cursor.com/settings](https://cursor.com/settings). `CURSOR_API_KEY` is
also picked up automatically via the integration `env` method.

## How it differs from OpenCode 1.x

| | OpenCode 1.x (root entry) | OpenCode 2.0 (`plugin/opencode2`) |
|---|---|---|
| Load path | `@rama_nigg/open-cursor` | `@rama_nigg/open-cursor/plugin/opencode2` |
| Models | Written into `opencode.json` by installer / auto-refresh | In-memory `ctx.provider.transform` → `editor.add` → `reload()` |
| Auth | OpenCode 1 auth store / env | Integration key + `CURSOR_API_KEY` env |
| Backend | Local HTTP proxy + `@cursor/sdk` | Same proxy + SDK (unchanged) |
| Provider package | `@ai-sdk/openai-compatible` in config | `aisdk:@ai-sdk/openai-compatible` with `settings.baseURL` |

open-cursor still speaks openai-compatible HTTP to its local proxy. It does
**not** own Cursor's Connect-RPC agent protocol — that is a different project
([cursor-opencode-provider](https://github.com/oakimov/cursor-opencode-provider)).

## Safe transition from next-era / dump-era builds

If you previously used the dual-export root entry against OpenCode 2 **next**
(`ctx.catalog`) or relied on `providers.cursor-acp.models` written into
`opencode.json`:

1. Switch the plugin string to `/plugin/opencode2` only.
2. Remove any leftover `providers.cursor-acp` (or `provider.cursor-acp`) model
   dump from the 2.0 config file so it cannot fight the in-memory inventory.
3. Restart the OpenCode 2.0 daemon / TUI.
4. `/connect` → **Cursor** if models are missing after the switch.

## Troubleshooting

| Symptom | Fix |
|---|---|
| No Cursor models in the picker | Confirm `/connect` → **Cursor** (or `CURSOR_API_KEY`). Load **only** `/plugin/opencode2`. Filter by provider **Cursor** (`time.released` is `0`). |
| Requests hit a stale proxy port | Restart after plugin reload so `settings.baseURL` matches the live proxy. Remove conflicting `providers.cursor-acp` overlays. |
| Tools missing from the model | Ensure `CURSOR_ACP_ENABLE_OPENCODE_TOOLS` is not `false`. MCP bridge defaults on (`CURSOR_ACP_MCP_BRIDGE`). |
| Still on catalog-era errors (`ctx.catalog`) | You are loading the root dual export. Switch to `/plugin/opencode2`. |
