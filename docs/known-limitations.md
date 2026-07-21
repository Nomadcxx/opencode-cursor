# Known Limitations

A running list of behaviors we understand, have decided not to fix (or not yet), and want to keep visible. Add to it as new ones surface. Each entry says what breaks, why, how far it spreads, and why it stays open.

- **Last updated:** 2026-07-21

---

## Tool handling

### Composer loops when editing very small files

**Symptom.** With Cursor's Composer models, a prompt to edit a file of roughly four lines or fewer can loop. OpenCode shows repeated `Wrote` events instead of an edit, the model reads the tool result as a failure, and it retries the same change until it gives up.

**Cause.** Composer emits a full-file body under `streamContent` for a trivial change rather than a targeted `old_string`/`new_string` edit. The plugin reads that as a full-file edit and reroutes it to `write` (`tryRerouteEditToWrite` in `src/provider/runtime-interception.ts`). The write succeeds, OpenCode surfaces it as `Wrote`, and Composer expected an edit result, so it runs the task again.

**Scope.** Small or degenerate files only. On real content, Composer sends a proper targeted edit and it applies surgically with no loop. We reproduced the loop on a one-line file and confirmed a clean edit on a 47-line file in the same session (2026-07-21, Composer 2.5, cursor-agent `2026.07.09`, opencode 1.18.3). This is why ~700 weekly installs have not reported it: normal editing does not hit the path.

**Why it stays open.** Two gaps sit behind it, both shipped with the original Composer fix and neither introduced by a later regression:

1. The reroute guard `detectSuspiciousStreamContentWrite` only fires for files of five lines or more (`existingLines < 5` returns early). Smaller files skip the guard.
2. `4053f6e` added a `cursorOwnedMutation` / `completed_cursor_edit_success` signal to tell the model an edit already landed, but no caller consumes it. The signal is produced in `runtime-interception.ts` and read nowhere.

Closing either gap means changing how edit and write ownership is signaled back to the model. Commits `72499f4`, `d625421`, and `44364d9` (June 2026) settled that boundary to stop duplicate writes. Reopening it to catch a one-line edge case risks the heavier bug we already fixed. The cost of the fix outweighs the cost of the limitation.

**References.** Composer guard `958d8fe`; mutation classifier `4053f6e`; reroute introduced in `82afd37`. Code: `src/provider/runtime-interception.ts` (`detectSuspiciousStreamContentWrite`, `tryRerouteEditToWrite`, `detectCursorOwnedMutation`).

### applyAgentDiff is an unhandled cursor-owned edit path

**Symptom.** None observed yet. cursor-agent defines an `applyAgentDiffToolCall` that the plugin does not map. If it reaches the stream, the generic normalizer produces `applyagentdiff`, no OpenCode tool matches, and it passes through to cursor-agent.

**Cause.** cursor-agent classifies `applyAgentDiffToolCall` internally as an `edit` and applies the diff itself. The event exposes only `{path}` plus a success/error `result`; the diff body is not in the payload. It is a notification of a cursor-owned mutation, like `editToolCall` in display mode, not an executable request.

**Scope.** Unknown. We have not seen `applyAgentDiff` in any captured stream (Composer used `editToolCall` / `streamContent`). It may appear only under certain models or modes.

**Why it stays open.** Correct handling is recognition, not execution: mark the mutation as cursor-owned so the model gets a completion and does not loop, via the `cursorOwnedMutation` / `completed_cursor_edit_success` signal that `runtime-interception.ts` already produces and no caller consumes. That touches the same edit/write ownership the June 2026 commits stabilized, so it needs its own change and test pass. Mapping it to `edit` for OpenCode to run would double-apply and lacks the diff anyway.

**Testing needed.** Confirm whether `applyAgentDiff` reaches the plugin in real traffic. If it does, wire the `cursorOwnedMutation` consumer and verify no loop and no double-apply.

**References.** cursor-agent bundle `189.index.js` (`applyAgentDiffToolCall: "edit"`, args `{path}`, `.result` success/error). Related: unconsumed `cursorOwnedMutation` in `src/provider/runtime-interception.ts`.

---

## Architecture, speed, performance

To be filled in. Placeholder for per-request `cursor-agent` spawn cost, streaming latency, and related tradeoffs.

---

## Adding an entry

Keep the five parts: symptom, cause, scope, why it stays open, references. Name the file and function, and the commit if there is one. State the reproduction environment with a build number when the behavior depends on Cursor or OpenCode versions.
