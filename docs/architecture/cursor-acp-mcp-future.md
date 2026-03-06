# Cursor ACP + MCP Future Architecture

## Purpose

This document defines the preferred long-term direction for the project after the current `open-cursor` bridge architecture.

It is a future-state architecture document, not an implementation plan. It exists to make the direction explicit, preserve the reasoning behind it, and avoid drifting into more custom compatibility work before the underlying ecosystem is ready.

## Current State

`open-cursor` is a working bridge built around an OpenCode-specific provider and proxy path. It exists because an earlier ACP-first approach did not become reliable enough for production use in this project.

The current architecture proved that Cursor-backed usage inside OpenCode is valuable. It also preserved important operational lessons around auth UX, subprocess management, streaming behavior, and tool handling. However, it is still a custom bridge architecture rather than the preferred long-term shape.

## Future State

The preferred future architecture is:

`OpenCode -> Cursor ACP -> MCP`

In that future state:

- OpenCode remains the host and UI.
- Cursor ACP becomes the backend agent interface.
- MCP servers are passed through from OpenCode to Cursor ACP during ACP session setup.
- Tool execution remains agent-side and MCP-side rather than being reimplemented in a custom compatibility layer.
- The ideal eventual upstream outcome is a small OpenCode integration surface, with minimal custom code specific to Cursor.

This means the real target is not "port `open-cursor` to ACP." The target is to replace the need for most of `open-cursor` with a thinner native ACP + MCP path.

## Architectural Principle

The future system should respect protocol ownership:

- ACP should handle agent transport and session semantics.
- MCP should handle tool and server interoperability.
- OpenCode should not own a large custom translation or runtime layer if official ACP + MCP can satisfy the product requirements.

This principle matters because the current bridge architecture is useful precisely as a bridge. It should not become the permanent architecture if the ecosystem now offers a more standard path.

## Why ACP + MCP Is The Best Path

ACP + MCP is the preferred long-term path for several reasons:

- It aligns with the broader ecosystem direction: ACP is becoming the standard editor-to-agent boundary, while MCP is becoming the standard tool/server boundary.
- It matches how Cursor is now being integrated into external clients such as JetBrains, which makes the path strategically relevant rather than speculative.
- It reduces the amount of custom protocol translation this project would otherwise need to own indefinitely.
- It preserves the correct ownership model: agent backends should manage agent behavior and MCP tools, while OpenCode should remain focused on host UX and provider integration.
- It gives the best chance of an eventual upstream OpenCode contribution that maintainers can reasonably accept, because the ideal end state is a small native integration rather than a large compatibility subsystem.

## Why Not Keep Evolving The Current Architecture

The current `open-cursor` architecture should not be stretched into the long-term ACP solution.

Reasons:

- The current system is optimized for the custom proxy and provider-boundary path, not for native ACP backend integration.
- Extending it further risks preserving the bridge architecture as the permanent architecture.
- The repository already shows how easily historical experiments and transitional layers can accumulate and blur the true direction.
- Building more custom protocol glue now would increase migration cost later and weaken the case for a small upstream integration.

In short: the current system should remain the practical current solution while the preferred future remains blocked, but it should not define the long-term architecture.

## Current Constraint

The preferred future depends on official Cursor ACP correctly accepting and using MCP server configuration during ACP session setup.

At present, that does not appear reliable enough for this project's requirements.

Without MCP propagation, the ACP path loses too much of the tool and server behavior that makes the current bridge valuable. Because MCP interoperability is part of the reason to move to ACP at all, this is not a minor gap; it cuts into the core value of the future architecture.

## Why The Project Is Not Moving Yet

The project is not moving to the future architecture yet because the key dependency appears blocked today:

- Official Cursor ACP appears to ignore `mcpServers` supplied during ACP `session/new`.

That is a practical blocker for `OpenCode -> Cursor ACP -> MCP`.

The project should not paper over that limitation with a large custom workaround unless the tradeoff is revisited explicitly. A custom MCP bridge layered on top of Cursor ACP would risk recreating the same kind of custom compatibility infrastructure the project is trying to move away from.

That kind of workaround could easily become another transitional system that is difficult to upstream and harder to remove later.

## Decision Gate

Revisit implementation when official Cursor ACP supports MCP server propagation well enough to preserve the intended ownership model and keep the OpenCode integration thin.

Until that gate is met, the project should:

- treat `open-cursor` as the practical current solution,
- keep roadmap messaging honest about the preferred future,
- avoid committing to a premature rewrite,
- and avoid building a second large custom compatibility layer in the name of ACP.

## Migration Outlook

`open-cursor` remains the practical current solution while the ACP + MCP path is blocked.

The future architecture should be treated as a replacement direction, not as a near-term rewrite of the current codebase. If the blocker is resolved, the next step should likely be a small prototype built around official Cursor ACP rather than an in-place evolution of the current proxy architecture.

Any eventual OpenCode contribution should aim to keep the maintainership burden low by upstreaming only the minimal backend and provider integration needed for the native ACP path.

Until then, roadmap messaging should acknowledge the preferred future architecture, explain why it is deferred, and link readers to this document for detail.

## References

- OpenCode issue `#2072`
- OpenCode PR `#5095`
- Official Cursor ACP discussions and JetBrains integration announcements
- Current `open-cursor` architecture and roadmap materials in this repository
