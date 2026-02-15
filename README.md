![header](docs/header.png)

<p align="center">
  <img src="https://img.shields.io/badge/Linux-FCC624?style=for-the-badge&logo=linux&logoColor=black" alt="Linux" />
  <img src="https://img.shields.io/badge/macOS-000000?style=for-the-badge&logo=apple&logoColor=white" alt="macOS" />
</p>

No prompt limits. No broken streams. Full thinking + tool support in Opencode. Your Cursor subscription, properly integrated.

## Installation

**Option A — Add to opencode.json (Recommended)**

The simplest approach—just add the npm package to your OpenCode config:

```json
{
  "plugin": ["@rama_nigg/open-cursor@latest"],
  "provider": {
    "cursor-acp": {
      "name": "Cursor ACP",
      "npm": "@ai-sdk/openai-compatible",
      "models": {
        "cursor-acp/claude-sonnet": { "name": "Claude Sonnet" },
        "cursor-acp/gpt-4o": { "name": "GPT-4o" },
        "cursor-acp/gemini-2.5-pro": { "name": "Gemini 2.5 Pro" },
        "cursor-acp/cursor-small": { "name": "Cursor Small" }
      }
    }
  }
}
```

After authenticating with `cursor-agent login`, run `cursor-agent models` to see the full model list, or use one of the automated installers below to auto-discover models.

**Prerequisites:** Only OpenCode required. OpenCode's Bun runtime resolves the npm package automatically.

**Option B — One-line installer (curl)**

```bash
curl -fsSL https://raw.githubusercontent.com/Nomadcxx/opencode-cursor/main/install.sh | bash
```

This automated installer detects your environment and chooses the best installation method.

**Option C — npm global install + CLI**

```bash
npm install -g @rama_nigg/open-cursor
open-cursor install
```

Upgrade later with:

```bash
npm update -g @rama_nigg/open-cursor
open-cursor install
```

**Option D — Go TUI installer**

Interactive visual installer with dual-mode support (quick install or build from source):

```bash
git clone https://github.com/Nomadcxx/opencode-cursor.git
cd opencode-cursor
go build -o ./installer ./cmd/installer && ./installer
```

**Option E — LLM instructions**

Paste this into any LLM agent (Claude Code, OpenCode, Cursor, etc.):

```
Install the cursor-acp plugin for OpenCode using the npm package approach:

1. Edit your opencode.json config file (usually at ~/.config/opencode/opencode.json)
2. Add "@rama_nigg/open-cursor@latest" to the plugin array
3. Add the cursor-acp provider configuration with models
4. Restart OpenCode

Example configuration:
{
  "plugin": ["@rama_nigg/open-cursor@latest"],
  "provider": {
    "cursor-acp": {
      "name": "Cursor ACP",
      "npm": "@ai-sdk/openai-compatible",
      "models": {
        "cursor-acp/claude-sonnet": { "name": "Claude Sonnet" }
      }
    }
  }
}

5. Authenticate: cursor-agent login
6. Verify: opencode models | grep cursor-acp
```

**Option F — Manual (from source)**

For developers and contributors who want full control:

```bash
git clone https://github.com/Nomadcxx/opencode-cursor.git
cd opencode-cursor
bun install && bun run build
mkdir -p ~/.config/opencode/plugin
ln -sf $(pwd)/dist/plugin-entry.js ~/.config/opencode/plugin/cursor-acp.js
```

The automated installers handle configuration automatically. For manual installs, run the sync script to populate models:

```bash
./scripts/sync-models.sh
```

Or configure manually by adding this to `~/.config/opencode/opencode.json` (then run `./scripts/sync-models.sh` to populate models):

```json
{
  "plugin": ["cursor-acp"],
  "provider": {
    "cursor-acp": {
      "name": "Cursor",
      "npm": "@ai-sdk/openai-compatible",
      "options": { "baseURL": "http://127.0.0.1:32124/v1" },
      "models": {
        "auto": { "name": "Auto" },
        "composer-1.5": { "name": "Composer 1.5" },
        "composer-1": { "name": "Composer 1" },
        "gpt-5.3-codex": { "name": "GPT-5.3 Codex" },
        "gpt-5.3-codex-low": { "name": "GPT-5.3 Codex Low" },
        "gpt-5.3-codex-high": { "name": "GPT-5.3 Codex High" },
        "gpt-5.3-codex-xhigh": { "name": "GPT-5.3 Codex Extra High" },
        "gpt-5.3-codex-fast": { "name": "GPT-5.3 Codex Fast" },
        "gpt-5.3-codex-low-fast": { "name": "GPT-5.3 Codex Low Fast" },
        "gpt-5.3-codex-high-fast": { "name": "GPT-5.3 Codex High Fast" },
        "gpt-5.3-codex-xhigh-fast": { "name": "GPT-5.3 Codex Extra High Fast" },
        "gpt-5.2": { "name": "GPT-5.2" },
        "gpt-5.2-codex": { "name": "GPT-5.2 Codex" },
        "gpt-5.2-codex-high": { "name": "GPT-5.2 Codex High" },
        "gpt-5.2-codex-low": { "name": "GPT-5.2 Codex Low" },
        "gpt-5.2-codex-xhigh": { "name": "GPT-5.2 Codex Extra High" },
        "gpt-5.2-codex-fast": { "name": "GPT-5.2 Codex Fast" },
        "gpt-5.2-codex-high-fast": { "name": "GPT-5.2 Codex High Fast" },
        "gpt-5.2-codex-low-fast": { "name": "GPT-5.2 Codex Low Fast" },
        "gpt-5.2-codex-xhigh-fast": { "name": "GPT-5.2 Codex Extra High Fast" },
        "gpt-5.1-codex-max": { "name": "GPT-5.1 Codex Max" },
        "gpt-5.1-codex-max-high": { "name": "GPT-5.1 Codex Max High" },
        "opus-4.6-thinking": { "name": "Claude 4.6 Opus (Thinking)" },
        "sonnet-4.5-thinking": { "name": "Claude 4.5 Sonnet (Thinking)" },
        "gpt-5.2-high": { "name": "GPT-5.2 High" },
        "opus-4.6": { "name": "Claude 4.6 Opus" },
        "opus-4.5": { "name": "Claude 4.5 Opus" },
        "opus-4.5-thinking": { "name": "Claude 4.5 Opus (Thinking)" },
        "sonnet-4.5": { "name": "Claude 4.5 Sonnet" },
        "gpt-5.1-high": { "name": "GPT-5.1 High" },
        "gemini-3-pro": { "name": "Gemini 3 Pro" },
        "gemini-3-flash": { "name": "Gemini 3 Flash" },
        "grok": { "name": "Grok" }
      }
    }
  }
}
```

### Plugin Configuration Reference

Depending on your installation method, use the appropriate plugin identifier:

**npm package (recommended for production):**
```json
"plugin": ["@rama_nigg/open-cursor@latest"]
```

**Local build (for development):**
```json
"plugin": ["cursor-acp"]
```

Both approaches work—the npm package is resolved automatically by OpenCode's Bun runtime, while the local build requires the symlink setup shown in Option F above.

## Authentication

### Option 1: Via OpenCode (Recommended)

```bash
opencode auth login
```

Then follow the prompts:

1. Select **"Other"** from the provider list
2. Enter provider id: **cursor-acp**
3. Browser will open automatically - click "Continue with Cursor"
4. Return to terminal when you see "Login successful"

### Option 2: Direct (CLI only)

```bash
cursor-agent login
```

Then open the URL shown in your browser and complete authentication.

Credential file locations:

- macOS: `~/.cursor/cli-config.json` (current) or `~/.cursor/auth.json` (legacy)
- Linux: `~/.config/cursor/cli-config.json` or `~/.config/cursor/auth.json` (or `$XDG_CONFIG_HOME/cursor/`)

## Usage

```bash
opencode run "your prompt" --model cursor-acp/auto
opencode run "your prompt" --model cursor-acp/sonnet-4.5
```

## Architecture

```mermaid
flowchart TB
    OC["OpenCode"] --> SDK["@ai-sdk/openai-compatible"]
    SDK -->|"POST /v1/chat/completions"| PROXY["cursor-acp proxy :32124"]
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
```

Default mode is `CURSOR_ACP_TOOL_LOOP_MODE=opencode`: OpenCode owns tool execution, while cursor-acp intercepts and translates `cursor-agent` tool calls into OpenAI-compatible `tool_calls` responses.  
Legacy execution mode (`proxy-exec`) is still available for local/SDK/MCP execution through the internal router.

Detailed architecture: [docs/architecture/runtime-tool-loop.md](docs/architecture/runtime-tool-loop.md).

## Alternatives

|                   |         cursor-acp          | [yet-another-opencode-cursor-auth](https://github.com/Yukaii/yet-another-opencode-cursor-auth) | [opencode-cursor-auth](https://github.com/POSO-PocketSolutions/opencode-cursor-auth) | [cursor-opencode-auth](https://github.com/R44VC0RP/cursor-opencode-auth) |
| ----------------- | :-------------------------: | :--------------------------------------------------------------------------------------------: | :----------------------------------------------------------------------------------: | :----------------------------------------------------------------------: |
| **Architecture**  | HTTP proxy via cursor-agent |                                       Direct Connect-RPC                                       |                             HTTP proxy via cursor-agent                              |                       Direct Connect-RPC/protobuf                        |
| **Platform**      |        Linux, macOS         |                                          Linux, macOS                                          |                                     Linux, macOS                                     |                          macOS only (Keychain)                           |
| **Max Prompt**    |    Unlimited (HTTP body)    |                                            Unknown                                             |                                   ~128KB (ARG_MAX)                                   |                                 Unknown                                  |
| **Streaming**     |            ✓ SSE            |                                             ✓ SSE                                              |                                     Undocumented                                     |                                    ✓                                     |
| **Error Parsing** |    ✓ (quota/auth/model)     |                                               ✗                                                |                                          ✗                                           |                              Debug logging                               |
| **Installer**     |      ✓ TUI + one-liner      |                                               ✗                                                |                                          ✗                                           |                                    ✗                                     |
| **OAuth Flow**    |   ✓ OpenCode integration    |                                            ✓ Native                                            |                                    Browser login                                     |                                 Keychain                                 |
| **Tool Calling**  | ✓ OpenCode-owned loop (default) + proxy-exec mode |                                            ✓ Native                                            |                                    ✓ Experimental                                    |                                    ✗                                     |
| **Stability**     | Stable (uses official CLI)  |                                          Experimental                                          |                                        Stable                                        |                               Experimental                               |
| **Dependencies**  |      bun, cursor-agent      |                                              npm                                               |                                  bun, cursor-agent                                   |                               Node.js 18+                                |
| **Port**          |            32124            |                                             18741                                              |                                        32123                                         |                                   4141                                   |

## Prerequisites

**For Option A (npm-direct):** Only [OpenCode](https://opencode.ai/) required.

**For Options B-F:**
- [Bun](https://bun.sh/)
- [cursor-agent](https://cursor.com/) - `curl -fsSL https://cursor.com/install | bash`

**Option B (one-line install):** If Go is installed, the script runs the TUI installer; otherwise it performs a shell-only install (OpenCode + cursor-agent required). For syncing models without the TUI, install [jq](https://jq.org/) or run `./scripts/sync-models.sh` after install.

**Option D (TUI installer):** Go 1.21+ required to build the installer.

## Features

- HTTP proxy (avoids E2BIG errors)
- Streaming responses with thinking and tool call support
- OAuth authentication
- Error parsing (quota/auth/network)

## Development

Build and run tests locally:

```bash
bun install
bun run build
bun run test:ci:unit
bun run test:ci:integration
```

CI runs split suites in `.github/workflows/ci.yml`:

- `unit` job: `bun run test:ci:unit`
- `integration` job: `bun run test:ci:integration`

Integration CI pins OpenCode-owned loop mode to deterministic settings:

- `CURSOR_ACP_TOOL_LOOP_MODE=opencode`
- `CURSOR_ACP_PROVIDER_BOUNDARY=v1`
- `CURSOR_ACP_PROVIDER_BOUNDARY_AUTOFALLBACK=false`
- `CURSOR_ACP_TOOL_LOOP_MAX_REPEAT=3`
- `CURSOR_ACP_ENABLE_OPENCODE_TOOLS=true`
- `CURSOR_ACP_FORWARD_TOOL_CALLS=false`
- `CURSOR_ACP_EMIT_TOOL_UPDATES=false`

## Troubleshooting

**"fetch() URL is invalid"** - Run `opencode auth login` without arguments

**Model not responding** - Run `cursor-agent login` to re-authenticate

**Quota exceeded** - Check [cursor.com/settings](https://cursor.com/settings)

**Authentication failed or incomplete** - Enable debug logging to diagnose:
```bash
CURSOR_ACP_LOG_LEVEL=debug opencode auth login cursor-acp
```

Common causes:
- Browser didn't open automatically - manually open the URL shown in the terminal
- Auth file not created - ensure `cursor-agent login` works directly first
- Timeout - authentication must complete within 5 minutes

### Debug Logging

Enable verbose logs:
```bash
CURSOR_ACP_LOG_LEVEL=debug opencode run "your prompt" --model cursor-acp/auto
```

Disable log output entirely:
```bash
CURSOR_ACP_LOG_SILENT=true opencode run "your prompt"
```

## License

BSD-3-Clause
