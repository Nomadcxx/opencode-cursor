![header](docs/header.png)

A lightweight OpenCode plugin for Cursor Agent integration via stdin (fixes E2BIG errors).

## Installation

### One-Line Install (Fastest)

```bash
curl -fsSL https://raw.githubusercontent.com/nomadcxx/opencode-cursor/main/install.sh | bash
```

### Quick Install (Recommended)

```bash
git clone https://github.com/nomadcxx/opencode-cursor.git
cd opencode-cursor
./install.sh
```

The installer will:
- Check prerequisites (bun, cursor-agent)
- Build the TypeScript plugin
- Create symlink to OpenCode plugin directory
- Update opencode.json with cursor-acp provider
- Validate the configuration

### Manual Installation

```bash
# Install dependencies and build
bun install
bun run build

# Create plugin directory
mkdir -p ~/.config/opencode/plugin

# Symlink plugin
ln -s $(pwd)/dist/index.js ~/.config/opencode/plugin/cursor-acp.js

# Add to ~/.config/opencode/opencode.json:
# {
#   "provider": {
#     "cursor-acp": {
#       "npm": "@ai-sdk/openai-compatible",
#       "name": "Cursor Agent (ACP stdin)",
#       "options": {
#         "baseURL": "http://127.0.0.1:32123/v1"
#       }
#     }
#   }
# }
```

## Usage

OpenCode will automatically use this provider when configured. Select `cursor-acp/auto` as your model.

## Features

- ✅ Passes prompts via stdin (fixes E2BIG)
- ✅ Full streaming support with proper buffering
- ✅ Tool calling support
- ✅ Minimal complexity (~200 lines)
- ✅ TUI installer with animated terminal art
- ✅ Pre/post install validation

## Background

[PR #5095](https://github.com/sst/opencode/pull/5095) by [@rinardmclern](https://github.com/rinardmclern) proposed native ACP (OpenAI Chat Completion Protocol) support for OpenCode. The PR introduced a comprehensive implementation that would have allowed OpenCode to directly communicate with Cursor Agent using the standard OpenAI-compatible API format.

Despite the high quality of the contribution and community interest, the OpenCode maintainers decided not to merge PR #5095. The reasons cited included concerns about maintaining external service integrations and preferring to keep the core plugin system focused.

This plugin exists because of that decision. It provides the same functionality—Cursor Agent integration via stdin/stdout—as a standalone tool that anyone can install and use immediately without waiting for upstream changes.

## Why Other Approaches Don't Work

Several alternative solutions have been attempted to integrate Cursor with OpenCode, but each has fundamental issues:

### opencode-cursor-auth (CLI Arguments)
This approach passes prompts as CLI arguments to cursor-agent. The problem is that operating systems enforce a hard limit on the total length of command-line arguments (typically 128KB on Linux, 32KB on macOS). When coding conversations grow large, you immediately hit:

```
E2BIG: argument list too long
```

This makes it unusable for real-world coding sessions where context grows naturally.

### HTTP Proxy Wrappers
Some projects tried to run an HTTP server that wraps cursor-agent, then point OpenCode to `http://localhost:PORT/v1`. While this bypasses the argument limit, it introduces unnecessary complexity:

- Requires managing a separate daemon process
- Adds network latency to every prompt
- Creates a single point of failure if the proxy crashes
- Adds memory and CPU overhead for no functional benefit
- Harder to debug when things go wrong

### Direct OpenAI API Integration
Others attempted to use Cursor's OpenAI-compatible API endpoint directly. This has issues:

- Requires active internet connection even for local models
- Subject to rate limits and API changes
- Sends potentially sensitive code to external servers
- Doesn't leverage cursor-agent's built-in optimizations

### The stdin/stdout Approach (This Plugin)
This plugin uses the standard Unix philosophy: pipe data through stdin, read results from stdout. This approach:

- ✅ No argument length limits (stdin has no size constraints)
- ✅ No network overhead (direct process communication)
- ✅ No daemon to manage (spawns on-demand)
- ✅ Minimal complexity (~200 lines of TypeScript)
- ✅ Full streaming support
- ✅ Tool calling support
- ✅ Works offline with local models

## Problem Solved

`opencode-cursor-auth` passes prompts as CLI arguments → causes `E2BIG: argument list too long` errors.

This plugin uses stdin/stdout to bypass argument length limits.

## Prerequisites

- [Bun](https://bun.sh/) - JavaScript runtime
- [cursor-agent](https://cursor.com/) - Cursor CLI tool
- [Go 1.21+](https://golang.org/) - For building installer

## Development

```bash
# Install dependencies
bun install

# Build plugin
bun run build

# Watch mode
bun run dev

# Run installer in debug mode
./install.sh --debug
```

## License

ISC
