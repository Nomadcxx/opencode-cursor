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
# Windows installer coming soon.
# In the meantime, use Option C (npm install):
npm install -g @rama_nigg/open-cursor
open-cursor install
```

<details>
<summary><b>Option B</b> — Add to opencode.json</summary>

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
        "cursor-acp/auto": { "name": "Auto" },
        "cursor-acp/composer-1.5": { "name": "Composer 1.5" },
        "cursor-acp/composer-1": { "name": "Composer 1" },
        "cursor-acp/opus-4.6-thinking": { "name": "Claude 4.6 Opus (Thinking)" },
        "cursor-acp/opus-4.6": { "name": "Claude 4.6 Opus" },
        "cursor-acp/sonnet-4.6": { "name": "Claude 4.6 Sonnet" },
        "cursor-acp/sonnet-4.6-thinking": { "name": "Claude 4.6 Sonnet (Thinking)" },
        "cursor-acp/opus-4.5": { "name": "Claude 4.5 Opus" },
        "cursor-acp/opus-4.5-thinking": { "name": "Claude 4.5 Opus (Thinking)" },
        "cursor-acp/sonnet-4.5": { "name": "Claude 4.5 Sonnet" },
        "cursor-acp/sonnet-4.5-thinking": { "name": "Claude 4.5 Sonnet (Thinking)" },
        "cursor-acp/gpt-5.4-high": { "name": "GPT-5.4 High" },
        "cursor-acp/gpt-5.4-high-fast": { "name": "GPT-5.4 High Fast" },
        "cursor-acp/gpt-5.4-xhigh": { "name": "GPT-5.4 Extra High" },
        "cursor-acp/gpt-5.4-xhigh-fast": { "name": "GPT-5.4 Extra High Fast" },
        "cursor-acp/gpt-5.4-medium": { "name": "GPT-5.4" },
        "cursor-acp/gpt-5.4-medium-fast": { "name": "GPT-5.4 Fast" },
        "cursor-acp/gpt-5.3-codex": { "name": "GPT-5.3 Codex" },
        "cursor-acp/gpt-5.3-codex-fast": { "name": "GPT-5.3 Codex Fast" },
        "cursor-acp/gpt-5.3-codex-low": { "name": "GPT-5.3 Codex Low" },
        "cursor-acp/gpt-5.3-codex-low-fast": { "name": "GPT-5.3 Codex Low Fast" },
        "cursor-acp/gpt-5.3-codex-high": { "name": "GPT-5.3 Codex High" },
        "cursor-acp/gpt-5.3-codex-high-fast": { "name": "GPT-5.3 Codex High Fast" },
        "cursor-acp/gpt-5.3-codex-xhigh": { "name": "GPT-5.3 Codex Extra High" },
        "cursor-acp/gpt-5.3-codex-xhigh-fast": { "name": "GPT-5.3 Codex Extra High Fast" },
        "cursor-acp/gpt-5.3-codex-spark-preview": { "name": "GPT-5.3 Codex Spark" },
        "cursor-acp/gpt-5.2": { "name": "GPT-5.2" },
        "cursor-acp/gpt-5.2-high": { "name": "GPT-5.2 High" },
        "cursor-acp/gpt-5.2-codex": { "name": "GPT-5.2 Codex" },
        "cursor-acp/gpt-5.2-codex-fast": { "name": "GPT-5.2 Codex Fast" },
        "cursor-acp/gpt-5.2-codex-low": { "name": "GPT-5.2 Codex Low" },
        "cursor-acp/gpt-5.2-codex-low-fast": { "name": "GPT-5.2 Codex Low Fast" },
        "cursor-acp/gpt-5.2-codex-high": { "name": "GPT-5.2 Codex High" },
        "cursor-acp/gpt-5.2-codex-high-fast": { "name": "GPT-5.2 Codex High Fast" },
        "cursor-acp/gpt-5.2-codex-xhigh": { "name": "GPT-5.2 Codex Extra High" },
        "cursor-acp/gpt-5.2-codex-xhigh-fast": { "name": "GPT-5.2 Codex Extra High Fast" },
        "cursor-acp/gpt-5.1-codex-max": { "name": "GPT-5.1 Codex Max" },
        "cursor-acp/gpt-5.1-codex-max-high": { "name": "GPT-5.1 Codex Max High" },
        "cursor-acp/gpt-5.1-codex-mini": { "name": "GPT-5.1 Codex Mini" },
        "cursor-acp/gpt-5.1-high": { "name": "GPT-5.1 High" },
        "cursor-acp/gemini-3.1-pro": { "name": "Gemini 3.1 Pro" },
        "cursor-acp/gemini-3-pro": { "name": "Gemini 3 Pro" },
        "cursor-acp/gemini-3-flash": { "name": "Gemini 3 Flash" },
        "cursor-acp/grok": { "name": "Grok" },
        "cursor-acp/kimi-k2.5": { "name": "Kimi K2.5" }
      }
    }
  }
}
```

> Update models anytime: `cursor-agent models`
</details>

<details>
<summary><b>Option C</b> — npm global + CLI</summary>

```bash
npm install -g @rama_nigg/open-cursor
open-cursor install
```

Upgrade: `npm update -g @rama_nigg/open-cursor`
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
Install open-cursor for OpenCode: edit ~/.config/opencode/opencode.json, add "@rama_nigg/open-cursor@latest" to "plugin", add a "cursor-acp" provider with npm "@ai-sdk/openai-compatible" and models from `cursor-agent models` prefixed with "cursor-acp/". Auth: `cursor-agent login`. Verify: `opencode models | grep cursor-acp`.
```
</details>

<details>
<summary><b>Option F</b> — Manual (from source)</summary>

```bash
git clone https://github.com/Nomadcxx/opencode-cursor.git && cd opencode-cursor
bun install && bun run build
ln -sf $(pwd)/dist/plugin-entry.js ~/.config/opencode/plugin/cursor-acp.js
./scripts/sync-models.sh
```

Add `"cursor-acp"` to the `plugin` array and reuse the provider block from Option B.
</details>

## Authentication

```bash
opencode auth login   # provider id: cursor-acp
cursor-agent login    # direct
```

## Usage

```bash
opencode run "your prompt" --model cursor-acp/auto
opencode run "your prompt" --model cursor-acp/sonnet-4.5
```

## MCP Tool Bridge

Any MCP servers already configured in your `opencode.json` work automatically with cursor-acp models — no extra setup needed. The plugin discovers them at startup and injects usage instructions into the system prompt so the model calls them via cursor-agent's Shell tool.

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
    PROXY -->|"spawn per request"| AGENT["cursor-agent --output-format stream-json"]
    AGENT -->|"HTTPS"| CURSOR["Cursor API"]
    CURSOR --> AGENT

    AGENT -->|"assistant / thinking events"| SSE["SSE content chunks"]
    AGENT -->|"tool_call event"| BOUNDARY["Provider boundary (v1 default)"]
    BOUNDARY --> COMPAT["Schema compat + alias normalization"]
    COMPAT --> GUARD["Tool-loop guard"]
    GUARD -->|"emit tool_calls + finish_reason=tool_calls"| SDK
    SDK --> OC

    OC -->|"execute tool locally"| TOOLRUN["OpenCode tool runtime"]
    TOOLRUN -->|"next request includes role:tool result"| SDK
    SDK -->|"TOOL_RESULT prompt block"| AGENT

    AGENT -->|"Shell tool_call"| MCPTOOL["mcptool CLI"]
    MCPTOOL -->|"stdio"| MCP["MCP Servers"]
    MCP --> MCPTOOL
    MCPTOOL --> AGENT
```

Default mode: `CURSOR_ACP_TOOL_LOOP_MODE=opencode`. Details: [docs/architecture/runtime-tool-loop.md](docs/architecture/runtime-tool-loop.md).

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

- `fetch() URL is invalid` → `opencode auth login`
- Model not responding → `cursor-agent login`
- Quota exceeded → [cursor.com/settings](https://cursor.com/settings)
- Auth failed → `CURSOR_ACP_LOG_LEVEL=debug opencode auth login cursor-acp`

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

`Future Architecture` — Long-term direction is `OpenCode -> Cursor ACP -> MCP`, using official Cursor ACP as the backend. Currently deferred: Cursor ACP does not yet reliably propagate MCP servers during ACP session setup. See [docs/architecture/cursor-acp-mcp-future.md](docs/architecture/cursor-acp-mcp-future.md).

## License

BSD-3-Clause
