# Cursor Model Variants Plan

Status: validated locally against OpenCode `1.14.29` and `cursor-agent` `2026.04.28-e984b46`.

## Goal

Reduce the large `cursor-acp` model list in OpenCode by using model variants, while still calling the exact Cursor model IDs exposed by `cursor-agent models`.

The implementation must be safe when Cursor changes model names weekly. The source of truth should remain `cursor-agent models`, not a hardcoded list in `opencode.jsonc`.

## Current State

The plugin is installed in OpenCode through:

```jsonc
"plugin": [
  "@rama_nigg/open-cursor@latest"
]
```

The configured provider ID is `cursor-acp`.

OpenCode custom provider model IDs are composed as:

```txt
provider_id/model_id
```

Therefore model keys inside `provider.cursor-acp.models` must be unprefixed:

```jsonc
"provider": {
  "cursor-acp": {
    "models": {
      "auto": { "name": "Auto" },
      "gpt-5.3-codex-high": { "name": "Codex 5.3 High" }
    }
  }
}
```

OpenCode then exposes those as:

```txt
cursor-acp/auto
cursor-acp/gpt-5.3-codex-high
```

Do not configure model keys as `cursor-acp/auto`; that causes OpenCode to display `cursor-acp/cursor-acp/auto`.

## Verified Behavior

`cursor-agent` is installed and authenticated on this machine. `cursor-agent models` returns the available Cursor model IDs.

`opencode run --model cursor-acp/auto "Reply with exactly: cursor-auto-ok"` returned the expected model response, proving the provider path works. The process did not exit cleanly in that test, so there is a separate cleanup/hang issue, but the model call itself worked.

`cursor/auto` is invalid because the provider ID is `cursor-acp`, not `cursor`.

`opencode run --help` exposes provider-specific variants:

```txt
--variant model variant (provider-specific reasoning effort, e.g., high, max, minimal)
```

OpenCode's published config schema supports arbitrary model `options` and `variants` entries. The local SDK types also expose:

```ts
type Model = {
  options: Record<string, unknown>;
  variants?: Record<string, Record<string, unknown>>;
};
```

A local OpenAI-compatible capture provider confirmed the important behavior: OpenCode merges the selected variant config into the provider request body before sending it to a custom provider.

The validated config shape was:

```jsonc
"models": {
  "base": {
    "name": "Base",
    "options": {
      "cursorModel": "cursor-base"
    },
    "variants": {
      "high": {
        "cursorModel": "cursor-high"
      },
      "high-fast": {
        "cursorModel": "cursor-high-fast"
      }
    }
  }
}
```

The validated command was:

```txt
opencode run --pure --model variant-capture/base --variant high --title capture-title --format json "capture variant body"
```

The actual main provider request contained:

```json
{
  "model": "base",
  "cursorModel": "cursor-high"
}
```

Therefore this feature can be implemented entirely inside `open-cursor`. No OpenCode upstream change is required for variant propagation.

## Current Cursor Model Shape

At the time of validation, `cursor-agent models` exposed these important patterns:

```txt
gpt-5.3-codex-low / low-fast / base / fast / high / high-fast / xhigh / xhigh-fast
gpt-5.3-codex-spark-preview-low / base / high / xhigh
gpt-5.2-codex-low / low-fast / base / fast / high / high-fast / xhigh / xhigh-fast
gpt-5.1-codex-max-low / low-fast / medium / medium-fast / high / high-fast / xhigh / xhigh-fast
gpt-5.4-low / medium / medium-fast / high / high-fast / xhigh / xhigh-fast
gpt-5.5-medium / high / extra-high
gpt-5.4-mini-none / low / medium / high / xhigh
gpt-5.4-nano-none / low / medium / high / xhigh
claude-opus-4-7-low / medium / high / xhigh / max
claude-opus-4-7-thinking-low / medium / high / xhigh / max
claude-4.6-opus-high / max / high-thinking / max-thinking / max-thinking-fast
grok-4-20 / grok-4-20-thinking
auto
composer-2-fast / composer-2 / composer-1.5
gemini-3.1-pro / gemini-3-flash
gpt-5-mini
kimi-k2.5
```

This means the grouping code must be conservative. Tokens like `mini`, `nano`, and `spark-preview` can be part of the base family name, not necessarily variants. Unknown or ambiguous models must remain direct entries.

## Relevant Code

Model discovery is currently implemented in:

```txt
src/cli/model-discovery.ts
```

It parses `cursor-agent models` into:

```ts
type DiscoveredModel = {
  id: string;
  name: string;
};
```

Model sync is currently implemented in:

```txt
src/models/sync.ts
src/cli/opencode-cursor.ts
```

Current sync behavior is additive only: discovered models are added as direct model entries and existing entries are not removed.

Runtime model normalization is currently implemented in:

```txt
src/provider/boundary.ts
```

`normalizeRuntimeModel()` strips only the provider prefix:

```ts
cursor-acp/gpt-5.3-codex-high -> gpt-5.3-codex-high
```

The actual Cursor call happens in:

```txt
src/plugin.ts
```

The plugin currently derives the runtime model from `body?.model` and spawns:

```txt
cursor-agent --model <model>
```

There is no current mapping from OpenCode variants to different Cursor model IDs.

## Why Cursor Model Mapping Is Still Required

OpenCode variants normally configure different options for the same model. For example, OpenAI can use one base model with options like `reasoningEffort: "high"`.

Cursor exposes many variant-like options as separate real model IDs:

```txt
gpt-5.3-codex-low
gpt-5.3-codex-low-fast
gpt-5.3-codex
gpt-5.3-codex-fast
gpt-5.3-codex-high
gpt-5.3-codex-high-fast
gpt-5.3-codex-xhigh
gpt-5.3-codex-xhigh-fast
```

If OpenCode runs:

```txt
opencode run --model cursor-acp/gpt-5.3-codex --variant high-fast
```

the plugin must resolve that to:

```txt
cursor-agent --model gpt-5.3-codex-high-fast
```

The validated mechanism is to write the real Cursor model ID into `options.cursorModel` for the base entry and into `variants.<name>.cursorModel` for each variant. OpenCode merges that value into the provider request body, and the plugin should prefer `body.cursorModel` over `body.model` when spawning `cursor-agent`.

## Desired User Experience

Instead of dozens of separate Cursor model entries, OpenCode should show compact base models with variants.

Example generated config:

```jsonc
"gpt-5.3-codex": {
  "name": "Codex 5.3",
  "options": {
    "cursorModel": "gpt-5.3-codex"
  },
  "variants": {
    "low": {
      "cursorModel": "gpt-5.3-codex-low"
    },
    "low-fast": {
      "cursorModel": "gpt-5.3-codex-low-fast"
    },
    "fast": {
      "cursorModel": "gpt-5.3-codex-fast"
    },
    "high": {
      "cursorModel": "gpt-5.3-codex-high"
    },
    "high-fast": {
      "cursorModel": "gpt-5.3-codex-high-fast"
    },
    "xhigh": {
      "cursorModel": "gpt-5.3-codex-xhigh"
    },
    "xhigh-fast": {
      "cursorModel": "gpt-5.3-codex-xhigh-fast"
    }
  }
}
```

OpenCode command:

```txt
opencode run --model cursor-acp/gpt-5.3-codex --variant high-fast "..."
```

Cursor command:

```txt
cursor-agent --model gpt-5.3-codex-high-fast
```

## Proposed Design

### 1. Keep Cursor as Source of Truth

Always discover available models from:

```txt
cursor-agent models
```

Do not rely on hardcoded current model names, except for generic suffix parsing rules.

### 2. Add a Grouping Layer

Add a new module, for example:

```txt
src/models/variants.ts
```

Suggested types:

```ts
export type CursorModelVariant = {
  baseId: string;
  variant: string | null;
  cursorModelId: string;
  name: string;
};

export type CursorModelGroup = {
  baseId: string;
  name: string;
  defaultCursorModelId: string;
  variants: Record<string, string>;
  members: CursorModelVariant[];
};
```

The grouping layer should convert discovered model IDs into base models plus variant mappings.

### 3. Use Suffix-Based Parsing

Known suffix tokens should be parsed from the right side of a model ID.

Recommended initial suffix tokens:

```txt
none
low
medium
high
xhigh
extra-high
max
fast
thinking
```

Do not treat every descriptive suffix as a variant. These tokens currently look like base-family qualifiers and should only be grouped when the discovered model set proves a safe base:

```txt
mini
nano
spark-preview
preview
pro
flash
codex
opus
```

Recommended canonical variants:

```txt
low
medium
high
xhigh
max
fast
low-fast
medium-fast
high-fast
xhigh-fast
thinking
thinking-low
thinking-medium
thinking-high
thinking-xhigh
thinking-max
thinking-high-fast
none
extra-high
```

Parser rule:

1. Split the ID on `-`.
2. Walk suffix tokens from right to left.
3. Stop when the remaining base would become too generic or invalid.
4. If a clean base cannot be inferred, leave the model ungrouped.

Important: unknown patterns must not be dropped. They should remain direct model entries.

For ambiguous names, prefer no grouping over clever grouping. For example, `gpt-5.4-mini-low` should become base `gpt-5.4-mini` with variant `low`, not base `gpt-5.4` with variant `mini-low`. `gpt-5-mini` should remain direct unless Cursor exposes a clearly related family.

### 4. Prefer Existing Non-Suffixed Base IDs

If both `gpt-5.3-codex` and `gpt-5.3-codex-high` exist, use `gpt-5.3-codex` as the base model.

If no non-suffixed base exists, choose the safest default in this order:

```txt
medium -> default/no suffix -> high -> low -> first discovered member
```

### 5. Preserve Special Models

Some Cursor models should probably stay direct, not grouped:

```txt
auto
composer-2-fast
composer-2
composer-1.5
kimi-k2.5
gemini-3.1-pro
gemini-3-flash
gpt-5-mini
```

Reason: these are product/model names, not clearly variant families.

### 6. Generate Compact OpenCode Models

Add a variant-aware sync mode:

```txt
open-cursor sync-models --variants
```

This should write compact model entries with `variants` metadata instead of every raw Cursor model ID.

Default behavior can remain unchanged at first to avoid breaking existing users.

### 7. Runtime Resolution

Add a resolver that maps the OpenCode request body to a real Cursor model ID.

Ideal runtime flow:

```txt
OpenCode request body -> body.cursorModel -> cursor-agent --model cursorModel
```

Pseudo-code:

```ts
const baseModel = boundary.normalizeRuntimeModel(body?.model);
const cursorModel = resolveCursorModel({
  requestedModel: baseModel,
  cursorModel: body?.cursorModel,
});
```

Then spawn:

```ts
"cursor-agent", "--model", cursorModel
```

Fallback order:

1. `body.cursorModel` when it is a non-empty string.
2. Normalized `body.model`.
3. `auto`.

This is intentionally simpler than reading the selected variant directly. OpenCode already applies the selected variant and sends the merged custom field to the provider.

### 8. Completed Variant Propagation Spike

The required propagation spike is complete.

First attempt:

```txt
opencode run --pure --model variant-capture/base --variant high --format json "capture variant body"
```

This timed out because OpenCode sent an extra title-generation request before the main request, and the temporary server closed after the first request. That failure was a test harness problem, not evidence against variants.

Second attempt used a more complete local capture server that handled `/models`, repeated `/v1/chat/completions` calls, JSON responses, and SSE streaming. It also set `--title capture-title` so the main request was easy to identify.

Result:

```txt
exit code: 0
assistant response: capture-ok
main request cursorModel: cursor-high
```

Conclusion:

1. `options.cursorModel` is merged into provider requests when no variant overrides it.
2. `variants.high.cursorModel` overrides the base `options.cursorModel` when `--variant high` is selected.
3. `open-cursor` only needs to read the merged `body.cursorModel` field.

## Implementation Phases

### Phase 1: Documentation and Local Repo

Status: complete.

The repository is cloned locally at:

```txt
/Users/rubenbeuker/Documents/opencode-cursor
```

This document captures the current plan.

### Phase 2: Variant Propagation Spike

Status: complete.

OpenCode merges selected variant fields into the custom provider request body. `body.cursorModel` is available to the provider after variant selection.

### Phase 3: Grouping Module

Create `src/models/variants.ts` with pure functions and unit tests.

Test cases should include:

```txt
gpt-5.3-codex-low -> base gpt-5.3-codex, variant low
gpt-5.3-codex-low-fast -> base gpt-5.3-codex, variant low-fast
gpt-5.4-medium-fast -> base gpt-5.4, variant medium-fast
gpt-5.4-mini-low -> base gpt-5.4-mini, variant low
gpt-5.4-nano-none -> base gpt-5.4-nano, variant none
gpt-5.3-codex-spark-preview-high -> base gpt-5.3-codex-spark-preview, variant high
claude-opus-4-7-thinking-high -> base claude-opus-4-7, variant thinking-high
claude-opus-4-7-thinking-high-fast -> base claude-opus-4-7, variant thinking-high-fast
composer-2-fast -> direct model, no grouping
kimi-k2.5 -> direct model, no grouping
```

### Phase 4: Variant-Aware Sync

Extend `src/models/sync.ts` and `src/cli/opencode-cursor.ts` with a variant-aware sync mode.

Requirements:

1. Back up config before writing, like current CLI behavior.
2. Preserve user-defined provider options.
3. Preserve unknown/custom model entries when possible.
4. Do not remove raw models by default until the feature is proven.
5. Add an explicit option for compact rewrite, for example `--compact`.

### Phase 5: Runtime Resolver

Add runtime mapping from the merged OpenCode request body to a Cursor model ID.

Suggested helper:

```ts
resolveRuntimeCursorModel({
  requestedModel,
  cursorModel,
}): string
```

Fallback order:

1. Merged `cursorModel` if present.
2. Normalized requested model.
3. `auto`.

### Phase 6: Tests

Add unit tests for:

1. Cursor model output parsing.
2. Variant grouping.
3. Config generation.
4. Runtime model resolution.
5. Unknown model preservation.

Suggested commands:

```txt
bun test tests/unit/cli/model-discovery.test.ts
bun test tests/unit/models
bun test tests/unit/plugin.test.ts
```

## Migration Strategy for Existing Configs

Do not immediately delete existing raw Cursor models from user config.

Safe rollout:

1. Add `sync-models --variants --dry-run` to preview grouping.
2. Add `sync-models --variants` to add compact base models while keeping raw entries.
3. Add `sync-models --variants --compact` to replace raw grouped entries with compact variants.
4. Keep unknown/unparsed models direct.

This avoids breaking users if the parser misclassifies a new Cursor model name.

## Example Before and After

Before:

```txt
cursor-acp/gpt-5.3-codex-low
cursor-acp/gpt-5.3-codex-low-fast
cursor-acp/gpt-5.3-codex
cursor-acp/gpt-5.3-codex-fast
cursor-acp/gpt-5.3-codex-high
cursor-acp/gpt-5.3-codex-high-fast
cursor-acp/gpt-5.3-codex-xhigh
cursor-acp/gpt-5.3-codex-xhigh-fast
```

After:

```txt
cursor-acp/gpt-5.3-codex
  variants: low, low-fast, fast, high, high-fast, xhigh, xhigh-fast
```

## Acceptance Criteria

The change is successful when:

1. `cursor-agent models` remains the only source of truth for available Cursor models.
2. `opencode.jsonc` can be reduced to compact base models plus variants.
3. `opencode run --model cursor-acp/<base> --variant <variant>` calls the correct real Cursor model ID.
4. Unknown or newly introduced Cursor model names are preserved as direct entries.
5. Existing configs continue to work without requiring immediate migration.
6. Tests cover grouping, sync generation, and runtime resolution.

## Open Questions

1. Should `composer-2-fast` remain direct forever, or become `composer-2` variant `fast`?
2. Should thinking variants be represented as `thinking-high` or as nested dimensions in names only?
3. Should compact sync be opt-in forever, or become default after validation?
