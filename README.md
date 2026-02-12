![header](docs/header.png)

<p align="center">
  <img src="https://img.shields.io/badge/Linux-FCC624?style=for-the-badge&logo=linux&logoColor=black" alt="Linux" />
  <img src="https://img.shields.io/badge/macOS-000000?style=for-the-badge&logo=apple&logoColor=white" alt="macOS" />
</p>

No prompt limits. No broken streams. Full thinking + tool support in Opencode. Your Cursor subscription, properly integrated.

## Installation

**Option A: One-Line Install**

```bash
curl -fsSL https://raw.githubusercontent.com/Nomadcxx/opencode-cursor/main/install.sh | bash
```

Note: if `npm` is available, `install.sh` installs/upgrades `@rama_nigg/open-cursor` and configures OpenCode automatically. Otherwise it falls back to building from source.

**Option B: npm Package (Recommended)**

```bash
npm install -g @rama_nigg/open-cursor
npm exec -- @rama_nigg/open-cursor install
```

Upgrade later with:

```bash
npm update -g @rama_nigg/open-cursor
npm exec -- @rama_nigg/open-cursor install
```

**Option C: TUI Installer**

```bash
git clone https://github.com/Nomadcxx/opencode-cursor.git
cd opencode-cursor
go build -o ./installer ./cmd/installer && ./installer
```

**Option D: Let an LLM do it**

Paste this into any LLM agent (Claude Code, OpenCode, Cursor, etc.):

```
Install the cursor-acp plugin for OpenCode:

1. Preferred install (npm):
   npm install -g @rama_nigg/open-cursor
   npm exec -- @rama_nigg/open-cursor install

2. Fallback (build from source):
   git clone https://github.com/Nomadcxx/opencode-cursor.git
   cd opencode-cursor
   bun install && bun run build
   mkdir -p ~/.config/opencode/plugin
   ln -sf $(pwd)/dist/plugin-entry.js ~/.config/opencode/plugin/cursor-acp.js
   ./scripts/sync-models.sh

3. Verify:
   opencode models | grep cursor-acp
```

**Option E: Manual Install**

```bash
bun install && bun run build
mkdir -p ~/.config/opencode/plugin
ln -sf $(pwd)/dist/plugin-entry.js ~/.config/opencode/plugin/cursor-acp.js
```

The installers handle the rest automatically. If you're doing a manual install, you'll need to do the following steps yourself.

Easiest way is to run the sync script, which populates everything for you:

```bash
./scripts/sync-models.sh
```

Or if you'd rather do it by hand, add this to `~/.config/opencode/opencode.json` (then run `./scripts/sync-models.sh` to populate models):

```json
{
  "plugin": ["cursor-acp"],
  "provider": {
    "cursor-acp": {
      "name": "Cursor",
      "npm": "@ai-sdk/openai-compatible",
      "options": { "baseURL": "http://127.0.0.1:32124/v1" },
      "models": {
        "auto": { "name": "Auto" }
      }
    }
  }
}
```

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

## Models

Models are pulled from `cursor-agent models` and written to your config during installation. If Cursor adds new models later:

```bash
npm exec -- @rama_nigg/open-cursor install
```

Or, if you installed from source (no npm CLI):

```bash
./scripts/sync-models.sh
```

The proxy also exposes a `/v1/models` endpoint that fetches models in real-time:

```bash
curl http://127.0.0.1:32124/v1/models
```

Common models: `auto`, `composer-1.5`, `gpt-5.3-codex`, `opus-4.6-thinking`, `sonnet-4.5`, `gemini-3-pro`, `grok`

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

**Key advantages of cursor-acp:**

- Avoids E2BIG errors with large prompts (uses HTTP body, not CLI args)
- Structured error parsing with actionable suggestions
- Cross-platform (not locked to macOS Keychain)
- TUI installer for easy setup
- Native tool calling with 10 built-in tools, SDK/MCP executor support, and a skills/alias system
- Uses official cursor-agent CLI (more stable than reverse-engineering Connect-RPC)

## Prerequisites

- [Bun](https://bun.sh/)
- [cursor-agent](https://cursor.com/) - `curl -fsSL https://cursor.com/install | bash`

**Option A (one-line install):** If Go is installed, the script runs the TUI installer; otherwise it performs a shell-only install (Bun + cursor-agent required). For syncing models without the TUI, install [jq](https://jq.org/) or run `./scripts/sync-models.sh` after install.

**Option B (TUI installer):** Go 1.21+ required to build the installer.

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

## Publishing

For maintainers, release and npm publish steps are documented in [docs/PUBLISHING.md](docs/PUBLISHING.md).

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

Set the log level via environment variable:
- `CURSOR_ACP_LOG_LEVEL=debug` - Verbose output for troubleshooting
- `CURSOR_ACP_LOG_LEVEL=info` - Default level
- `CURSOR_ACP_LOG_LEVEL=warn` - Warnings and errors only
- `CURSOR_ACP_LOG_LEVEL=error` - Errors only

Provider-boundary rollout:
- Default: `CURSOR_ACP_PROVIDER_BOUNDARY=v1`
- Default: `CURSOR_ACP_PROVIDER_BOUNDARY_AUTOFALLBACK=true`
- `CURSOR_ACP_PROVIDER_BOUNDARY=legacy` - Original provider/runtime boundary behavior
- `CURSOR_ACP_PROVIDER_BOUNDARY=v1` - Shared boundary/interception path
- `CURSOR_ACP_PROVIDER_BOUNDARY_AUTOFALLBACK=false` - Disable fallback and keep strict `v1` behavior
- `CURSOR_ACP_TOOL_LOOP_MAX_REPEAT=3` - Max repeated failing tool-call fingerprints before guard termination (or fallback when enabled)

Auto-fallback trigger conditions:
- Only active when `CURSOR_ACP_PROVIDER_BOUNDARY=v1`
- Triggered when `v1` boundary extraction throws during tool-call interception
- Triggered when the tool-loop guard threshold is reached (same tool + arg shape + error class)
- Does not trigger for normal cases like disallowed tools or no tool call
- Does not trigger for unrelated runtime errors (for example, tool mapper/tool execution failures)

Disable log output entirely:
```bash
CURSOR_ACP_LOG_SILENT=true opencode run "your prompt"
```

## License

BSD-3-Clause
