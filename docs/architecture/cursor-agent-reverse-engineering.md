# Reverse-Engineering cursor-agent

How to read cursor-agent's actual behavior so this project can track its wire protocol, tool schemas, and edit semantics across builds. This is interop work: we drive `cursor-agent` as a subprocess and parse its output, so we need its ground truth, not guesses.

- **Last updated:** 2026-07-21
- **Agent build inspected:** `2026.07.17-3e2a980`
- **Scope:** the `cursor-agent` CLI we ship against, not Cursor's ACP channel (oakimov covers that, and it is a different interface).

---

## The key fact: cursor-agent is readable JavaScript on disk

`cursor-agent` is not a compiled binary. The entrypoint is a small Bourne shell launcher; the implementation is a set of Node.js bundles sitting in the version directory:

```
~/.local/share/cursor-agent/versions/<build>/
  cursor-agent          # ~4 KB shell launcher
  *.index.js            # ~67 chunks, ~8 MB total, minified but plain text
```

The bundles are minified (one long line each) but not obfuscated or encrypted. `grep` works directly; a beautifier makes them readable. This is the whole protocol, the tool definitions, the prompt scaffolding, and the request builders, already on the machine. No unpacking, no network capture required to answer most questions.

Worked example (from build `2026.07.17`, chunk `3143.index.js`), the edit builder:

```js
d = fileTooLarge || contentBeforeWrite === undefined
  ? [{ old_string: "", new_string: fileText }]   // full-file replace
  : contentBeforeWrite === fileText ? [] : computeDiffHunks(...)
```

That single expression explains the Composer edit loop documented in [known-limitations.md](../known-limitations.md): when cursor-agent has no diff base (small or freshly written file), it emits an edit as a full-file replace with an empty `old_string`, which this plugin reroutes to `write`. The behavior is cursor-agent's, confirmed at the source.

Tool taxonomy in the same bundle: `shellToolCall`, `grepToolCall`, `editToolCall`, `readToolCall`, `writeToolCall`, `deleteToolCall`, `lsToolCall`.

---

## Recommended method, in order

### 1. Static read of the bundles (primary)

Highest yield, lowest risk, repeatable per build.

```sh
D=~/.local/share/cursor-agent/versions/<build>
# locate a concept
grep -lF "editToolCall" "$D"/*.index.js
# read a minified window without beautifying the whole file
grep -oE '.{120}old_string.{260}' "$D"/3143.index.js
# beautify a chunk for real reading
npx prettier --parser babel "$D"/3143.index.js > /tmp/3143.pretty.js   # or js-beautify
```

Targets worth mapping:
- Tool call cases and their arg shapes (`*ToolCall` → `{path, ...}`), to keep `src/proxy/tool-loop.ts` and `src/acp/tools.ts` aligned.
- Edit construction (full-file vs diff hunks), which drives our reroute logic.
- Stream event framing and `subtype` usage, to match `src/streaming/*`.
- Prompt and system text, to understand why a model emits a given tool shape.

Cross-check findings against what the plugin already parses. Much of this is implicitly known in `src/streaming/*`, `src/proxy/tool-loop.ts`, `src/acp/tools.ts`, and [cursor-agent-tools.md](../cursor-agent-tools.md); the goal is to make it explicit and versioned.

### 2. Behavioral capture (confirmation)

We already do a form of this to fill the tool map. Keep it as a check on the static read, not the main source: run `cursor-agent --print --output-format stream-json` against a fixed prompt battery (read, write, small edit, large edit, bash, grep, glob, ls, multi-tool, plan), save raw NDJSON as fixtures, and diff across builds. Use it to verify that what the bundle says matches what the agent emits.

### 3. Network interception (only if needed)

cursor-agent talks TLS to `api2.cursor.sh` / `api3.cursor.sh` (blob assets on `cursor.blob.core.windows.net`). A proxy such as mitmproxy could show the upstream request and response, but it is the heaviest path and it is not the recommended starting point:

- The client is readable, so how it builds and signs requests, and whether it pins certificates, can be read directly from the bundles instead of intercepted.
- Interception needs cursor-agent to trust a local CA and to skip pinning. Determine both from the source first (`grep -i` for `checkServerIdentity`, `rejectUnauthorized`, proxy env handling) before spending time on a proxy.

Reach for this only when a live upstream payload is the specific unknown.

---

## On the npm route

Getting the source from npm, the way the Claude Code bundle was read, does not apply cleanly here:

- Claude Code is published by its vendor as `@anthropic-ai/claude-code`, so npm is the source.
- On npm, `cursor-agent@1.0.3` and `cursor-cli@1.0.0` exist but use a `1.x` scheme, not Cursor's date builds (`2026.07.17`). They look like third-party wrappers, not Anysphere's official distribution. Treat them as unverified.
- Cursor ships the real agent through its own installer into `~/.local/share/cursor-agent/versions/`, which is what we already have. npm would at best hand back the same minified bundle.

So npm is a dead end for the official build; the local version directory is the authoritative copy.

---

## Legality and handling

This is interoperability analysis of a client we run under our own account on our own machine, to build a compatible integration. Standard practice, same posture as the existing stream-json parser. Keep it to understanding and documenting the protocol. Do not redistribute Cursor's bundle contents; commit our own notes, schemas, and fixtures, not their code.

---

## Maintenance

cursor-agent auto-updates and the protocol drifts between builds (see the version churn already noted in the architecture docs). On each bump:

1. Re-run the static targets above against the new version directory.
2. Re-capture the behavioral fixtures and diff.
3. Record the build number here and in any schema notes, and update the plugin's parser if a tool shape or event changed.
