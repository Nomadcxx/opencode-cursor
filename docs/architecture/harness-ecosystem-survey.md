# Harness Ecosystem Survey (July 2026)

- **Purpose:** Phase 0 research for a harness-agnostic Cursor bridge. Decides which harnesses to target and in what order.
- **Data gathered:** 2026-07-09 (GitHub API, npm registry API, vendor docs, web review)
- **Companion:** [cursor-acp-mcp-future.md](cursor-acp-mcp-future.md) covers the Cursor-side blockers this survey takes as given.

---

## Framing

"Cursor models in other harnesses" splits into two products, because harnesses expose two integration planes:

- **Model plane:** the harness talks to a model API and owns tools, permissions, and the loop. Our proxy plays the model. This inherits the tool-ownership fight (blocker C1): the bridge must keep extracting tool calls from Cursor's stream.
- **Agent plane:** the harness dispatches composer as a subagent that runs its own loop and returns results. Cursor owning tools is the contract, and C1 stops mattering.

Each harness below gets scored on both planes.

---

## The market

Numbers from 2026-07-09. npm counts are directional: Claude Code and Codex also ship native binaries, and Crush installs via Homebrew/Go, so npm undersells some of them.

| Harness | GitHub stars | npm/month | Trajectory | Notes |
|---|---|---|---|---|
| OpenCode (`anomalyco/opencode`) | 184,039 | 9.5M | Dominant OSS harness | Our current host |
| Claude Code (`anthropics/claude-code`) | 136,988 | 47.6M | Consensus default for paid work | Proprietary |
| Gemini CLI → Antigravity CLI | 105,862 (old repo) | 2.2M, falling | Google retired Gemini CLI May 19; Antigravity CLI (Go) replaces it June 18 | Multi-model: Gemini, Claude, GPT-OSS |
| Codex CLI (`openai/codex`) | 96,508 | 48.4M | #1 npm volume | Open source client |
| Zed (`zed-industries/zed`) | 86,695 | n/a | Editor, primary ACP client | Hosts Cursor ACP agent today |
| OpenHands | 80,148 | n/a | Autonomous/SWE-bench lineage | Different category |
| pi (`earendil-works/pi`) | 69,020 | 7.8M | Fastest riser; Ronacher + Zechner | Minimal core, extension-first |
| Cline | 64,476 | n/a | IDE extension | VS Code plane |
| goose (`aaif-goose/goose`) | 50,891 | n/a | Block; MCP-native | |
| aider | 47,205 | n/a | No pushes since May 22 | Fading |
| Crush (`charmbracelet/crush`) | 26,284 | 19.5k (brew-first) | Steady, niche | |
| Qwen Code | 25,891 | n/a | Regional strength | Gemini CLI fork lineage |
| Roo-Code | 24,311 | n/a | **Archived May 2026** | Exclude |
| Copilot CLI (`github/copilot-cli`) | 10,924 | 4.2M | Enterprise distribution | ACP agent since Jan 2026 |

Reading: two proprietary giants (Claude Code, Codex) carry ~95M monthly npm installs between them. OpenCode leads open source with pi rising fast behind it. The Gemini CLI slot is churning into Antigravity. Aider and Roo are exits.

---

## Integration surfaces

What each harness officially exposes for plugging in a foreign model or agent.

| Harness | Model plane | MCP client | Agent dispatch | ACP client |
|---|---|---|---|---|
| Claude Code | Anthropic Messages API via `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_MODEL` ([documented env vars](https://code.claude.com/docs/en/env-vars)) | Yes | Subagents (`.claude/agents`) + MCP tools; `claude mcp serve` proves agent-in-agent | Via adapter |
| Codex CLI | OpenAI chat completions via `[model_providers]` `base_url` + `wire_api = "chat"` ([documented](https://developers.openai.com/codex/config-advanced)) | Yes | MCP tools | Via adapter |
| OpenCode | Any AI SDK provider via `opencode.json` (our plugin today) | Yes | Subagents + MCP | Ships ACP server, no client |
| pi | `registerProvider` with `baseUrl`, `api: "openai-completions"` ([documented](https://pi.dev/docs/latest/custom-provider)) | No built-in; extensions add it | Extensions | No |
| Antigravity CLI | Multi-model built in; custom-provider surface unverified | Yes, shared `~/.gemini/config/mcp_config.json` | MCP tools | Google ships against ACP spec |
| Copilot CLI | BYO endpoint unverified | Yes | MCP tools | Agent side since Jan 2026 |
| Crush | OpenAI-compatible custom providers | Yes | MCP tools | No |
| Zed / JetBrains | n/a (editors) | Yes | n/a | Yes; both host Cursor's ACP agent today |

Three conclusions fall out:

1. **Two protocols cover the model plane.** OpenAI chat completions reaches Codex, pi, Crush, OpenCode, and most of the long tail; our proxy speaks it today. The Anthropic Messages API reaches Claude Code, the single largest paid audience, and we lack that facade.
2. **MCP is the universal agent plane.** Claude Code, Codex, Copilot, Antigravity, OpenCode, Crush, goose, and Zed are all MCP clients. One MCP dispatch server covers the entire table in a single artifact.
3. **ACP is a third lane, already documented.** Zed and JetBrains host Cursor's ACP agent now, with the tool-ownership caveats in [cursor-acp-mcp-future.md](cursor-acp-mcp-future.md). The [ACP registry](https://github.com/agentclientprotocol/agent-client-protocol) launched January 2026 with 25+ agents. For dispatch (rather than hosting), MCP reaches more harnesses with less protocol work.

---

## Prior art

### Model plane: proven demand

- [claude-code-router](https://github.com/musistudio/claude-code-router) (35,708 stars, active): re-points Claude Code at arbitrary backends. The category's existence proof.
- [meridian](https://github.com/rynfar/meridian) (1,628 stars, pushed daily): bridges a Claude Max subscription into OpenCode, pi, Droid, Aider, Crush, and Cline. The exact mirror image of our product: subscription X into harness Y. Its README doubles as a target-harness list.
- LiteLLM, CLIProxyAPI, claude-code-proxy: general Anthropic↔OpenAI gateways. They translate protocols and know nothing about Cursor's agent loop, auth, or stream-json. They are complements, and our differentiation is the Cursor-specific layer.

### Agent plane: pattern proven, Cursor niche empty

- [steipete/claude-code-mcp](https://github.com/steipete/claude-code-mcp) (1,310 stars) and the built-in `claude mcp serve` normalize agent-in-agent dispatch.
- [sub-agents-mcp](https://github.com/shinpr/sub-agents-mcp) (92 stars) dispatches markdown-defined agents through Cursor CLI, Claude Code, Codex, or Gemini backends.
- Cursor-specific wrappers: [cursor-agent-mcp](https://github.com/sailay1996/cursor-agent-mcp) (21 stars, dead since Aug 2025), cursor-subagent-mcp (2 stars), cursor-cloud-agent-mcp (5 stars). All three predate composer 2.5 or target the cloud API. Nobody maintains a serious "dispatch local composer via MCP" server. The niche is open.

### Our position

open-cursor is the maintained OpenCode↔Cursor bridge. The hard assets (stream-json normalization, tool-call extraction, loop guards, mcptool, auth handling) are host-agnostic in substance and OpenCode-shaped in packaging.

---

## Risk notes

- **Harness-side TOS: low on the model plane.** Claude Code documents its base-URL override; Codex documents custom providers; pi documents `registerProvider`. We would use supported extension points, the same ones claude-code-router and meridian build on.
- **Cursor-side TOS: unchanged gray.** Driving cursor-agent locally against a paid subscription is today's bridge posture. Composer outside Cursor's UX stays a gray zone whichever harness hosts it.
- **Cost blowups scale with adapters.** The February 2026 report on [#2072](https://github.com/anomalyco/opencode/issues/2072) of a prompt burning $150 through broken caching is the failure mode to engineer against. Loop guards, cache-aware request shaping, and spend ceilings belong in the shared core so each new adapter inherits them instead of reinventing them.
- **Model-plane facades inherit C1 per harness.** Wherever the host owns tools, our tool-loop extraction must hold up against composer's preference for running its own loop. The agent plane avoids this class of bug entirely.
- **Antigravity churn.** The Gemini→Antigravity migration is weeks old. Let it settle before spending adapter effort there.

---

## What the data says for phasing

1. **Core extraction first (unchanged).** Everything below multiplies its value.
2. **Agent plane, MCP dispatch server: strongest new bet.** Universal client support, zero credible competition, C1-immune, and it matches the "dispatch composer 2.5 inside Claude Code/Codex" demand directly.
3. **Anthropic Messages facade next.** Claude Code is the largest single audience; claude-code-router and meridian prove people wire subscriptions into it through this exact seam.
4. **OpenAI-compat adapters are recipes.** The proxy exists; Codex and pi support means a config stanza plus compat testing each. pi goes first: momentum, documented provider API, and a hackable host for any UX experiments.
5. **ACP stays a watch item** per [cursor-acp-mcp-future.md](cursor-acp-mcp-future.md). Zed/JetBrains users already reach Cursor through ACP without us.

Open questions for the design phase:

- Does the MCP dispatch server run cursor-agent per-call or manage persistent sessions with progress polling?
- Which core pieces are extractable as-is vs entangled with OpenCode plugin hooks? (An import-graph pass on `src/` answers this.)
- Does the Anthropic facade need extended-thinking and cache-control round-tripping for Claude Code to behave, and what does composer's stream lose in translation?

---

## Sources

GitHub star/activity counts and npm download totals: GitHub API and npm registry API, 2026-07-09. Integration surfaces: [Claude Code env vars](https://code.claude.com/docs/en/env-vars), [Codex advanced config](https://developers.openai.com/codex/config-advanced), [pi custom providers](https://pi.dev/docs/latest/custom-provider), [Antigravity MCP docs](https://antigravity.google/docs/mcp), [ACP project](https://github.com/agentclientprotocol/agent-client-protocol). Market commentary cross-checked against [State of CLI Coding Agents, Mid-2026](https://blog.arcbjorn.com/state-of-cli-coding-agents-2026), [kilo.ai CLI agent comparison](https://kilo.ai/articles/best-cli-coding-agents), and [morphllm's agent ranking](https://www.morphllm.com/ai-coding-agent).
