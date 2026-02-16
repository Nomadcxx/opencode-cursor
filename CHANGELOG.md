# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.3.3] - 2026-02-16

### Fixed
- Plugin loading crash caused by OpenCode loader calling class constructors without `new`. Entry point now isolated to single default export in `plugin-entry.ts`.

### Added
- MCP tool pass-through: unknown tools (e.g. Playwright via cursor-agent) are tracked instead of dropped, with toast notifications summarizing activity at response end.
- `PassThroughTracker` for tracking forwarded tool calls and errors.
- `ToastService` for OpenCode TUI toast integration with graceful degradation.
- `extractOpenAiToolCall` now returns structured result with `action` field (intercept/passthrough/skip).

### Changed
- Removed stale implementation docs (`docs/implementation/`).

## [2.1.7] - 2026-02-13

### Fixed
- Tool loop guard now detects repeated successful `edit`/`write` loops (including coarse path-based repeats) while reducing false positives.
- Schema-validation loop-guard history is now seeded from tool-call shapes even when tool result messages are missing/truncated.
- SSE streaming conversion now emits assistant text deltas from both partial and non-partial assistant events.
- Proxy port selection now probes for an actually-bindable port, avoiding reliance on incomplete `ss`/`lsof` output.

### Changed
- Plugin directory initialization now respects `XDG_CONFIG_HOME` (creates `opencode/plugin` under the configured XDG config home).

## [2.1.6] - 2026-02-12

### Changed
- README now uses `npm exec -- @rama_nigg/open-cursor ...` examples to avoid PATH issues with global npm bin.
- Removed README references to `open-cursor sync-models` and `open-cursor status` (use `install` to resync models).

## [2.1.5] - 2026-02-12

### Changed
- Clarified npm install instructions and removed “check npm view first” from README.
- CLI help output now matches the invoked binary name (`open-cursor`).

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
