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

The config key is `plugins` on 2.0 (`plugin` on 1.x). If you no longer run
1.x, remove its `plugin` entry and `provider.cursor-acp` block (see
[Safe transition](#safe-transition-from-next-era--dump-era-builds)). If you run
both hosts, give 2.0 its own config directory so they do not share one file:

```bash
export OPENCODE_CONFIG_DIR=~/.config/opencode2
```

## Authenticate

A logged-in `cursor-agent` (`cursor-agent login`) is enough; nothing needs to
be stored in OpenCode. To log in from OpenCode instead, run `opencode auth login`
(or `/connect`), choose **Cursor**, then either:

- **Log in with cursor-agent (browser)** — if `cursor-agent` is already logged
  in, this connects at once. Otherwise it runs `cursor-agent login` and OpenCode
  shows Cursor's sign-in link (open it with Enter or `o` in the TUI). It stores
  a marker labelled `cursor-agent (<email>)`, not a token: cursor-agent keeps
  and renews its own login, and requests run through it. This is an `oauth`
  method, so OpenCode Desktop offers it too; or
- **API key** — a key from [cursor.com/settings](https://cursor.com/settings).
  `CURSOR_API_KEY` is also picked up via the integration `env` method.

Do not store a made-up key to get past the prompt. Placeholders written by
older 1.x logins (`cursor-agent`, `cursor-auth`, `cursor-agent-auth`,
`cursor-agent-handles-auth-separately`) are ignored.

With `CURSOR_ACP_BACKEND=auto` (the default), a key selects the SDK backend
on 2.0 even when `cursor-agent` is installed. Before a key's first SDK request
the plugin lists models with it once; if Cursor rejects it and `cursor-agent`
is installed, requests use `cursor-agent` and the log records a warning. A
rejection expires after 10 minutes, then the key is checked again. A key from
`CURSOR_API_KEY` is not checked and never falls back: `cursor-agent` reads that
variable too, so a rejected env key fails both backends — unset it. Set `CURSOR_ACP_BACKEND=cursor-agent`
to force the CLI, or `sdk` to require a key. OpenCode 1.x keeps its CLI-first
`auto` behavior. The plugin sends credentials with each request to its private
proxy; it does not share the 1.x stored-key cache.

For a background service, set environment variables on the service and restart it:

```text
opencode2 service set env CURSOR_ACP_BACKEND sdk
opencode2 service restart
```

## How it differs from OpenCode 1.x

| | OpenCode 1.x | OpenCode 2.0 |
|---|---|---|
| Config | `"plugin": ["@rama_nigg/open-cursor"]` | `"plugins": ["@rama_nigg/open-cursor"]` |
| Entry | default export `server()` | default export `setup()` (`src/plugin-opencode2.ts`) |
| Models | Written into `opencode.json` by installer / auto-refresh | In-memory `ctx.provider.transform` → `editor.add` → `reload()` |
| Auth | OpenCode 1 auth store / env | Integration key + `CURSOR_API_KEY` env |
| Backend | Local proxy, CLI-first under `auto` | Private proxy, SDK-first with a key under `auto` |
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

The SDK's native `edit` events are an exception: they contain only a file path,
and Cursor applies the change itself. The proxy lets these SDK events finish
without replaying the edit in OpenCode. OpenCode's edit permission prompts and
native patch preview do not cover these edits. This exception requires an SDK
event with a valid path; CLI events and malformed edit arguments still go
through the normal validation path. See [tool ownership](architecture/runtime-tool-loop.md#cursor-native-tool-side-effects).

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
directory. The 2.0 proxy binds an ephemeral port and the request hook pins its
URL, so a shared config pointing at the 1.x port 32124 cannot redirect 2.0
requests. OpenCode 1.x uses its own proxy's startup directory.

When using the CLI backend in an untrusted workspace, headless requests can
stop at Cursor's trust prompt. Trust the workspace in Cursor first, or set
`CURSOR_ACP_TRUST_WORKSPACE=true` to pass `--trust` for headless CLI requests.
This opt-in also applies to the pooled runner. The plugin does not grant
workspace trust by default.

On Windows, the plugin invokes an installed `cursor-agent.ps1` sibling with
`powershell.exe -NoProfile -ExecutionPolicy Bypass -File`, matching the flags
in Cursor's batch launcher. This bypass applies to that child process; it does
not change the machine's execution policy. Arguments stay separate from the
script path. Skipping the batch launcher preserves literal `!` in workspace paths.

## Safe transition from next-era / dump-era builds

If you previously used the dual-export root entry against OpenCode 2 **next**
(`ctx.catalog`) or relied on `providers.cursor-acp.models` written into
`opencode.json`:

1. Upgrade the package and use the bare `@rama_nigg/open-cursor` specifier
   under `plugins`. Delete `~/.config/opencode/plugin/cursor-acp.js` if the
   1.x installer created it: 2.x still loads that file, so a second (often
   older) copy runs beside the npm package.
2. Remove any leftover `providers.cursor-acp` (or `provider.cursor-acp`) model
   dump from the 2.0 config file so it cannot fight the in-memory inventory.
3. Restart the OpenCode 2.0 daemon / TUI.
4. `/connect` → **Cursor** if models are missing after the switch.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `failed to load plugin … NpmInstallFailedError … ENOENT … package.json` | The specifier is an `exports` subpath (`…/plugin/opencode2`). Use the bare `@rama_nigg/open-cursor`. |
| `TypeError: … 'ctx.catalog.transform'` | The installed package is 2.5.9 or older. Upgrade (`opencode plugin update`). |
| `cursor-agent exited with code 1 and no output` | A second copy is loaded from `~/.config/opencode/plugin/cursor-acp.js`. Delete it (`open-cursor doctor` flags it). |
| `Location plugins did not finish activating` | OpenCode 2.x gives plugins 5 seconds to activate after the background service starts. Run the command again once the service is up (`opencode service status`). A leftover 1.x plugin file makes the cold start slower. |
| `Pass a credential ID or label when running without an interactive terminal` | Name the credential: `opencode auth logout cursor-acp <label>`, with the label from `opencode auth list`. |
| `cursor-acp error: Cursor rejected the API key` | The stored key is invalid. `opencode auth logout cursor-acp`, then log in with **Log in with cursor-agent (browser)** or a real key. With `CURSOR_ACP_BACKEND=auto` and `cursor-agent` installed this only shows when `CURSOR_ACP_BACKEND=sdk` or the key is in `CURSOR_API_KEY` (unset it). |
| No Cursor models in the picker | Confirm `/connect` → **Cursor** (or `CURSOR_API_KEY`). Filter by provider **Cursor** (`time.released` is `0`). |
| Requests hit a stale proxy port | Restart after plugin reload so `settings.baseURL` matches the live proxy. Remove conflicting `providers.cursor-acp` overlays. |
| Only Auto / Composer models after `/connect` | Discovery reruns on credential events; restart the daemon if the host did not emit one. |
| Cursor cannot find an MCP tool | The server sets `"codemode": true`, so its tools stay inside `execute`. Remove it to put them on the direct catalog. See [MCP tools](#mcp-tools). |
| Cursor edits files in the wrong project | The `model.request` hook sets `x-opencode-directory` per session; check the proxy log for the header and restart the daemon. |

## SDK runtime and local state

The SDK backend requires Node 22.13 or newer. The plugin checks the executable
selected by `CURSOR_ACP_NODE_BIN` (default `node`) before starting the SDK runner.
The CLI backend does not inherit that SDK requirement.

On Windows, SDK state lives under `~/.cursor/oc-sdk/<workspace hash>` to keep
SQLite paths short. `CURSOR_ACP_SDK_STATE_ROOT` selects another short writable
root on any platform. Workspace tools continue to use the original project path.
Concurrent requests share a store; the runner closes it after the final request
finishes agent cleanup. An open failure stops the turn with the path and a
remediation message, before the agent can run. The runner does not silently
fall back to another data directory. If the SDK lacks the SQLite export, the
compatibility path keeps the SDK default and logs that limitation.
