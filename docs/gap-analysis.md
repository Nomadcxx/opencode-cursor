# Gap Analysis: opencode-cursor vs Competing Projects

**Date**: 2026-01-23
**Project**: nomadcxx/opencode-cursor
**Compared Against**: 15+ Cursor integration projects

---

## Executive Summary

Our implementation is a **minimal stdin/stdout wrapper** (~220 lines) focused on solving the E2BIG argument limit problem. While this is valid for the stated goal, the competing ecosystem has significantly more feature-rich implementations that we should consider adopting or documenting.

**Key Finding**: The ecosystem is rapidly evolving from simple HTTP proxies to **Agent Client Protocol (ACP)** support, which is becoming the standard for AI tool integration.

---

## 1. Direct Comparison: roshan-c/cursor-acp (Most Similar)

| Feature | Our Plugin (nomadcxx/opencode-cursor) | roshan-c/cursor-acp | Gap |
|-----------|-------------------------------------------|----------------------|-----|
| **Protocol** | Custom OpenAI-compatible format | **Agent Client Protocol (ACP)** | ❌ We don't use ACP standard |
| **Streaming** | Manual line buffering | **NDJSON with proper framing** | ⚠️ Both work, but ACP is standard |
| **Tool Calls** | Pass-through (no execution) | **Full tool call mapping** (read, write, grep, glob, bash) | ❌ We don't map tools to OpenCode format |
| **Modes** | None | **Default + Plan mode** | ❌ No mode switching |
| **Cancellation** | Basic SIGTERM | **Proper cancellation + flush** | ⚠️ We have cleanup but ACP has better protocol |
| **Session Mgmt** | Single session | **Multiple sessions with resume** | ❌ No session ID tracking |
| **Auth** | Validates cursor-agent login | **Auth methods exposed** | ⚠️ Both validate, but ACP is richer |
| **Model Discovery** | Static ("auto") | **Dynamic from cursor-agent** | ⚠️ Both work, ACP is more standard |
| **Delta Streaming** | Sends full text each chunk | **Delta-only to avoid duplicates** | ⚠️ We could adopt this optimization |
| **Lines of Code** | ~220 | ~445 | 📊 ACP is ~2x more code (for good reason) |
| **Stars** | 0 | 10 | ⚠️ ACP adapter has community traction |

### What roshan-c/cursor-acp Does Better

**ACP Protocol Integration** (from [cursor-agent.ts#L37-L86](https://github.com/roshan-c/cursor-acp/blob/main/src/internal/cursor-agent.ts#L37-L86)):
```typescript
async initialize(req: InitializeRequest): Promise<InitializeResponse> {
  return {
    protocolVersion: 1,
    agentCapabilities: {
      promptCapabilities: { image: false, embeddedContext: true },
    },
    authMethods: [
      {
        id: "cursor-login",
        name: "Log in with Cursor Agent",
        description: "Run `cursor-agent login` in your terminal",
      },
    ],
  };
}
```

**Our Equivalent** (from [index.ts#L14-L39](https://github.com/nomadcxx/opencode-cursor/blob/main/src/index.ts#L14-L39)):
```typescript
auth: {
  provider: "cursor-acp",
  loader: async (getAuth) => {
    const check = await client.$`cursor-agent --version`.quiet().nothrow();
    if (check.exitCode !== 0) {
      return { type: "failed", message: "cursor-agent not found..." };
    }
    return { type: "success", key: "cursor-agent", data: { email: whoamiText } };
  },
  methods: [...]
}
```

**Gap**: We use custom OpenCode auth format, ACP uses standardized protocol with richer capabilities negotiation.

---

## 2. Feature Gap Matrix

### 2.1 Critical Gaps (Should Consider)

| Gap | Description | Impact | Competitors With It | Recommendation |
|------|-------------|---------|-------------------|----------------|
| **ACP Protocol Support** | We use custom format instead of Agent Client Protocol | 🔴 High - Becoming de facto standard | roshan-c/cursor-acp, Zed, JetBrains, multiple clients | **IMPLEMENT** or **DOCUMENT** why we don't use ACP |
| **Tool Call Execution** | We don't execute tools, just pass through | 🟡 Medium - Limits full agent capabilities | cursor-ai-bridge, yet-another-opencode-cursor-auth | **IMPLEMENT** if OpenCode expects tool execution |
| **Session Management** | No session IDs, no resume support | 🟡 Medium - Can't recover from interruption | roshan-c/cursor-acp (session_id tracking) | **ADD** session ID tracking + resume logic |
| **Mode Support** | No plan/analysis mode | 🟢 Low - Nice to have but not critical | roshan-c/cursor-acp (default + plan modes) | **OPTIONAL** - Add if users request it |
| **Cancellation Protocol** | We kill process but don't flush updates | 🟡 Medium - Poor UX on cancel | roshan-c/cursor-acp (flushes before sending cancelled) | **IMPROVE** - Flush final updates on SIGTERM |

### 2.2 Moderate Gaps (Nice to Have)

| Gap | Description | Impact | Competitors With It | Recommendation |
|------|-------------|---------|-------------------|----------------|
| **Delta Streaming** | We send full text, can cause duplicates | 🟢 Low - Minor UX issue | roshan-c/cursor-acp (delta-only streaming) | **ADOPT** - Track last text and send deltas only |
| **Model Discovery** | We hardcode "auto", they query cursor-agent | 🟢 Low - Both work, ACP is cleaner | roshan-c/cursor-acp (dynamic model listing) | **OPTIONAL** - Keep simple for now |
| **Auth Methods** | We just validate, they expose methods | 🟢 Low - Both work, ACP is richer | roshan-c/cursor-acp (exposes auth methods in capabilities) | **OPTIONAL** - Not necessary for our use case |
| **Error Classification** | Basic throw vs recoverable/fatal distinction | 🟢 Low - Better UX on retry | cursor-opencode-auth, antigravity (retry/backoff) | **CONSIDER** - Add if we add retry logic |
| **Toast Notifications** | No user feedback during operations | 🟢 Low - Better UX | antigravity, cursor-ai-bridge (toasts) | **OPTIONAL** - Add if UI feedback needed |
| **Structured Logging** | console.log/error scattered | 🟢 Low - Harder to debug | antigravity (log module) | **OPTIONAL** - Add logger utility |
| **Metrics/Telemetry** | No usage tracking | 🟢 Low - Users want insights | cursor-ai-bridge (real-time metrics) | **OPTIONAL** - Add if users request it |

### 2.3 What We Do Better (Our Advantages)

| Feature | Our Implementation | Competitors | Why This Matters |
|---------|-------------------|-------------|------------------|
| **Simplicity** | ~220 LOC, single file | roshan-c: ~445 LOC, multiple files | **Easier to maintain, audit, understand** |
| **Zero Config** | Works out of the box | cursor-opencode-auth: requires keychain, macOS only | **Cross-platform, no external deps** |
| **No Proxy Server** | Direct stdin/stdout | cursor-opencode-auth, cursor-ai-bridge: require HTTP server | **No daemon, lower attack surface** |
| **Minimal Dependencies** | Only @opencode-ai/plugin | roshan-c: requires @agentclientprotocol/sdk | **Smaller bundle, faster install** |
| **Bun-Native** | Built with Bun, fast startup | Many are Node.js | **Modern runtime, better performance** |
| **Clear Documentation** | Focused on solving E2BIG | Some projects have confusing setup | **Users understand the problem we solve** |

---

## 3. Architecture Comparison

### 3.1 Our Current Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                   OpenCode Plugin                    │
│  ┌──────────────────────────────────────────────────┐  │
│  │         opencode-cursor (220 LOC)           │  │
│  │                                             │  │
│  │  ┌──────────────────────────────────────┐      │  │
│  │  │   OpenCode API (custom format)     │      │  │
│  │  └──────────────────────────────────────┘      │  │
│  │              │                                │      │
│  │              ▼                                │      │
│  │  ┌──────────────────────────────────────┐      │  │
│  │  │   cursor-agent (subprocess)        │      │  │
│  │  │   stdin: prompt                      │      │  │
│  │  │   stdout: json-stream               │      │  │
│  │  └──────────────────────────────────────┘      │  │
│  │                                             │  │
│  └──────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘

Protocol: Custom OpenAI-like JSON
Transport: stdin/stdout
Complexity: Low
Purpose: Fix E2BIG argument limit
```

### 3.2 roshan-c/cursor-acp Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                   OpenCode Plugin                    │
│  ┌──────────────────────────────────────────────────┐  │
│  │         cursor-acp (445 LOC)                │  │
│  │                                             │  │
│  │  ┌──────────────────────────────────────┐      │  │
│  │  │   Agent Client Protocol (ACP)           │  │  │
│  │  │   - Standardized capabilities            │  │
│  │  │   - Session management                 │  │
│  │  │   - Tool call mapping                │  │
│  │  │   - Mode switching (default/plan)      │  │
│  │  └──────────────────────────────────────┘      │  │
│  │              │                                │  │
│  │              ▼                                │  │
│  │  ┌──────────────────────────────────────┐      │  │
│  │  │   cursor-agent (subprocess)        │  │
│  │  │   stdin: prompt                      │  │
│  │  │   stdout: ndjson-stream             │  │
│  │  └──────────────────────────────────────┘      │  │
│  │                                             │  │
│  └──────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘

Protocol: Agent Client Protocol (ACP)
Transport: ndjson (newline-delimited JSON)
Complexity: Medium
Purpose: Universal ACP compatibility (Zed, JetBrains, neovim, etc.)
```

### 3.3 cursor-opencode-auth Architecture (HTTP Proxy)

```
┌─────────────────────────────────────────────────────────────┐
│                   OpenCode                          │
│  ┌──────────────────────────────────────────────────┐  │
│  │       @ai-sdk/openai-compatible               │  │
│  │                                             │  │
│  │  ┌──────────────────────────────────────┐      │  │
│  │  │   HTTP → 127.0.0.1:4141          │      │  │
│  │  └──────────────────────────────────────┘      │  │
│  │              │                                │  │
│  │              ▼                                │  │
│  │  ┌──────────────────────────────────────┐      │  │
│  │  │   cursor-opencode-auth (proxy)       │  │
│  │  │   - Token extraction (macOS keychain) │  │
│  │  │   - Model list (15+ models)          │  │
│  │  │   - Streaming (SSE)                  │  │
│  │  └──────────────────────────────────────┘      │  │
│  │              │                                │  │
│  │              ▼                                │  │
│  │  ┌──────────────────────────────────────┐      │  │
│  │  │   Cursor API (Connect-RPC/Protobuf)  │  │
│  │  │   - api2.cursor.sh                    │  │
│  │  │   - agentn.api5.cursor.sh             │  │
│  │  └──────────────────────────────────────┘      │  │
│  └──────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘

Protocol: Cursor Connect-RPC (reverse-engineered)
Transport: HTTP/HTTPS with SSE
Complexity: High
Purpose: Universal OpenAI-compatible proxy for any client
```

---

## 4. Detailed Gap Analysis

### 4.1 ACP Protocol - The Missing Standard

**What is ACP?**
The **Agent Client Protocol (ACP)** is becoming the de facto standard for AI tool integration. It provides:
- Standardized session management
- Universal tool call format
- Mode switching (default/plan/analyze)
- Cancellation semantics
- Auth method negotiation

**Why This Matters:**
- **Multi-Client Compatibility**: ACP plugins work in Zed, JetBrains, neovim (via avante.nvim), AionUi, marimo
- **Future-Proof**: OpenCode and other IDEs are adopting ACP
- **Better UX**: Richer error messages, status updates, tool call progress

**Our Current Approach:**
We use a **custom OpenAI-like JSON format** that only OpenCode understands. This means:
- ❌ Won't work in other IDEs (Zed, JetBrains)
- ❌ Limited to OpenCode only
- ❌ No standardized error codes
- ❌ No tool call progress updates

**Decision Required:**
1. **Option A**: Migrate to ACP (significant refactor, ~2x code size)
   - Pro: Universal compatibility, better UX
   - Con: More complexity, loses simplicity advantage
   - Effort: 2-3 days

2. **Option B**: Stay simple, document trade-offs
   - Pro: Maintain simplicity, focused on OpenCode
   - Con: Single-platform only
   - Effort: 0 hours

3. **Option C**: Dual-mode (ACP + custom OpenAI)
   - Pro: Best of both worlds
   - Con: Most complex to maintain
   - Effort: 2-4 days

**Recommendation**: Stay simple for now (Option B), but document why. Consider ACP if OpenCode officially adopts it or users request it.

---

### 4.2 Tool Calling - Do We Need It?

**Current State:**
We don't execute tools. cursor-agent handles tool execution internally, and we just pass results through.

**Competitor Approaches:**

| Project | Tool Call Strategy | Lines of Code | Complexity |
|---------|-------------------|----------------|------------|
| **cursor-ai-bridge** (9★) | Maps cursor-agent tools → ACP format | ~300 lines | Medium |
| **yet-another-opencode-cursor-auth** (30★) | Experimental, bash/read/write/grep | ~200 lines | High |
| **roshan-c/cursor-acp** (10★) | Maps cursor-agent tools → ACP format | ~150 lines | Medium |
| **Our Plugin** (0★) | **None - let cursor-agent handle it** | 0 lines | None |

**Analysis:**

**Why We Don't Need Tool Execution:**
- ✅ cursor-agent has **native tool calling** - it can run commands, read files, search
- ✅ Cursor IDE shows tool results **in its own UI** - we don't need to render them
- ✅ Simpler to maintain - no tool result parsing/mapping

**When We Would Need Tool Execution:**
If OpenCode expected us to:
1. **Execute tools on behalf of user** (e.g., run bash commands)
2. **Show tool results in OpenCode's UI**
3. **Handle tool cancellation** (user aborts mid-tool-run)

**But OpenCode's design:**
- OpenCode is a **TUI/terminal agent**, not an IDE plugin
- cursor-agent runs tools in user's **actual terminal/editor**
- OpenCode just orchestrates the conversation, not file operations

**Conclusion**: **Our approach is correct** for OpenCode. Tool execution is cursor-agent's job, not ours.

---

### 4.3 Session Management - Nice to Have?

**Current State:**
```typescript
// We don't track sessions
async "chat.params"(input, output) {
  const child = spawn("cursor-agent", args, {...});
  // Process...
  child.on("close", () => {
    // No session ID, no resume capability
  });
}
```

**roshan-c/cursor-acp Approach:**
```typescript
// Tracks multiple concurrent sessions
private sessions: Record<string, SessionState> = {};

async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
  const id = cryptoRandomId();
  this.sessions[id] = {
    cwd: params.cwd,
    cancelled: false,
    modeId: "default",
    resumeId: undefined,  // Set from result
  };
  return { sessionId: id, ... };
}

async prompt(params: PromptRequest): Promise<PromptResponse> {
  const session = this.sessions[params.sessionId];
  if (session.resumeId) {
    args.push("--resume", session.resumeId);  // Resume conversation!
  }
  // ...
}
```

**Do We Need This?**

| Use Case | Our Plugin | With Session Mgmt | Verdict |
|----------|-------------|------------------|---------|
| **Single OpenCode session** | ✅ Works | ✅ Also works | Tie - no advantage |
| **Multiple OpenCode windows** | ✅ Separate processes | ✅ Separate sessions | Tie - each spawns own cursor-agent |
| **Resume interrupted conversation** | ❌ Can't resume | ✅ Can resume | **Win for session mgmt** |
| **Cancel and retry** | ⚠️ Kill process, start fresh | ✅ Cancel specific session, preserve others | **Win for session mgmt** |

**Recommendation**: **IMPLEMENT session ID tracking**. Minimal effort, provides:
- Resume capability on interruption
- Better cancellation semantics
- Compatibility with ACP clients

**Implementation (~30 lines):**
```typescript
// Add to src/index.ts
private sessions: Record<string, { cancelled: boolean, resumeId?: string }> = {};

async "chat.params"(input, output) {
  const sessionId = crypto.randomUUID(); // Node 18+ or polyfill
  this.sessions[sessionId] = { cancelled: false };

  // In child result handler:
  if (evt.session_id && !session.resumeId) {
    session.resumeId = evt.session_id;
  }

  // In cancel handler:
  if (this.sessions[sessionId]) {
    this.sessions[sessionId].cancelled = true;
  }
}
```

---

### 4.4 Delta Streaming - UX Optimization

**Current State (from [index.ts#L120-L158](https://github.com/nomadcxx/opencode-cursor/blob/main/src/index.ts#L120-L158)):**
```typescript
for await (const chunk of child.stdout) {
  const data = JSON.parse(line.slice(6));
  const delta = data.choices?.[0]?.delta?.content;
  if (delta) {
    await output.write({
      // We send FULL text from delta
      choices: [{ index: 0, delta: { content: delta } }]
    });
  }
}
```

**Problem**: If cursor-agent sends incremental text like "He" → "Hello" → "Hello World", we send:
1. `{ delta: "He" }`
2. `{ delta: "Hello" }`
3. `{ delta: "Hello World" }`

Client receives: "He" → "Hello" → "Hello World" (cumulative) ✅ **This is actually correct!**

**Wait - We're Doing It Right!**

Looking at the code again, we extract `delta.content` which IS the incremental text. OpenCode accumulates these deltas. We're not sending duplicates.

**roshan-c/cursor-acp Optimization** (from [cursor-agent.ts#L354-L362](https://github.com/roshan-c/cursor-acp/blob/main/src/internal/cursor-agent.ts#L354-L362)):
```typescript
// Tracks last assistant text to avoid duplicates
let lastAssistantText = "";
if (evt.type === "assistant") {
  const text = evt?.message?.content?.[0]?.text ?? "";
  if (text && text !== lastAssistantText) {
    const delta = text.startsWith(lastAssistantText)
      ? text.slice(lastAssistantText.length)  // Only new text
      : text;  // Full text (no overlap)
    if (delta) {
      out.push({ sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: delta } } });
    }
    lastAssistantText = text;
  }
}
```

**The Difference**:
- **Us**: Always send delta if present (trust cursor-agent)
- **roshan-c**: Compares to last text, deduplicates at plugin level

**Conclusion**: We're **already doing delta streaming correctly**. The roshan-c approach adds extra safety but adds complexity. Our current implementation is fine.

---

### 4.5 Cancellation - Can We Improve?

**Current State** (from [index.ts#L111-L118](https://github.com/nomadcxx/opencode-cursor/blob/main/src/index.ts#L111-L118)):
```typescript
const cleanup = () => {
  clearTimeout(timeoutId);
  if (!child.killed) {
    child.kill("SIGTERM");
  }
};
process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);
```

**roshan-c/cursor-acp Approach** (from [cursor-agent.ts#L200-L211](https://github.com/roshan-c/cursor-acp/blob/main/src/internal/cursor-agent.ts#L200-L211)):
```typescript
async cancel(params: CancelNotification): Promise<void> {
  const session = this.sessions[params.sessionId];
  session.cancelled = true;
  const child = session.running;
  if (child && !child.killed) {
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 1000);  // Double-tap!
  }
}

// In prompt handler:
const finalize = () => {
  if (session.cancelled) return resolve({ stopReason: "cancelled" });
  // Otherwise resolve with actual reason...
  if ((rl as any).closed) return finalize();
  const timer = setTimeout(finalize, 300);  // Flush delay
  rl.once("close", () => {
    clearTimeout(timer);
    finalize();
  });
};
```

**Key Differences:**
| Aspect | Our Plugin | roshan-c/cursor-acp |
|---------|-------------|---------------------|
| **Session tracking** | No | Yes (cancelled flag) |
| **Double-tap kill** | SIGTERM only | SIGTERM + 1000ms SIGKILL |
| **Flush delay** | None | 300ms to ensure rl closes |
| **Stop reason** | Always "stop" | "cancelled" vs actual reason |

**Should We Improve?**
| Priority | Change | Effort | Impact |
|---------|---------|---------|---------|
| 🟢 Low | Add double-tap kill | 5 lines | Ensures process dies |
| 🟢 Low | Add flush delay | 10 lines | Ensures all data sent |
| 🟡 Medium | Add session tracking | ~50 lines | Enables proper "cancelled" response |

**Recommendation**: Add if users report issues with cancellation (e.g., cursor-agent hanging). Current approach is adequate for most cases.

---

## 5. Patterns from Antigravity (What Should We Adopt?)

### 5.1 Structured Logging

**Antigravity Pattern** (7,200 LOC project):
```typescript
function createLogger(module: string) {
  return {
    debug: (message: string, meta?: unknown) => console.debug(`[${module}] ${message}`, meta),
    info: (message: string, meta?: unknown) => console.info(`[${module}] ${message}`, meta),
    warn: (message: string, meta?: unknown) => console.warn(`[${module}] ${message}`, meta),
    error: (message: string, error?: unknown) => console.error(`[${module}] ${message}`, error)
  };
}

const log = createLogger("cursor");
log.info("Spawning cursor-agent", { version: "1.2.3" });
```

**Our Current State:**
```typescript
console.error(`cursor-agent exited with code ${exitCode}: ${stderr}`);
```

**Recommendation**: **ADOPT** structured logging. Minimal effort (~20 lines), improves debugging significantly.

**Implementation:**
```typescript
// Add to src/index.ts
function createLogger(prefix: string) {
  return {
    debug: (msg: string, meta?: any) => console.error(`[cursor:${prefix}] ${msg}`, meta),
    info: (msg: string, meta?: any) => console.error(`[cursor:${prefix}] ${msg}`, meta),
    warn: (msg: string, meta?: any) => console.error(`[cursor:${prefix}] ${msg}`, meta),
    error: (msg: string, err?: any) => console.error(`[cursor:${prefix}] ${msg}`, err)
  };
}

const log = createLogger("main");
log.info("Starting cursor-agent", { model, stream });
```

### 5.2 Error Classification

**Antigravity Pattern:**
```typescript
function isRecoverableError(stderr: string, exitCode: number): boolean {
  // Recoverable: timeout, network error, rate limit
  if (stderr.includes("timeout") || stderr.includes("ECONNREFUSED")) return true;
  if (exitCode === 124 || exitCode === 137) return true;  // SIGTERM/SIGKILL

  // Fatal: auth error, invalid model
  if (stderr.includes("Not logged in")) return false;
  if (stderr.includes("invalid model")) return false;

  return false;
}

// In handler:
if (exitCode !== 0) {
  if (isRecoverableError(stderr, exitCode)) {
    // Retry...
  } else {
    throw new Error(...);
  }
}
```

**Our Current State:**
```typescript
if (exitCode !== 0) {
  throw new Error(`cursor-agent exited with code ${exitCode}${stderr ? `: ${stderr}` : ""}`);
}
```

**Recommendation**: **CONSIDER** adding retry logic. But this adds complexity. For now, simple error throwing is adequate.

### 5.3 Toast Notifications

**Antigravity Pattern:**
```typescript
await client.tui.showToast({
  body: {
    message: "cursor-agent not found. Install with: curl -fsSL https://cursor.com/install | bash",
    variant: "error"
  }
});
```

**Our Current State:**
No UI feedback - just throw errors.

**Recommendation**: **OPTIONAL** - Only add if we have UI feedback. For terminal OpenCode, console errors may be sufficient.

---

## 6. Recommendations Summary

### 6.1 Immediate Actions (This Week)

| Priority | Action | Effort | Impact |
|---------|---------|---------|---------|
| 🟢 **1. Add structured logging** | ~20 lines | Better debugging for users |
| 🟢 **2. Document ACP vs custom format** | Add to README section | Manage user expectations |
| 🟢 **3. Add session ID tracking** | ~50 lines | Resume capability |
| 🟡 **4. Improve cancellation** | ~20 lines | Better UX on cancel |

### 6.2 Consider for Future (This Month)

| Priority | Action | Effort | Impact |
|---------|---------|---------|---------|
| 🟡 **1. Evaluate ACP migration** | Research + design | Universal compatibility |
| 🟡 **2. Add retry logic** | ~100 lines | Better error recovery |
| 🟢 **3. Add metrics/telemetry** | ~50 lines | User insights (optional) |
| 🟢 **4. Add health check endpoint** | ~30 lines | Debugging aid |

### 6.3 Do Not Implement (Anti-Patterns)

| Idea | Why to Avoid |
|------|--------------|
| **Tool execution in plugin** | cursor-agent does this better |
| **HTTP proxy server** | Adds daemon complexity, defeats simplicity goal |
| **Multi-account support** | cursor-agent manages its own auth |
| **OAuth callback server** | cursor-agent handles auth |
| **Complex retry/backoff** | cursor-agent has its own retry logic |
| **Endpoint fallback** | cursor-agent manages its own endpoints |

---

## 7. Final Verdict

### Our Position in Ecosystem

```
Simplicity ───────────────────────────> Functionality
    ▲                                   │
    │        Antigravity (7,200 LOC) │
    │  ◀─────────────────────────────│
    │        roshan-c/cursor-acp (445 LOC)
    │      ◀───────────────────────────│
    │      cursor-opencode-auth (~300 LOC)
    │     ◀───────────────────────────│
    │     opencode-cursor-auth (~200 LOC)
    │    ◀────────────────────────────│
    │    yet-another-opencode-cursor-auth (~250 LOC)
    │   ◀───────────────────────────│
    │   nomadcxx/opencode-cursor (220 LOC) ◀────────
    ▼                                   │
    ───────────────────────────────────
```

**We're in the "Sweet Spot":**
- ✅ **Simpler** than HTTP proxy approaches (no daemon)
- ✅ **More focused** than ACP adapters (solves E2BIG specifically)
- ✅ **Cross-platform** (works on Linux/Mac/Windows)
- ✅ **Zero-config** (just install cursor-agent and run)

**Trade-offs We Made:**
- ❌ Single-platform (OpenCode only)
- ❌ No session resume
- ❌ Basic cancellation
- ❌ No tool call execution (but this is correct for our use case)

**When These Become Problems:**
1. Users complain about resume capability → Add session tracking
2. Users want multi-IDE support → Migrate to ACP
3. Debugging is hard → Add structured logging

---

## 8. Next Steps

### Option A: Stay the Course (Recommended)
**Philosophy**: Minimal, focused, solves E2BIG problem excellently

**Actions**:
1. ✅ Add structured logging (~20 lines)
2. ✅ Document why we use custom format vs ACP
3. ✅ Add session ID tracking if requested
4. ❌ Do NOT add ACP support (premature optimization)
5. ❌ Do NOT add tool execution (cursor-agent handles this)
6. ❌ Do NOT add HTTP proxy (defeats simplicity)

**Timeline**: 2-3 hours
**Risk**: Low

---

### Option B: ACP Migration (Ambitious)
**Philosophy**: Universal compatibility, future-proof

**Actions**:
1. Implement ACP protocol interface
2. Add session management
3. Add tool call mapping
4. Add mode switching (default/plan)
5. Add auth method negotiation
6. Rewrite to use @agentclientprotocol/sdk

**Timeline**: 2-3 days
**Risk**: Medium (adds complexity, may introduce bugs)

---

### Option C: Hybrid Approach (Balanced)
**Philosophy**: Support both OpenCode custom format AND ACP

**Actions**:
1. Add feature flag: `ACP_MODE=true`
2. Dual path: OpenCode custom format if false, ACP if true
3. Gradual migration path
4. Document trade-offs

**Timeline**: 4-5 days
**Risk**: High (most complex to maintain)

---

## 9. Conclusion

Our **opencode-cursor** implementation is **well-positioned** for its stated goal:

**Strengths:**
- ✅ Simple and maintainable (220 LOC vs 7,200 LOC)
- ✅ Solves E2BIG problem elegantly (stdin/stdout)
- ✅ Zero configuration (works out of the box)
- ✅ Cross-platform (no keychain or platform deps)
- ✅ Fast (Bun runtime, no daemon)

**Gaps vs Competition:**
- ⚠️ No ACP protocol support (but custom format works for OpenCode)
- ⚠️ No session resume (nice to have, not critical)
- ⚠️ Basic cancellation (works, could be improved)
- ⚠️ No structured logging (easy to add)

**Decision: Stay Simple for Now**

Our implementation is **correct for our use case**. The competing projects serve different goals:
- **roshan-c/cursor-acp**: Universal ACP adapter (works in 5+ IDEs)
- **cursor-opencode-auth**: OpenAI-compatible proxy (works with any OpenAI client)
- **antigravity**: Production-grade OAuth plugin (multi-account, retry logic)

**Our Goal**: Fix E2BIG for OpenCode users → **ACHIEVED**

**When to Evolve:**
- If users request session resume → Add it (~50 lines)
- If OpenCode adopts ACP → Consider migration (~2-3 days)
- If debugging issues → Add logging (~20 lines)

**Final Note:**
> "Perfection is achieved, not when there is nothing more to add, but when there is nothing more to take away." - Antoine de Saint-Exupéry

We've achieved our goal elegantly. Don't over-engineer. Stay simple. Stay focused.
