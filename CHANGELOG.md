# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
