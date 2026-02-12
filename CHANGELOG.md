# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.1.4] - 2026-02-12

### Fixed
- Prefer OpenCode `worktree` (and `OPENCODE_CURSOR_PROJECT_DIR`) when selecting the Cursor workspace directory, avoiding writes being scoped to `~/.config/opencode` on macOS.
- Tool hook path resolution now prefers `context.worktree` and ignores OpenCode config-dir `context.directory` when resolving relative paths.

## [2.1.2] - 2026-02-09

### Added
- OpenCode-owned tool loop adapter for OpenAI-style `tool_calls` responses (`src/proxy/tool-loop.ts`)
- Focused integration coverage for request-1/request-2 tool loop continuity (`tests/integration/opencode-loop.integration.test.ts`)
- CI test split scripts: `test:ci:unit` and `test:ci:integration`
- GitHub Actions job summaries for unit and integration suites
- Packaging CLI entrypoint `open-cursor` for npm/global installs (`src/cli/opencode-cursor.ts`)
- Model discovery parser utility for CLI install/sync workflows (`src/cli/model-discovery.ts`)

### Changed
- CI workflow split into separate `unit` and `integration` jobs
- Integration CI defaults to OpenCode-owned loop mode (`CURSOR_ACP_TOOL_LOOP_MODE=opencode`)
- npm package metadata now targets publish/install as `open-cursor`
- Build now emits CLI artifacts for package bins (`dist/opencode-cursor.js`, `dist/discover.js`)

### Fixed
- Node proxy fallback after `EADDRINUSE` now recreates the server before dynamic port bind
- Streaming termination guards prevent duplicate flush/output after intercepted tool call
- Auth unit tests now clean all candidate auth paths to avoid environment-dependent flakes
- Provider config generator no longer hardcodes a local filesystem npm path
- Added auth home-path override (`CURSOR_ACP_HOME_DIR`) for deterministic auth path resolution in tests/automation
- Added proxy reuse toggle (`CURSOR_ACP_REUSE_EXISTING_PROXY`) to avoid accidentally attaching to unrelated local proxy servers

## [2.1.0] - 2026-02-07

### Added
- New streaming module (`src/streaming/`) with proper NDJSON parsing
- `LineBuffer` utility for handling TCP chunk boundaries in streaming responses
- `DeltaTracker` for deduplicating accumulated assistant text
- `StreamToSseConverter` for OpenAI-compatible SSE formatting
- `StreamToAiSdkParts` for ai-sdk stream part generation
- Thinking event support with `subtype: "delta"` and `subtype: "completed"`
- Tool call streaming with `started`, `completed`, and `failed` states
- Integration tests for streaming pipeline validation
- New exports: `LineBuffer`, `parseStreamJsonLine`, `DeltaTracker`, `StreamToSseConverter`, `formatSseChunk`, `formatSseDone`, `StreamToAiSdkParts`

### Fixed
- **Streaming responses now arrive incrementally** instead of buffering until completion
- Switched from `--output-format text` to `--output-format stream-json --stream-partial-output`
- Provider now properly handles `tool_call` and `thinking` events
- Plugin SSE output now correctly formats parsed events instead of raw bytes
- Assistant text deduplication prevents re-sending full accumulated content

### Changed
- `SimpleCursorClient.executePromptStream()` now yields `StreamJsonEvent` objects
- Plugin Bun and Node.js streaming paths use new line buffer and SSE converter
- Provider direct-mode streaming uses new ai-sdk parts converter

## [2.0.1] - Previous Release

Initial release with stdin-based prompt passing to fix E2BIG errors.
