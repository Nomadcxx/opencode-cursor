# cursor-agent Tool Inventory

This document catalogues tools emitted by cursor-agent and how the plugin handles them.

**Source**: Empirical discovery via `tests/experiments/` harness + Kilo adaptation (2026)

## Tool Flow

```
cursor-agent emits: grepToolCall
         ↓
normalizeToolName(): strips "ToolCall" suffix → "grep"
         ↓
resolveAllowedToolName() / resolveMcpToolName()
         ↓
IF FOUND → action: "intercept" → Kilo executes
IF NOT FOUND → action: "passthrough" → cursor-agent handles (or skip for blocked MCP discovery)
```

## Discovered Tools

### Intercepted (Kilo executes)

| cursor-agent Tool | After Normalization | Kilo Tool | Notes |
|-------------------|--------------------| ---------|-------|
| `grepToolCall` | `grep` | `grep` | Direct match |
| `readToolCall` | `read` | `read` | Direct match |
| `shellToolCall` | `shell` | `bash` | Via alias |
| `editToolCall` | `edit` | `edit` / `oc_edit` | Schema compat |
| `globToolCall` | `glob` | `glob` | Direct match |
| `updateTodosToolCall` | `updateTodos` | `todowrite` | Via alias |
| `mcp__context7__*` | — | `context7_*` | MCP passthrough bridge |
| `CallMcpTool` / `mcpToolCall` | — | Kilo MCP name | Meta extraction |

### Blocked / skipped

| cursor-agent Tool | Behavior |
|-------------------|----------|
| `GetMcpTools` | Skipped — Kilo owns MCP catalog; use tool names from prompt |
| Generic `mcp` | Remapped to `mcp__*` or Kilo name when args include `providerIdentifier` |

When passthrough MCP bridge is active and direct MCP is off, `.cursor/cli.json` sets `deny: ["Mcp(*:*)"]` so cursor-agent does not run its own MCP stack.

### Passthrough (cursor-agent executes)

Tools with no Kilo equivalent and not in the allowlist:

| cursor-agent Tool | Purpose |
|-------------------|---------|
| `semSearchToolCall` | Semantic code search |
| `webFetchToolCall` | Web fetch (if Kilo `webfetch` not in allowlist) |
| `readLintsToolCall` | LSP diagnostics |

## MCP naming

| Convention | Example |
|------------|---------|
| Kilo native | `context7_resolve-library-id` |
| cursor-agent virtual | `mcp__context7__resolve_library_id` |

Hyphens in Kilo names map to underscores in virtual names; interception resolves back to the Kilo name.

## Configuration

### `TOOL_NAME_ALIASES` (`src/proxy/tool-loop.ts`)

Key mappings: `shell`→`bash`, `skillMcp`→`skill_mcp`, `askQuestion`→`question`, etc.

### Env vars

- `CURSOR_KILO_TOOL_LOOP_MODE=opencode` (default) — Kilo owns tools
- `CURSOR_KILO_DIRECT_MCP=true` (default) — stdio MCP from `kilo.jsonc`
- `CURSOR_KILO_DIRECT_MCP=false` — passthrough MCP only (Kilo panel MCP)

## Adding New Tools

1. Run experiment harness or observe stream-json in debug logs
2. Kilo equivalent → add alias if needed; interception is automatic when name is in allowlist
3. cursor-agent-only → document here; passes through automatically
4. Kilo MCP server tool → register in Kilo MCP panel; passthrough bridge maps names automatically

## Experiment Harness

Location: `tests/experiments/`

```bash
python tests/experiments/run_experiments.py
```

See also: `tests/unit/mcp/kilo-bridge.test.ts`, `tests/unit/proxy/tool-loop.test.ts`
