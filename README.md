![header](docs/header.png)

<p align="center">
  <img src="https://img.shields.io/badge/Linux-FCC624?style=for-the-badge&logo=linux&logoColor=black" alt="Linux" />
  <img src="https://img.shields.io/badge/macOS-000000?style=for-the-badge&logo=apple&logoColor=white" alt="macOS" />
  <img src="https://img.shields.io/badge/Windows-0078D6?style=for-the-badge&logo=windows&logoColor=white" alt="Windows" />
</p>

No prompt limits. No broken streams. Full thinking + tool support in OpenCode. Your Cursor subscription, properly integrated.

## Installation

### Option A — One-line installer

**Linux & macOS:**
```bash
curl -fsSL https://raw.githubusercontent.com/Nomadcxx/opencode-cursor/main/install.sh | bash
```

**Windows:**
```powershell
npm install -g @rama_nigg/open-cursor
open-cursor install
```

Then authenticate and verify:
```bash
cursor-agent login
opencode models | grep cursor-acp
```

### Option B — npm global + CLI

```bash
npm install -g @rama_nigg/open-cursor
open-cursor install
```

Upgrade: `npm update -g @rama_nigg/open-cursor`

<details>
<summary><b>Option C</b> — Add to opencode.json</summary>

Add to `~/.config/opencode/opencode.json` (or `%USERPROFILE%\.config\opencode\opencode.json` on Windows):

```json
{
  "plugin": ["@rama_nigg/open-cursor@latest"],
  "provider": {
    "cursor-acp": {
      "name": "Cursor ACP",
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "http://127.0.0.1:32124/v1"
      },
      "models": {
        "cursor-acp/auto":              { "name": "Auto" },

        "cursor-acp/claude-opus-4-8":   { "name": "Claude Opus 4.8" },
        "cursor-acp/claude-opus-4-7":   { "name": "Claude 4.7 Opus" },
        "cursor-acp/claude-4.6-opus":   { "name": "Claude 4.6 Opus" },
        "cursor-acp/claude-4.6-sonnet": { "name": "Claude 4.6 Sonnet" },
        "cursor-acp/claude-4.5-opus":   { "name": "Claude 4.5 Opus" },
        "cursor-acp/claude-4.5-sonnet": { "name": "Claude 4.5 Sonnet" },
        "cursor-acp/claude-4.5-haiku":  { "name": "Claude 4.5 Haiku" },
        "cursor-acp/claude-4-sonnet":   { "name": "Claude 4 Sonnet" },

        "cursor-acp/gpt-5.5":           { "name": "GPT-5.5" },
        "cursor-acp/gpt-5.4":           { "name": "GPT-5.4" },
        "cursor-acp/gpt-5.4-mini":      { "name": "GPT-5.4 Mini" },
        "cursor-acp/gpt-5.4-nano":      { "name": "GPT-5.4 Nano" },
        "cursor-acp/gpt-5.3-codex":     { "name": "GPT-5.3 Codex" },
        "cursor-acp/gpt-5.2":           { "name": "GPT-5.2" },
        "cursor-acp/gpt-5.2-codex":     { "name": "GPT-5.2 Codex" },
        "cursor-acp/gpt-5.1-codex":     { "name": "GPT-5.1 Codex" },
        "cursor-acp/gpt-5.1-codex-max": { "name": "GPT-5.1 Codex Max" },
        "cursor-acp/gpt-5.1-codex-mini":{ "name": "GPT-5.1 Codex Mini" },
        "cursor-acp/gpt-5-mini":        { "name": "GPT-5 Mini" },

        "cursor-acp/gemini-3.1-pro":    { "name": "Gemini 3.1 Pro" },
        "cursor-acp/gemini-3-pro":      { "name": "Gemini 3 Pro" },
        "cursor-acp/gemini-3-flash":    { "name": "Gemini 3 Flash" },

        "cursor-acp/composer-2":        { "name": "Composer 2" },
        "cursor-acp/composer-2-fast":   { "name": "Composer 2 Fast" },
        "cursor-acp/composer-1.5":      { "name": "Composer 1.5" },

        "cursor-acp/claude-fable-5":    { "name": "Claude Fable 5" },

        "cursor-acp/grok-4-20":         { "name": "Grok 4.20" },
        "cursor-acp/kimi-k2.5":         { "name": "Kimi K2.5" }
      }
    }
  }
}
```

> **Refresh models anytime** with the bundled CLI:
> ```bash
> open-cursor sync-models                       # plain list
> open-cursor sync-models --variants --compact  # group thinking / fast / -low/-high variants under each base
> ```
> The `--variants --compact` form is recommended — it folds dozens of `*-thinking-fast`, `*-high-fast`, etc. into a single entry per family with a `variants` map, and includes `cost` from the official Cursor pricing table so OpenCode TokenSpeed can render usage correctly.
</details>

<details>
<summary><b>Option D</b> — Go TUI installer</summary>

```bash
git clone https://github.com/Nomadcxx/opencode-cursor.git
cd opencode-cursor
go build -o ./installer ./cmd/installer && ./installer
```
</details>

<details>
<summary><b>Option E</b> — LLM paste</summary>

```
Install open-cursor for OpenCode: edit ~/.config/opencode/opencode.json, add "@rama_nigg/open-cursor@latest" to "plugin", add a "cursor-acp" provider with npm "@ai-sdk/openai-compatible" and a baseURL of http://127.0.0.1:32124/v1. Populate models by running `open-cursor sync-models --variants --compact` after install (or copy the model list from the README). Auth: `cursor-agent login`. Verify: `opencode models | grep cursor-acp`.
```
</details>

<details>
<summary><b>Option F</b> — Development (from source)</summary>

```bash
git clone https://github.com/Nomadcxx/opencode-cursor.git
cd opencode-cursor
./scripts/install-plugin.sh
```

Verify: `opencode models | grep cursor-acp`
</details>

## Authentication

Most users:
```bash
cursor-agent login
```

Or via OpenCode:
```bash
opencode auth login --provider cursor-acp
```

<details>
<summary><b>SDK backend auth</b> (only if using <code>CURSOR_ACP_BACKEND=sdk</code> or SDK fallback)</summary>

Set a real Cursor API key from [cursor.com/settings](https://cursor.com/settings):

```bash
export CURSOR_API_KEY=<your-api-key>
```

Other supported methods (priority order): OpenCode auth store (`opencode auth login --provider cursor-acp`), or `apiKey` in the `cursor-acp` provider options in `opencode.json`.

Do not use the historical `cursor-agent` placeholder string as an SDK key.
</details>

## Usage

```bash
opencode run "your prompt" --model cursor-acp/auto
opencode run "your prompt" --model cursor-acp/sonnet-4.5
```

## MCP Tool Bridge

Any MCP servers already configured in your `opencode.json` work automatically with cursor-acp models — no extra setup needed. The plugin discovers them at startup and injects usage instructions into the system prompt so the model calls them via cursor-agent's Shell tool.

`mcptool` is a shell CLI, so opencode applies your `bash` permission rules to `mcptool call ...`. If you rely on MCP tools asking for confirmation, keep `bash` as `ask` or add explicit `ask`/`deny` rules for `mcptool call *`.

```bash
mcptool servers                                    # list discovered servers
mcptool tools [server]                             # list available tools
mcptool call hybrid-memory memory_stats            # call a tool manually
mcptool call playwright browser_navigate '{"url":"https://example.com"}'
```

Any MCP server using stdio transport works. Tested with hybrid-memory, @modelcontextprotocol/server-filesystem, @playwright/mcp, and @modelcontextprotocol/server-everything.

## Architecture

```mermaid
flowchart TB
    OC["OpenCode"] --> SDK["@ai-sdk/openai-compatible"]
    SDK -->|"POST /v1/chat/completions"| PROXY["open-cursor proxy :32124"]
    PROXY -->|"spawn persistent"| RUNNER["Node runner: sdk-runner.mjs"]
    RUNNER -->|"stdin: {model, prompt, cwd}"| CURSORSDK["@cursor/sdk Agent.create + send()"]
    CURSORSDK -->|"HTTPS"| CURSOR["Cursor API"]
    CURSOR --> CURSORSDK

    CURSORSDK -->|"stdout: NDJSON StreamJsonEvent"| PARSER["Parse + convert to SSE"]
    PARSER -->|"assistant / thinking events"| SSE["SSE content chunks"]
    PARSER -->|"tool_call event"| BOUNDARY["Provider boundary (v1 default)"]
    BOUNDARY --> COMPAT["Schema compat + alias normalization"]
    COMPAT --> GUARD["Tool-loop guard"]
    GUARD -->|"emit tool_calls + finish_reason=tool_calls"| SDK
    SDK --> OC

    OC -->|"execute tool locally"| TOOLRUN["OpenCode tool runtime"]
    TOOLRUN -->|"next request includes role:tool result"| SDK
    SDK -->|"TOOL_RESULT prompt block"| RUNNER

    RUNNER -->|"Shell tool_call"| MCPTOOL["mcptool CLI"]
    MCPTOOL -->|"stdio"| MCP["MCP Servers"]
    MCP --> MCPTOOL
    MCPTOOL --> RUNNER
```

<details>
<summary><b>How the proxy works</b></summary>

The proxy uses a dual-backend runtime. In `auto` mode (default) it prefers the `cursor-agent` binary when available. If `cursor-agent` is unavailable and a real Cursor API key is configured, or if `CURSOR_ACP_BACKEND=sdk` is set, a persistent Node.js child process (`scripts/sdk-runner.mjs`) runs `@cursor/sdk` on behalf of the proxy.

By default, the SDK Agent runs in isolated mode (`settingSources: []`). To load Cursor environment settings in SDK mode, set `CURSOR_ACP_SETTING_SOURCES=all`.

Default tool-loop mode: `CURSOR_ACP_TOOL_LOOP_MODE=opencode`. Details: [docs/architecture/runtime-tool-loop.md](docs/architecture/runtime-tool-loop.md).
</details>

## Alternatives
THERE is currently not a single perfect plugin for cursor in opencode, my advice is stick with what is the LEAST worst option for you.
|                   |        open-cursor         | [yet-another-opencode-cursor-auth](https://github.com/Yukaii/yet-another-opencode-cursor-auth) | [opencode-cursor-auth](https://github.com/POSO-PocketSolutions/opencode-cursor-auth) | [cursor-opencode-auth](https://github.com/R44VC0RP/cursor-opencode-auth) |
| ----------------- | :------------------------: | :--------------------------------------------------------------------------------------------: | :----------------------------------------------------------------------------------: | :----------------------------------------------------------------------: |
| **Architecture**  | HTTP proxy via cursor-agent |                                       Direct Connect-RPC                                       |                             HTTP proxy via cursor-agent                              |                       Direct Connect-RPC/protobuf                        |
| **Platform**      |   Linux, macOS, Windows    |                                      Linux, macOS                                           |                                     Linux, macOS                                     |                          macOS only (Keychain)                           |
| **Max Prompt**    |   Unlimited (HTTP body)    |                                            Unknown                                             |                                   ~128KB (ARG_MAX)                                   |                                 Unknown                                  |
| **Streaming**     |           ✓ SSE            |                                             ✓ SSE                                              |                                     Undocumented                                     |                                    ✓                                     |
| **Error Parsing** |   ✓ (quota/auth/model)     |                                               ✗                                                |                                          ✗                                           |                              Debug logging                               |
| **Installer**     |     ✓ TUI + one-liner      |                                               ✗                                                |                                          ✗                                           |                                    ✗                                     |
| **OAuth Flow**    |  ✓ OpenCode integration    |                                            ✓ Native                                            |                                    Browser login                                     |                                 Keychain                                 |
| **Tool Calling**  | ✓ OpenCode-owned loop |                                            ✓ Native                                            |                                    ✓ Experimental                                    |                                    ✗                                     |
| **MCP Bridge**    | ✓ mcptool CLI (any MCP server) |                                               ✗                                                |                                          ✗                                           |                                    ✗                                     |
| **Stability**     | Stable (uses official CLI) |                                          Experimental                                          |                                        Stable                                        |                               Experimental                               |
| **Dependencies**  |     bun, cursor-agent      |                                              npm                                               |                                  bun, cursor-agent                                   |                               Node.js 18+                                |
| **Port**          |           32124            |                                             18741                                              |                                        32123                                         |                                   4141                                   |

## Troubleshooting

- `fetch() URL is invalid` or auth errors → `cursor-agent login` or `opencode auth login --provider cursor-acp`
- `CURSOR_API_KEY not set` in SDK mode → set a real API key from [cursor.com/settings](https://cursor.com/settings), or use `CURSOR_ACP_BACKEND=auto` with a working `cursor-agent`
- Model not responding → verify your API key/quota
- Quota exceeded → [cursor.com/settings](https://cursor.com/settings)
- Proxy not starting → ensure port 32124 is available

Debug logging: `CURSOR_ACP_LOG_LEVEL=debug opencode run "your prompt" --model cursor-acp/auto`

## Roadmap

```mermaid
flowchart LR
    P1[/Stabilise/] --> P2[/MCP Bridge/] --> P3[/Simplify/] --> P4[/ACP + MCP/]

    style P1 fill:#264653,stroke:#1d3557,color:#fff
    style P2 fill:#264653,stroke:#1d3557,color:#fff
    style P3 fill:#495057,stroke:#343a40,color:#adb5bd
    style P4 fill:#495057,stroke:#343a40,color:#adb5bd
```

[X] **Stabilise** — Clean up dead code, fix test isolation
[X] **MCP Bridge** — Bridge MCP servers into Cursor models via `mcptool` CLI
[ ] **Simplify** — Rip out serialisation layers
[ ] **ACP + MCP** — Structured protocols end-to-end

**ACP + MCP (deferred)** — End goal is a thin `OpenCode → Cursor ACP → MCP` plugin, not an evolved proxy. We ship the bridge until Cursor's ACP path passes MCP + headless approval re-validation. [Why and when →](docs/architecture/cursor-acp-mcp-future.md)

## License

BSD-3-Clause
