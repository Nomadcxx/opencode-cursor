/**
 * Maps OpenCode conversation anchors to cursor-agent chat IDs for --resume.
 *
 * OpenCode does not pass its session ID through the HTTP proxy, so we derive a
 * stable key from workspace + model + first real user message in the request.
 *
 * Limitations:
 * - In-memory, non-persistent cache. Restarting the plugin loses all resume
 *   state and the next turn falls back to a full prompt.
 * - Entries expire after 1 hour (DEFAULT_TTL_MS).
 * - Cache is capped at 64 entries (DEFAULT_MAX_ENTRIES); least-recently-used
 *   entry is evicted when the cap is exceeded.
 * - Anchor is derived from the first non-meta user message using a heuristic
 *   filter for OpenCode's title-generation prompts. If OpenCode rewords those
 *   prompts, the filter may need updating.
 * - Session resume is keyed per workspace + model + first-message hash. Changing
 *   any of those starts a fresh chat.
 * - Session resume is only supported for the cursor-agent backend.
 */

import { createHash } from "node:crypto";
import { createLogger } from "../utils/logger.js";
import { extractTextContent, type ProxyMessage } from "./incremental-prompt.js";

const log = createLogger("session-resume");

interface SessionResumeEntry {
  chatId: string;
  /** First-message content prefix used as a collision safety check on lookup. */
  contentPrefix: string;
  /** Fingerprint of the tool schema active when the session was created. */
  toolFingerprint?: string;
  /** Fingerprint of the subagent list active when the session was created. */
  subagentFingerprint?: string;
  updatedAt: number;
}

const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1 hour
const DEFAULT_MAX_ENTRIES = 64;

const cache = new Map<string, SessionResumeEntry>();

/** 128-bit SHA-256 prefix. SHA-256 cost is independent of digest length. */
function simpleHash(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 32);
}

/** Skip OpenCode meta-requests that share the proxy but aren't the main chat.
 *
 * These substrings are observed heuristics, not a stable contract. If OpenCode
 * rewords its title-generation prompt, update this filter.
 */
function isMetaUserMessage(content: string): boolean {
  const lower = content.toLowerCase();
  return (
    lower.includes("title generator") ||
    lower.includes("thread title") ||
    lower.includes("generate a brief title")
  );
}

/**
 * Stable anchor for a conversation: SHA-256 hash of the first non-meta user
 * message content, plus an original-content prefix for collision detection.
 * Assumes `opencode run -c` preserves the opening user message so the anchor
 * remains stable across turns.
 * Returns undefined when no usable user message exists, which tells callers
 * to skip session resume entirely and avoid the collision-prone "default" key.
 */
export function deriveConversationAnchor(
  messages: Array<ProxyMessage>,
): { anchor: string; contentPrefix: string } | undefined {
  for (const message of messages) {
    if (message?.role !== "user") continue;
    const content = extractTextContent(message.content).trim();
    if (!content || isMetaUserMessage(content)) continue;
    return { anchor: simpleHash(content), contentPrefix: content.slice(0, 500) };
  }
  return undefined;
}

/** Build a unique session key from workspace, model, and conversation anchor. */
export function buildSessionKey(workspace: string, model: string, anchor: string): string {
  return `${workspace}\0${model}\0${anchor}`;
}

/** Return whether `CURSOR_ACP_SESSION_RESUME` is enabled (1/true/on/yes). */
export function isSessionResumeEnabled(): boolean {
  const value = process.env.CURSOR_ACP_SESSION_RESUME?.toLowerCase();
  return value === "1" || value === "true" || value === "on" || value === "yes";
}

/**
 * Look up a cached cursor-agent chat ID for the given session key.
 *
 * Validates TTL, content prefix, and tool/subagent fingerprints. A request that
 * supplies a non-empty fingerprint will evict a cached entry that was recorded
 * without that fingerprint (or with a different one), preventing a stale chat
 * from being resumed with an incompatible tool/subagent schema. Returns
 * undefined and evicts stale entries on any mismatch.
 */
export function getResumeChatId(
  sessionKey: string,
  expectedPrefix?: string,
  toolFingerprint?: string,
  subagentFingerprint?: string,
): string | undefined {
  const entry = cache.get(sessionKey);
  if (!entry) return undefined;
  if (Date.now() - entry.updatedAt > DEFAULT_TTL_MS) {
    evictEntry(sessionKey, "ttlExpired", {
      ageMs: Date.now() - entry.updatedAt,
      ttlMs: DEFAULT_TTL_MS,
    });
    return undefined;
  }
  if (expectedPrefix != null && entry.contentPrefix !== expectedPrefix) {
    evictEntry(
      sessionKey,
      "contentPrefixMismatch",
      {
        storedPrefixLength: entry.contentPrefix.length,
        expectedPrefixLength: expectedPrefix.length,
      },
      "warn",
    );
    return undefined;
  }
  if ((toolFingerprint || entry.toolFingerprint) && entry.toolFingerprint !== toolFingerprint) {
    evictEntry(sessionKey, "toolFingerprintMismatch", {}, "warn");
    return undefined;
  }
  if ((subagentFingerprint || entry.subagentFingerprint) && entry.subagentFingerprint !== subagentFingerprint) {
    evictEntry(sessionKey, "subagentFingerprintMismatch", {}, "warn");
    return undefined;
  }
  // Refresh LRU order on a successful read.
  cache.delete(sessionKey);
  cache.set(sessionKey, entry);
  return entry.chatId;
}

/**
 * Check whether a resume chat ID exists without evicting stale entries or
 * refreshing LRU order. Use for observability-only checks (e.g. post-response
 * warnings) where side effects would be incorrect.
 */
export function hasResumeChatId(
  sessionKey: string,
  expectedPrefix?: string,
  toolFingerprint?: string,
  subagentFingerprint?: string,
): boolean {
  const entry = cache.get(sessionKey);
  if (!entry) return false;
  if (Date.now() - entry.updatedAt > DEFAULT_TTL_MS) return false;
  if (expectedPrefix != null && entry.contentPrefix !== expectedPrefix) return false;
  if ((toolFingerprint || entry.toolFingerprint) && entry.toolFingerprint !== toolFingerprint) {
    return false;
  }
  if ((subagentFingerprint || entry.subagentFingerprint) && entry.subagentFingerprint !== subagentFingerprint) {
    return false;
  }
  return !!entry.chatId;
}

/**
 * Store or refresh a chat ID for the given session key.
 *
 * Refreshes LRU insertion order, ignores empty chat IDs, and evicts the
 * least-recently-used entry when the cache exceeds DEFAULT_MAX_ENTRIES.
 */
export function recordResumeChatId(
  sessionKey: string,
  chatId: string,
  contentPrefix: string,
  toolFingerprint?: string,
  subagentFingerprint?: string,
): void {
  if (!chatId) return;
  // Delete first so a re-set moves the key to the end (LRU insertion order).
  cache.delete(sessionKey);
  cache.set(sessionKey, {
    chatId,
    contentPrefix,
    toolFingerprint,
    subagentFingerprint,
    updatedAt: Date.now(),
  });
  while (cache.size > DEFAULT_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    evictEntry(oldest, "maxEntries", { maxEntries: DEFAULT_MAX_ENTRIES });
  }
}

/** Sanitize a session key for logging by hashing the full key (128-bit prefix). */
export function sanitizeSessionKey(sessionKey: string): string {
  return createHash("sha256").update(sessionKey).digest("hex").slice(0, 32);
}

/** Generic helper for hashing arbitrary text before logging. */
export function hashForLog(input: unknown): string {
  return sanitizeSessionKey(typeof input === "string" ? input : String(input ?? ""));
}

/** Evict a stale cache entry with a single, consistent log line. */
function evictEntry(
  sessionKey: string,
  reason: string,
  extra: Record<string, unknown> = {},
  logLevel: "info" | "warn" = "info",
): void {
  const payload = {
    sessionKeyHash: sanitizeSessionKey(sessionKey),
    reason,
    ...extra,
  };
  if (logLevel === "warn") {
    log.warn("Evicting session resume entry", payload);
  } else {
    log.info("Evicting session resume entry", payload);
  }
  cache.delete(sessionKey);
}

/** Remove a cached chat ID, e.g. after a resume-specific cursor-agent failure. */
export function clearResumeChatId(sessionKey: string): void {
  cache.delete(sessionKey);
}

/** @internal Testing only. Gated on NODE_ENV to prevent accidental production wipe. */
export function _resetSessionResumeCache(): void {
  if (process.env.NODE_ENV !== "test") return;
  cache.clear();
}
