# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.4.14] - 2026-06-18

### Added
- Request timing markers for runtime diagnostics.
- Status output now shows runtime settings.

### Fixed
- Quota banners are suppressed after a successful stream.
- Quota-exit tests now let mocked stdio flush before termination.

## [2.4.13] - 2026-06-18

### Added
- Cursor-agent runner pool behind `CURSOR_ACP_AGENT_POOL`, including request cancellation via runner control messages.

### Fixed
- Session resume now validates branch matching, tool fingerprints, prompt anchor hashes, and stale chat IDs more defensively.
- Runner pool lifecycle now evicts idle runners and hardens cancellation, CI registration, and log safety.
- Issue #92 verification cleanup now uses safer test paths.

## [2.4.12] - 2026-06-17

### Added
- Session resume for multi-turn cursor-agent requests.

### Changed
- Reduced per-request proxy overhead by caching tool schema blocks, reusing config path resolution, replacing synchronous file logging with a write stream, avoiding SDK demux re-stringify, and disabling Nagle on SSE sockets.

### Fixed
- `OPENCODE_CONFIG` is now respected by the `open-cursor` CLI.
- Logger stream handling is guarded after rotation failures.
- Tool schema cache fingerprints now include stronger request-shape details.
- Subagent cache gating now uses a nullish check.

## [2.4.11] - 2026-06-14

### Fixed
- Content edit payloads are guarded before being forwarded, avoiding unsafe malformed edit requests.

## [2.4.10] - 2026-06-14

### Added
- Model refresh controls for compact model updates.

### Fixed
- Guarded stream-content edits and partial file overwrite paths so malformed Cursor edits do not accidentally replace whole files.

## [2.4.9] - 2026-06-14

### Fixed
- OpenCode plugin imports now use the tool subpath expected by newer plugin packaging.

## [2.4.8] - 2026-06-14

### Fixed
- Proxy health checks now time out instead of hanging indefinitely.
- Empty `edit.old_string` values are rejected before execution.

### Changed
- README install flow and ACP/MCP roadmap documentation were streamlined.

## [2.4.7] - 2026-06-12

### BREAKING

- **Authentication:** API key authentication now supports three methods with priority: (1) `CURSOR_API_KEY` environment variable, (2) OpenCode auth store (`opencode auth login --provider cursor-acp`), (3) provider options in `opencode.json`. Get your API key from [cursor.com/settings](https://cursor.com/settings). Legacy OAuth flow via `cursor-agent login` is no longer supported.

### Changed

- **Runtime:** Replaced the `cursor-agent` binary (removed by Cursor in IDE versions >= 0.43) with the official `@cursor/sdk`. The SDK runs in a persistent Node.js child process (`scripts/sdk-runner.mjs`) instead of in-process, because the SDK's ConnectRPC/HTTP2 stack hangs inside OpenCode's embedded Bun runtime and its native `sqlite3` dependency cannot be bundled. The persistent process avoids paying Node boot + SDK import cost on every request.
- **SDK Agent isolation:** The Agent now runs isolated from the Cursor environment by default (`settingSources: []`), no longer loading user/project/team/mdm/plugins rules and skills per request. This eliminates duplicate instructions between Cursor and OpenCode and reduces request latency. To restore the previous behavior, set `CURSOR_ACP_SETTING_SOURCES=all`, or specify a subset like `user,project`.
- **Tool calls:** The SDK emits MCP tool calls as a generic tool named `mcp` with `{providerIdentifier, toolName, args}`; the runner remaps them to the `mcp__<server>__<tool>` names OpenCode expects, so MCP tools are executed instead of rejected as unavailable.
- **Model discovery:** `/v1/models` and the startup auto-refresh now query `Cursor.models.list()` from the SDK (via the runner) instead of the removed `cursor-agent models` command. Newly released Cursor models are added to `opencode.json` automatically (additive only), with an updated hardcoded fallback when no API key is available.
- **Installation:** New local development workflow via `scripts/install-plugin.sh`, which creates a TypeScript wrapper at `~/.config/opencode/plugins/cursor-acp.ts` pointing at the repository entry point.

### Fixed

- **Issue #76 (ECONNREFUSED on 127.0.0.1:32124):** the proxy failed to start because the plugin spawned the removed `cursor-agent` binary. The plugin now works without `cursor-agent` installed.
- The system prompt no longer suggests an ambiguous `mcp` tool name; full tool names are listed explicitly, and a defensive guard logs any remaining bare `mcp` calls.
- Local tool hooks now register `oc_*` aliases and use safe context defaults.
- AskQuestion calls are routed to the OpenCode `question` tool.

### Known limitations

- Per-request latency is bound by `@cursor/sdk` itself (`Agent.create` + `send` take ~6s even standalone). Each request uses a fresh Agent by design: conversation state stays in OpenCode and is never persisted on Cursor's side.
- Node.js >= 20 must be available in `PATH` (the SDK runner requires it).

## [2.4.6] - 2026-05-24

### Changed
- MCP tool guidance now recommends direct `mcp__<server>__<tool>` calls instead of the `mcptool` CLI, and prompts list exact MCP tool names.

### Fixed
- Malformed full-file edits are rerouted to `write` instead of being treated as partial edits.

## [2.4.5] - 2026-05-20

### Fixed
- Windows binary paths are quoted before execution.
- Mixed partial stream output is handled correctly.
- Duplicate streaming output from `cursor-agent` is prevented.

## [2.4.4] - 2026-05-11

### Fixed
- Native `grep` behavior is preserved when falling back through tool compatibility layers.

## [2.4.3] - 2026-05-11

### Fixed
- Empty edit replacements are rejected to prevent destructive file rewrites.

## [2.4.2] - 2026-05-10

### Fixed
- CLI startup now handles symlinked `bin` entrypoints.

## [2.4.1] - 2026-05-10

### Fixed
- Command tool execution now uses the platform shell, improving Windows compatibility.

## [2.4.0] - 2026-05-05

### Added
- Windows platform support, including executable path resolution, spawn compatibility, case-insensitive workspace comparisons, and Node.js fallback `grep`/`glob` implementations.
- Cursor usage metrics forwarding.
- Official Cursor model pricing metadata and a pricing coverage check.
- Runtime support for Cursor model variants.

### Changed
- Refreshed the model lineup and pointed users to the sync-models CLI workflow.
- `sync` preserves user-set model costs and trims npm package files.

### Fixed
- Workspace detection rejects `/` as a Cursor workspace and falls back to `$HOME`.
- Final thinking snapshots are deduplicated and final thinking text is replaced for parity with assistant messages.
- `z.record()` usage is compatible with Zod v4.
- Windows docs and provider tests were corrected.

## [2.3.20] - 2026-03-17

### Added
- Task tool subtype values are injected into system messages so Cursor emits valid task calls.
- Available task execution targets can now be listed from config.

### Changed
- Task tool loop-guard handling now uses a higher exploration threshold and soft-blocks on first trigger instead of killing the stream immediately.

### Fixed
- Regenerated a complete `package-lock.json`.

## [2.3.18] - 2026-03-16

### Fixed
- `@opencode-ai/plugin` and `zod` are externalized to prevent bundled Zod v4 class conflicts.

## [2.3.17] - 2026-03-11

### Fixed
- Bash tool execution now uses `spawn()`, correct timeout units, and proper non-zero exit handling.

## [2.3.16] - 2026-03-11

### Added
- MCP tool bridge with `mcptool` CLI for Shell-based MCP tool execution.

### Changed
- README now documents the MCP tool bridge and updates the roadmap and architecture diagram.

## [2.3.15] - 2026-03-10

### Added
- Model list auto-refresh at plugin startup.

## [2.3.14] - 2026-02-27

### Fixed
- Partial streaming detection now only sets the partial-output flag when the partial has content.

## [2.3.13] - 2026-02-27

### Fixed
- `StreamJsonAssistantEvent` now includes `timestamp_ms` without relying on `as any` casts.

## [2.3.12] - 2026-02-27

### Fixed
- Cursor-agent partial delta events no longer produce duplicated responses.

## [2.3.11] - 2026-02-25

### Fixed
- `DeltaTracker` no longer duplicates output when accumulated prefixes drift.

## [2.3.10] - 2026-02-18

### Fixed
- `webfetch` is classified as an exploration tool for loop-guard handling.

## [2.3.9] - 2026-02-18

### Fixed
- `bash` and `shell` are classified as exploration tools for loop-guard fingerprinting.

## [2.3.8] - 2026-02-17

### Fixed
- Success-path loop-guard tests now account for the exploration tools multiplier.

## [2.3.7] - 2026-02-17

### Fixed
- Exploration tool multiplier is applied to successful tool-call loop-guard paths.

## [2.3.6] - 2026-02-17

### Added
- Discovered pass-through tools are treated as known-success tools for loop-guard accounting.

### Fixed
- Exploration tools are exempt from coarse fingerprint tracking to avoid false loop detections.

## [2.3.5] - 2026-02-17

### Fixed
- Tool loop guard coarse fingerprint was too aggressive, blocking legitimate multi-file exploration ("3 attempts limit 2"). Coarse limit now 3x higher (6 vs 2).

## [2.3.4] - 2026-02-16

### Fixed
- Tool loop guard no longer speculatively inflates counts from stripped conversation history.

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
