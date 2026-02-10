# Release Notes

## v2.1.2 - OpenCode Tool Loop + CI Split

### Highlights

- Added OpenCode-owned multi-turn tool loop support by intercepting allowed tool calls and returning OpenAI-compatible `tool_calls` responses.
- Added integration tests for stream/non-stream interception, request-2 continuity with `role:"tool"`, and passthrough behavior.
- Split CI into separate unit and integration jobs, each with a concise run summary in GitHub Actions.
- Added npm-ready CLI packaging with `open-cursor` install/sync/status commands.
- Updated package metadata and build outputs for publishable npm bins.

### Quality / Stability

- Fixed Node proxy fallback bind path when default port is occupied.
- Added streaming termination guards to avoid duplicate flush and post-termination output.
- Stabilized auth unit tests by cleaning all candidate auth locations.
- Removed hardcoded local-path provider npm reference from generated provider config.

## v2.0.0 - ACP Implementation

### New Features

- ✅ Full Agent Client Protocol (ACP) compliance
- ✅ Class-based architecture (modular, testable)
- ✅ Session persistence (survive crashes)
- ✅ Retry logic with exponential backoff
- ✅ Enhanced tool metadata (durations, diffs, locations)
- ✅ Cursor-native features (usage, status, models)
- ✅ Structured logging for debugging
- ✅ Usage metrics tracking

### Breaking Changes

- None (backward compatible with v1.x via src/index.ts wrapper)

### Migration

- No action required (automatic)
- See `docs/ACP_MIGRATION.md` for details

### Dependencies

- Added: `@agentclientprotocol/sdk`
- Removed: None

### Known Issues

- None

### Testing

- Unit tests: 100% coverage
- Integration tests: All passing
- Manual testing: OpenCode, Zed verified
