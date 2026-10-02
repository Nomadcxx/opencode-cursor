# OpenCode 2.0 setup

The package's default export serves both hosts: OpenCode 1.x calls its
`server()`, OpenCode 2.0 calls its `setup()`. On 2.0 the plugin uses
`ctx.provider.transform` and publishes Cursor models **in memory**.

## Install

```json
{
  "plugins": ["@rama_nigg/open-cursor"]
}
```

Pin a version if you want: `"@rama_nigg/open-cursor@x.y.z"`.

Use the bare package name. OpenCode 2.0 installs plugin specifiers with npm and
resolves the package's main export; it does not understand `exports` subpaths,
so `@rama_nigg/open-cursor/plugin/opencode2` fails with
`NpmInstallFailedError ... ENOENT ... package.json` (issue #135).

The config key is `plugins` on 2.0 (`plugin` on 1.x). Prefer a dedicated config
directory so 1.x `plugin` / `provider` entries and 2.0 `plugins` do not share
one file:

```bash
export OPENCODE_CONFIG_DIR=~/.config/opencode2
```

## Authenticate

Inside OpenCode 2.0, run `/connect`, choose **Cursor**, then enter an API key
from [cursor.com/settings](https://cursor.com/settings). `CURSOR_API_KEY` is
also picked up automatically via the integration `env` method.

## How it differs from OpenCode 1.x

| | OpenCode 1.x | OpenCode 2.0 |
|---|---|---|
| Config | `"plugin": ["@rama_nigg/open-cursor"]` | `"plugins": ["@rama_nigg/open-cursor"]` |
| Entry | default export `server()` | default export `setup()` (`src/plugin-opencode2.ts`) |
| Models | Written into `opencode.json` by installer / auto-refresh | In-memory `ctx.provider.transform` → `editor.add` → `reload()` |
| Auth | OpenCode 1 auth store / env | Integration key + `CURSOR_API_KEY` env |
| Backend | Local HTTP proxy + `@cursor/sdk` | Same proxy + SDK (unchanged) |
| Provider package | `@ai-sdk/openai-compatible` in config | `aisdk:@ai-sdk/openai-compatible` with `settings.baseURL` |

open-cursor still speaks openai-compatible HTTP to its local proxy. It does
**not** own Cursor's Connect-RPC agent protocol — that is a different project
([cursor-opencode-provider](https://github.com/oakimov/cursor-opencode-provider)).

After `/connect` or a credential switch, models are rediscovered with the
active Cursor key; until then the picker shows a small static fallback list.

## Tools

The OpenCode 2.0 entry registers **no plugin tools**. OpenCode 2.0 ships its
own permission-checked builtins (`read`, `shell`, `glob`, `grep`, `edit`,
`write`, `subagent`, …), and a plugin tool with the same name would replace the
builtin for every provider in that project.

The proxy keeps its default tool loop (`CURSOR_ACP_TOOL_LOOP_MODE=opencode`):
a Cursor tool call that matches a tool OpenCode advertised is returned to
OpenCode, which runs it with its own permission checks. Cursor `bash`-style
calls map onto OpenCode 2.0's `shell`. Calls that match nothing advertised run
inside Cursor.

## MCP tools

OpenCode 2.0 connects MCP servers itself (`mcp.servers` in `opencode.json`);
the plugin's own MCP bridge is not used on 2.0. The host puts MCP tools behind
a single Code Mode `execute` tool unless the server sets `codemode: false`, so
Cursor could not call them by name.

The plugin leaves server config alone (`codemode` also changes how OpenCode
connects to remote servers) and moves the tools of every server that does not
set `"codemode": true` onto the direct catalog. The tool registry is shared by
every provider in the project; set `"codemode": true` on a server to keep it
inside `execute`. The `opencode` namespace is never moved.

```json
{
  "mcp": {
    "servers": {
      "github": { "type": "local", "command": ["github-mcp-server", "stdio"] },
      "executor": { "type": "local", "command": ["my-executor"], "codemode": true }
    }
  }
}
```

`github` tools are called by name (for example `github_create_pull_request`);
`executor` stays inside `execute`. Cursor MCP calls named
`mcp__<server>__<tool>` are mapped to the matching `<server>_<tool>` host tool.
OpenCode connects MCP servers asynchronously, so a prompt sent right after
startup may not see a slow server's tools yet; the next turn does.

## Workspace directory

One OpenCode 2.0 daemon serves every project location through a single local
proxy. On each Cursor request the plugin sets `x-opencode-directory` (the
session's `location.directory`, falling back to the plugin location) through
the `session` `model.request` hook, and the proxy runs Cursor in that
directory. Without the header (OpenCode 1.x) the proxy uses the directory it
was started for.

## Safe transition from next-era / dump-era builds

If you previously used the dual-export root entry against OpenCode 2 **next**
(`ctx.catalog`) or relied on `providers.cursor-acp.models` written into
`opencode.json`:

1. Upgrade the package and use the bare `@rama_nigg/open-cursor` specifier
   under `plugins`.
2. Remove any leftover `providers.cursor-acp` (or `provider.cursor-acp`) model
   dump from the 2.0 config file so it cannot fight the in-memory inventory.
3. Restart the OpenCode 2.0 daemon / TUI.
4. `/connect` → **Cursor** if models are missing after the switch.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `failed to load plugin … NpmInstallFailedError … ENOENT … package.json` | The specifier is an `exports` subpath (`…/plugin/opencode2`). Use the bare `@rama_nigg/open-cursor`. |
| `TypeError: … 'ctx.catalog.transform'` | The installed package is 2.5.9 or older. Upgrade (`opencode plugin update`). |
| No Cursor models in the picker | Confirm `/connect` → **Cursor** (or `CURSOR_API_KEY`). Filter by provider **Cursor** (`time.released` is `0`). |
| Requests hit a stale proxy port | Restart after plugin reload so `settings.baseURL` matches the live proxy. Remove conflicting `providers.cursor-acp` overlays. |
| Only Auto / Composer models after `/connect` | Discovery reruns on credential events; restart the daemon if the host did not emit one. |
| Cursor cannot find an MCP tool | The server sets `"codemode": true`, so its tools stay inside `execute`. Remove it to put them on the direct catalog. See [MCP tools](#mcp-tools). |
| Cursor edits files in the wrong project | The `model.request` hook sets `x-opencode-directory` per session; check the proxy log for the header and restart the daemon. |
