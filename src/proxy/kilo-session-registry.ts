/**
 * Maps Kilo/OpenCode session IDs to cursor-agent resume session keys.
 *
 * Kilo does not send its session ID in chat/completions bodies; the plugin
 * passes it via `X-Kilo-Session-ID` (chat.headers) and links it to the
 * derived resume sessionKey on each proxy request.
 */

import { createLogger } from "../utils/logger.js";
import { clearResumeChatId, hashForLog } from "./session-resume.js";

const log = createLogger("kilo-session");

export const KILO_SESSION_ID_HEADER = "x-kilo-session-id";

const sessionKeysByKiloSession = new Map<string, Set<string>>();
/** Last sessionKey registered for a Kilo session (for chat.params reaffirmation). */
const lastSessionKeyByKiloSession = new Map<string, string>();
const compactionPending = new Set<string>();

/** Ensure a Kilo session is tracked before any sessionKey is known. */
export function trackKiloSession(kiloSessionID: string): void {
  if (!kiloSessionID) return;
  if (!sessionKeysByKiloSession.has(kiloSessionID)) {
    sessionKeysByKiloSession.set(kiloSessionID, new Set());
  }
}

/** Associate a derived resume sessionKey with a Kilo session ID. */
export function registerKiloSessionKey(kiloSessionID: string, sessionKey: string): void {
  if (!kiloSessionID || !sessionKey) return;
  trackKiloSession(kiloSessionID);
  sessionKeysByKiloSession.get(kiloSessionID)!.add(sessionKey);
  lastSessionKeyByKiloSession.set(kiloSessionID, sessionKey);
}

/** Re-add the last known sessionKey for a Kilo session (chat.params hot path). */
export function reaffirmKiloSessionMapping(kiloSessionID: string): void {
  const sessionKey = lastSessionKeyByKiloSession.get(kiloSessionID);
  if (sessionKey) {
    registerKiloSessionKey(kiloSessionID, sessionKey);
  }
}

/**
 * Clear all cached cursor resume entries for a Kilo session, e.g. after compaction.
 * Marks the session so the next HTTP request also skips resume explicitly.
 */
export function clearResumeForKiloSession(kiloSessionID: string): void {
  if (!kiloSessionID) return;
  compactionPending.add(kiloSessionID);
  const keys = sessionKeysByKiloSession.get(kiloSessionID);
  if (keys) {
    for (const sessionKey of keys) {
      clearResumeChatId(sessionKey);
    }
  }
  log.info("Cleared cursor resume cache for Kilo session", {
    sessionIdHash: hashForLog(kiloSessionID),
    sessionKeyCount: keys?.size ?? 0,
  });
}

/**
 * Returns true when the next proxy request for this Kilo session should skip
 * cursor --resume after compaction. Consumes the pending flag (one-shot).
 */
export function consumeCompactionInvalidation(kiloSessionID: string): boolean {
  if (!kiloSessionID || !compactionPending.has(kiloSessionID)) {
    return false;
  }
  compactionPending.delete(kiloSessionID);
  return true;
}

export function readKiloSessionIdFromHeaders(
  headers: Headers | Record<string, string | string[] | undefined>,
): string | undefined {
  if (headers instanceof Headers) {
    const value = headers.get(KILO_SESSION_ID_HEADER);
    return value?.trim() || undefined;
  }
  const raw =
    headers[KILO_SESSION_ID_HEADER]
    ?? headers["X-Kilo-Session-ID"]
    ?? headers["x-kilo-session-id"];
  if (Array.isArray(raw)) {
    return raw[0]?.trim() || undefined;
  }
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

/** @internal Testing only. */
export function _resetKiloSessionRegistry(): void {
  if (process.env.NODE_ENV !== "test") return;
  sessionKeysByKiloSession.clear();
  lastSessionKeyByKiloSession.clear();
  compactionPending.clear();
}

/** @internal Testing only. */
export function _getSessionKeysForKiloSession(kiloSessionID: string): string[] {
  return [...(sessionKeysByKiloSession.get(kiloSessionID) ?? [])];
}
