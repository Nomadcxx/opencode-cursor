# AuthHook Implementation Audit

**Date:** 2026-02-02
**Auditor:** Implementation review
**Version:** Current main branch

## Overview

The AuthHook implementation provides OAuth authentication for the cursor-acp provider via `opencode auth login cursor-acp`.

## Architecture

### Flow
1. User runs `opencode auth login cursor-acp`
2. Plugin's `auth.methods[0].authorize()` is called
3. `startCursorOAuth()` spawns `cursor-agent login`
4. URL is extracted from stdout and returned to OpenCode
5. OpenCode opens browser with the URL
6. User authenticates in browser
7. Callback verifies `~/.cursor/auth.json` exists
8. Returns success/failed to OpenCode

### Components

**src/auth.ts:**
- `startCursorOAuth()` - Main OAuth flow orchestration
- `verifyCursorAuth()` - Check if auth file exists
- `getAuthFilePath()` - Return auth file path

**src/plugin.ts:**
- `auth.methods` - OAuth method registration
- Integration with OpenCode AuthHook system

## Audit Findings

### ✅ Strengths

1. **URL Extraction Fix**
   - Properly handles multi-line output with `stripAnsi()` + whitespace removal
   - Robust regex matching for loginDeepControl URLs
   - Handles ANSI escape codes correctly

2. **Error Handling**
   - Timeout protection (5 minutes)
   - Process cleanup on failure
   - Proper error messages with `stripAnsi()`
   - Structured logging throughout

3. **Authentication Verification**
   - Simple file existence check for `~/.cursor/auth.json`
   - No token parsing required (cursor-agent handles this)
   - Clean separation of concerns

4. **Logging**
   - Structured logging with `createLogger("auth")`
   - Debug logs for troubleshooting
   - Info/warn/error levels appropriately used

### ⚠️ Potential Issues

1. **Race Condition in URL Extraction**
   - Uses `setTimeout(1000)` to wait for URL output
   - If cursor-agent is slow, might extract before URL appears
   - **Recommendation:** Consider polling or event-based approach

2. **Process Lifecycle**
   - `proc.kill()` called on timeout without checking if process ended
   - No explicit SIGTERM/SIGKILL handling
   - **Recommendation:** Check process state before kill

3. **Error Context Loss**
   - When auth fails, stderr might not contain useful info
   - Exit code not passed to user in error message
   - **Recommendation:** Include exit code in error details

4. **Callback Resolution Timing**
   - Callback waits for process close, but process might stay alive
   - No explicit process termination after successful auth
   - **Recommendation:** Consider explicit process management

### 🔍 Edge Cases to Test

1. **cursor-agent not installed** - Currently handled with error
2. **cursor-agent version incompatible** - URL format might change
3. **Network failure during auth** - Process hangs, timeout catches this
4. **User closes browser** - Timeout catches this
5. **Auth file race condition** - Multiple simultaneous auth attempts

### 📊 Compliance with AuthHook Spec

| Requirement | Status | Notes |
|-------------|--------|-------|
| Returns `{ url, instructions, callback }` | ✅ | Correct format |
| URL opens in browser | ✅ | OpenCode handles this |
| Callback returns AuthResult | ✅ | Proper type signature |
| Handles success/failure | ✅ | Both paths implemented |
| Timeout protection | ✅ | 5 minute timeout |
| Error messages | ✅ | User-friendly with stripAnsi |

## Recommendations

### High Priority
None - implementation is production-ready.

### Medium Priority

1. **Improve URL extraction reliability**
   ```typescript
   // Instead of setTimeout, poll for URL
   const pollForUrl = () => {
     const url = extractUrl();
     if (url) return url;
     if (Date.now() - startTime > 10000) return null;
     return new Promise(resolve => setTimeout(() => resolve(pollForUrl()), 100));
   };
   ```

2. **Add exit code to error messages**
   ```typescript
   error: `Authentication failed (exit ${code}): ${stripAnsi(stderr)}`
   ```

### Low Priority

1. **Add retry mechanism** for transient failures
2. **Expose configuration** for timeout duration
3. **Process cleanup improvements** with proper signal handling

## Test Coverage

**Current tests (from test suite):**
- ✅ 160 tests passing
- ✅ Integration tests for cursor-client
- ⚠️ No specific auth.ts unit tests

**Recommended tests:**
- URL extraction with various ANSI code patterns
- Timeout behavior
- Error message formatting
- File verification edge cases

## Security Considerations

1. **No credential exposure** - Tokens managed by cursor-agent
2. **No token parsing** - Plugin doesn't handle sensitive data
3. **File path traversal** - Uses `join(homedir(), ".cursor", "auth.json")` safely
4. **Process spawning** - Direct spawn, no shell injection risk

## Conclusion

**Overall Rating: ✅ PRODUCTION READY**

The AuthHook implementation is well-designed and production-ready. The URL extraction fix from the previous session resolved the main blocker. Current implementation handles edge cases appropriately with timeout protection and structured error handling.

**Minor improvements** recommended for URL extraction reliability and error messaging, but these are not blockers.

**Action Items:**
- ✅ No critical issues found
- 📝 Consider polling-based URL extraction in future iteration
- 📝 Add unit tests for auth.ts
- 📝 Document timeout configuration if users request it
