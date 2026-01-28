# OpenCode Cursor Plugin

OpenCode plugin that provides Cursor Agent integration via stdin communication (fixes E2BIG errors with large prompts).

## Installation

```bash
# Install as OpenCode plugin
ln -s /path/to/opencode-cursor/dist/index.js ~/.config/opencode/plugin/cursor-acp.js

# Or install via npm (when published)
npm install opencode-cursor
```

## Configuration

Add to your `~/.config/opencode/opencode.json`:

```json
{
  "models": {
    "cursor": {
      "provider": "cursor-acp",
      "model": "cursor-acp/auto"
    }
  }
}
```

## Environment Variables

- `CURSOR_AGENT_EXECUTABLE` - Path to cursor-agent binary (default: `cursor-agent`)

## Features

- **Stdin-based communication** - Avoids E2BIG errors with large prompts
- **Streaming support** - Real-time response streaming
- **Session management** - ACP-compliant session tracking
- **Tool mapping** - Converts Cursor tool events to ACP format
- **Metrics tracking** - Prompt and tool call metrics
- **Retry logic** - Automatic retry with exponential backoff

## Available Models

| Model ID | Description |
|----------|-------------|
| `cursor-acp/auto` | Auto-select best available model |

## Development

```bash
# Install dependencies
bun install

# Build
bun run build

# Run tests
bun test

# Run specific test suite
bun test tests/unit
bun test tests/integration

# Watch mode
bun run dev
```

## Project Structure

```
src/
├── acp/
│   ├── sessions.ts    # Session management
│   ├── tools.ts       # Tool event mapping
│   └── metrics.ts     # Metrics tracking
├── client/
│   └── simple.ts      # Cursor agent client
├── utils/
│   └── logger.ts      # Logging utility
├── index.ts           # Main exports
└── provider.ts        # AI SDK provider

tests/
├── unit/              # Unit tests
├── integration/       # Integration tests
└── fixtures/          # Test fixtures
```

## API

### SimpleCursorClient

```typescript
import { SimpleCursorClient } from 'opencode-cursor';

const client = new SimpleCursorClient({
  cursorAgentPath: 'cursor-agent',
  timeout: 30000,
  maxRetries: 3
});

// Execute prompt
const result = await client.executePrompt('Hello', {
  model: 'auto',
  mode: 'default'
});

// Stream response
for await (const line of client.executePromptStream('Hello')) {
  console.log(line);
}
```

### SessionManager

```typescript
import { SessionManager } from 'opencode-cursor/acp/sessions';

const manager = new SessionManager();
await manager.initialize();

const session = await manager.createSession({ cwd: '/project' });
console.log(session.id);
```

### ToolMapper

```typescript
import { ToolMapper } from 'opencode-cursor/acp/tools';

const mapper = new ToolMapper();
const updates = await mapper.mapCursorEventToAcp(cursorEvent, sessionId);
```

### MetricsTracker

```typescript
import { MetricsTracker } from 'opencode-cursor/acp/metrics';

const tracker = new MetricsTracker();
tracker.recordPrompt(sessionId, 'gpt-4', 150);
tracker.recordToolCall(sessionId, 'bash', 500);

const metrics = tracker.getAggregateMetrics(24); // Last 24 hours
```

## Testing

All tests pass:

```bash
$ bun test
bun test v1.3.6

  ✓ SessionManager (6 tests)
  ✓ ToolMapper (35 tests)
  ✓ MetricsTracker (6 tests)
  ✓ RetryEngine (5 tests)
  ✓ CursorAgent Integration (3 tests)

  55 pass
  0 fail
  108 expect() calls
```

## Automated Testing

Run the automated test script:

```bash
./test-all.sh
```

This runs:
- Unit tests
- Integration tests
- Build verification
- Lint checks (if configured)
- Smoke tests

## License

ISC
