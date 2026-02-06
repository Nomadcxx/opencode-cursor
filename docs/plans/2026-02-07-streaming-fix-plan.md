# Fix Streaming + Tool Calls + Thinking (Issue #9)

**Status**: NOT IMPLEMENTED  
**Issue**: https://github.com/Nomadcxx/opencode-cursor/issues/9  
**Goal**: Fix streaming so responses arrive incrementally, with full tool_call and thinking support  

## Architecture

```
cursor-agent (stream-json) → JSON lines on stdout → parse events → convert to OpenAI SSE → client
```

**Three files to fix**:
- `src/client/simple.ts` — standalone cursor-agent client (direct mode)
- `src/plugin.ts` — Bun/Node.js HTTP proxy (plugin mode, **primary code path**)
- `src/provider.ts` — AI SDK provider wrapping both modes

**Key decisions**:
- Switch from `--output-format text` to `--output-format stream-json` everywhere
- Add `--stream-partial-output` flag everywhere
- Clean break — no backward compatibility with text mode
- Full tool_call + thinking forwarding

## cursor-agent stream-json format (reference)

Each line is a JSON object. Known event types:
```json
{"type": "assistant", "message": {"content": [{"text": "..."}]}}
{"type": "tool_call", "name": "...", "arguments": "...", "id": "..."}
{"type": "thinking", "content": "..."}
```

The exact format needs validation by running cursor-agent with `--output-format stream-json` and observing output. Step 1 below handles this.

## OpenAI SSE format (target output)

```
data: {"id":"...","object":"chat.completion.chunk","created":...,"model":"...","choices":[{"index":0,"delta":{"content":"text"},"finish_reason":null}]}

data: {"id":"...","object":"chat.completion.chunk","created":...,"model":"...","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_...","type":"function","function":{"name":"...","arguments":"..."}}]},"finish_reason":null}]}

data: [DONE]
```

---

## Implementation Steps

### Step 1: Discover cursor-agent stream-json format
**Files**: none (research only)  
**Action**: Run `echo "Hello" | cursor-agent --print --output-format stream-json --stream-partial-output --model auto --workspace /tmp` and capture the raw output. Document the exact JSON line format for: assistant text, tool calls (if any), thinking/reasoning, completion signal. Save sample output as `tests/fixtures/stream-json-sample.jsonl` for use in tests.

**Verify**: File exists with real cursor-agent output lines.

---

### Step 2: Create stream-json parser module
**Files**: `src/streaming/parser.ts` (new)  
**Action**: Create a module that parses cursor-agent stream-json lines into typed events.

```typescript
// Types based on Step 1 findings
export interface CursorTextEvent { type: 'text'; content: string }
export interface CursorToolCallEvent { type: 'tool_call'; id: string; name: string; arguments: string }
export interface CursorThinkingEvent { type: 'thinking'; content: string }
export interface CursorDoneEvent { type: 'done' }
export interface CursorErrorEvent { type: 'error'; message: string }
export type CursorEvent = CursorTextEvent | CursorToolCallEvent | CursorThinkingEvent | CursorDoneEvent | CursorErrorEvent

export function parseCursorLine(line: string): CursorEvent | null
```

**Test first**: `tests/unit/streaming-parser.test.ts`
- Test parsing each event type from Step 1 fixtures
- Test invalid JSON returns null
- Test empty/blank lines return null
- Test unknown event types are handled gracefully

**Verify**: `npm test -- tests/unit/streaming-parser.test.ts` passes

---

### Step 3: Create OpenAI SSE formatter module
**Files**: `src/streaming/formatter.ts` (new)  
**Action**: Create a module that converts `CursorEvent` objects into OpenAI-compatible SSE chunk strings.

```typescript
export function cursorEventToSSEChunk(
  event: CursorEvent,
  id: string,
  created: number,
  model: string
): string | null
// Returns: "data: {...}\n\n" or null if event should be skipped

export function createDoneSSE(): string
// Returns: "data: [DONE]\n\n"
```

Mapping:
- `CursorTextEvent` → `delta: { content: text }`
- `CursorToolCallEvent` → `delta: { tool_calls: [{ index, id, type: "function", function: { name, arguments } }] }`
- `CursorThinkingEvent` → `delta: { content: thinking_text }` (with a metadata field or role annotation — check what OpenCode expects)
- `CursorDoneEvent` → finish_reason: "stop" chunk + `[DONE]`

**Test first**: `tests/unit/streaming-formatter.test.ts`
- Test each event type produces valid SSE
- Test JSON.parse on the data payload succeeds
- Test [DONE] format is correct
- Test null returned for unknown events

**Verify**: `npm test -- tests/unit/streaming-formatter.test.ts` passes

---

### Step 4: Create line buffering utility
**Files**: `src/streaming/line-buffer.ts` (new)  
**Action**: Create a utility that buffers raw binary chunks into complete lines. cursor-agent outputs one JSON object per line, but chunks from stdout may split mid-line.

```typescript
export class LineBuffer {
  push(chunk: string): string[]  // Returns complete lines
  flush(): string | null          // Returns remaining partial line
}
```

**Test first**: `tests/unit/line-buffer.test.ts`
- Test single complete line
- Test line split across two chunks
- Test multiple lines in one chunk  
- Test flush returns partial data
- Test empty chunks

**Verify**: `npm test -- tests/unit/line-buffer.test.ts` passes

---

### Step 5: Fix plugin.ts — Bun streaming path
**Files**: `src/plugin.ts`  
**Action**: Modify the Bun handler (lines 169-264) to:

1. Change cmd args from `--output-format text` to `--output-format stream-json` and add `--stream-partial-output`
2. In the streaming ReadableStream (L227-264):
   - Use `LineBuffer` to buffer chunks into complete lines
   - Use `parseCursorLine()` on each line
   - Use `cursorEventToSSEChunk()` to format SSE output
   - Enqueue formatted SSE chunks
3. In the non-streaming path (L192-220):
   - Collect all stdout, parse all JSON lines
   - Extract final assistant text + any tool calls
   - Return proper `chat.completion` response with tool_calls in choices

**Test**: Run existing `tests/unit/plugin.test.ts` — should still pass (or update mocks for new format)

**Verify**: `npm test -- tests/unit/plugin.test.ts` passes

---

### Step 6: Fix plugin.ts — Node.js streaming path
**Files**: `src/plugin.ts`  
**Action**: Modify the Node.js handler (lines 376-509) with same changes as Step 5:

1. Change cmd args from `--output-format text` to `--output-format stream-json` and add `--stream-partial-output`
2. In streaming `child.stdout.on('data')` handler (L455-471):
   - Use `LineBuffer` to buffer chunks into complete lines
   - Parse + format each line as SSE
3. In non-streaming `child.on('close')` handler (L400-443):
   - Parse JSON lines from stdout
   - Build proper response with tool_calls

**Test**: Same as Step 5

**Verify**: `npm test -- tests/unit/plugin.test.ts` passes

---

### Step 7: Fix simple.ts — streaming client
**Files**: `src/client/simple.ts`  
**Action**: Fix `executePromptStream()` (L33-145):

1. Change `--output-format text` to `--output-format stream-json` (L53-54)
2. **Remove the `await streamEnded` blocking call** (L128-129) — this is THE streaming bug
3. Yield lines incrementally as they arrive from stdout instead of collecting into array first
4. Use `LineBuffer` for proper chunk-to-line buffering

New flow:
```
stdout.on('data') → LineBuffer.push() → for each complete line → yield line
```

Also fix `executePrompt()` (L147-248):
1. Change `--output-format text` to `--output-format stream-json`
2. Parse JSON lines for all event types, not just `assistant`

**Test**: Update any tests that mock simple.ts behavior

**Verify**: `npm test` — all tests pass

---

### Step 8: Fix provider.ts — event type handling
**Files**: `src/provider.ts`  
**Action**: In `doStream()` (L177-248):

1. Handle `tool_call` events from cursor-agent (currently skipped at L225)
2. Handle `thinking` events
3. Emit proper OpenAI chunk types for each event

In `doGenerate()` (L123-171):
1. Parse all event types from non-streaming response
2. Include tool_calls in response if present

**Test**: Verify provider returns tool_calls and thinking content

**Verify**: `npm test` passes

---

### Step 9: Integration test with real cursor-agent
**Files**: `tests/integration/streaming.test.ts` (new)  
**Action**: Write an integration test that:
1. Spawns cursor-agent with `--output-format stream-json --stream-partial-output`
2. Sends a simple prompt
3. Verifies lines arrive incrementally (not all at once)
4. Verifies JSON parsing succeeds on each line
5. Verifies at least one `assistant` event is present

Mark as `.skip` if cursor-agent not available in CI.

**Verify**: Test passes locally with cursor-agent installed

---

### Step 10: Run full test suite + build
**Action**: 
```bash
npm test
npm run build
```

Fix any failures. Ensure no regressions.

**Verify**: Exit code 0 for both commands.

---

## Risks & Open Questions

1. **cursor-agent stream-json format is undocumented** — Step 1 validates the actual format before any code is written. If the format differs from our assumptions, Steps 2-3 adjust accordingly.
2. **Tool calls may not appear in stream-json** — cursor-agent may not emit tool_call events at all in print mode. Step 1 will reveal this.
3. **Thinking events may have different format** — some models emit thinking as a separate event, others embed it. Step 1 resolves this.
4. **OpenCode's expectations for thinking content** — need to check what delta format OpenCode expects for reasoning/thinking tokens. May need `reasoning_content` field instead of `content`.

## Files Changed Summary

| File | Change |
|------|--------|
| `src/streaming/parser.ts` | NEW — cursor-agent JSON line parser |
| `src/streaming/formatter.ts` | NEW — OpenAI SSE chunk formatter |
| `src/streaming/line-buffer.ts` | NEW — stdout line buffering |
| `src/plugin.ts` | Switch to stream-json, parse + format SSE properly |
| `src/client/simple.ts` | Fix await blocking, switch to stream-json |
| `src/provider.ts` | Handle tool_call + thinking events |
| `tests/unit/streaming-parser.test.ts` | NEW |
| `tests/unit/streaming-formatter.test.ts` | NEW |
| `tests/unit/line-buffer.test.ts` | NEW |
| `tests/fixtures/stream-json-sample.jsonl` | NEW — real cursor-agent output |
| `tests/integration/streaming.test.ts` | NEW |
