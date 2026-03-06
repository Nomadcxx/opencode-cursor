# Cursor ACP + MCP Readiness

## Purpose

This note captures the minimum conditions required before the project should invest in a new ACP + MCP prototype.

## Why This Exists

The preferred long-term direction is `OpenCode -> Cursor ACP -> MCP`, but the project should not move into implementation until that path can stay thin, upstreamable, and free of a second large compatibility layer.

## Entry Criteria

Prototype work should start only when these conditions are true:

- Official Cursor ACP can be launched and authenticated predictably.
- MCP server propagation is confirmed during ACP session setup.
- The required OpenCode-side integration can remain small.
- A large custom MCP bridge is not required for `v1`.

## Evaluation Questions

- Can official Cursor ACP be driven reliably from the intended runtime?
- Does it actually consume MCP server configuration?
- What is the smallest OpenCode integration surface required?
- Which learnings from `open-cursor` remain relevant, and which should not be carried forward?

## Current Outcome

Today, the architecture direction is clear, but the implementation path is deferred. The blocker is not lack of interest in ACP; it is that the official Cursor ACP path does not yet appear reliable enough for the MCP-dependent future state the project actually wants.
