# ACP Implementation Migration Guide

## What Changed

The plugin now uses **Agent Client Protocol (ACP)** via @agentclientprotocol/sdk. This provides:

- Full ACP compliance (works in Zed, JetBrains, neovim)
- Session persistence (survive crashes)
- Retry logic with exponential backoff
- Enhanced tool metadata (durations, diffs, locations)
- Cursor-native features (usage, status, models)

## Backward Compatibility

The old OpenCode-specific format in `src/index.ts` (lines 1-210) is still available for backward compatibility if needed, but the new default is the ACP implementation via `runAcp()`.

## Migration for Users

**No action required!** The plugin will automatically use ACP mode when loaded by ACP-compliant clients.

If you encounter issues, you can verify ACP is working by checking logs for `[CursorAcpAgent:*]` prefix.

## Configuration

Optional environment variables:

- `CURSOR_AGENT_EXECUTABLE` - Path to cursor-agent binary (default: "cursor-agent")
- `CURSOR_ACP_MAX_RETRIES` - Max retry attempts (default: 3)
- `CURSOR_ACP_BACKOFF_BASE_MS` - Base backoff delay (default: 1000)
- `CURSOR_ACP_SESSION_RETENTION_DAYS` - Session retention (default: 7)
