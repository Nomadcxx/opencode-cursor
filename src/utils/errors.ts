// src/utils/errors.ts

export type ErrorType = "quota" | "auth" | "network" | "model" | "unknown";

export interface ParsedError {
  type: ErrorType;
  recoverable: boolean;
  message: string;
  userMessage: string;
  details: Record<string, string>;
  suggestion?: string;
}

/**
 * Strip ANSI escape codes from string
 */
export function stripAnsi(str: string): string {
  if (typeof str !== "string") return String(str ?? "");
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

/**
 * Parse cursor-agent error output into structured format
 */
export function parseAgentError(stderr: string | unknown): ParsedError {
  const input = typeof stderr === "string" ? stderr : String(stderr ?? "");
  const clean = stripAnsi(input).trim();

  // Quota/usage limit error
  if (clean.includes("usage limit") || clean.includes("hit your usage limit")) {
    const savingsMatch = clean.match(/saved \$(\d+(?:\.\d+)?)/i);
    const resetMatch = clean.match(/reset[^0-9]*(\d{1,2}\/\d{1,2}\/\d{4})/i);
    const modelMatch = clean.match(/continue with (\w+)/i);

    const details: Record<string, string> = {};
    if (savingsMatch) details.savings = `$${savingsMatch[1]}`;
    if (resetMatch) details.resetDate = resetMatch[1];
    if (modelMatch) details.affectedModel = modelMatch[1];

    return {
      type: "quota",
      recoverable: false,
      message: clean,
      userMessage: "You've hit your Cursor usage limit",
      details,
      suggestion: "Switch to a different model or set a Spend Limit in Cursor settings",
    };
  }

  // Authentication error
  if (clean.includes("not logged in") || clean.includes("auth") || clean.includes("unauthorized")) {
    return {
      type: "auth",
      recoverable: false,
      message: clean,
      userMessage: "Not authenticated with Cursor",
      details: {},
      suggestion: "Run: opencode auth login → Other → cursor-acp, or: cursor-agent login",
    };
  }

  // Network error
  if (clean.includes("ECONNREFUSED") || clean.includes("network") || clean.includes("fetch failed")) {
    return {
      type: "network",
      recoverable: true,
      message: clean,
      userMessage: "Connection to Cursor failed",
      details: {},
      suggestion: "Check your internet connection and try again",
    };
  }

  // Model not found / not available
  if (clean.includes("model not found") || clean.includes("invalid model") || clean.includes("Cannot use this model")) {
    // Extract model name and available models from error
    const modelMatch = clean.match(/Cannot use this model: ([^.]+)/);
    const availableMatch = clean.match(/Available models: (.+)/);

    const details: Record<string, string> = {};
    if (modelMatch) details.requested = modelMatch[1];
    if (availableMatch) details.available = availableMatch[1].split(", ").slice(0, 5).join(", ") + "...";

    return {
      type: "model",
      recoverable: false,
      message: clean,
      userMessage: modelMatch ? `Model '${modelMatch[1]}' not available` : "Requested model not available",
      details,
      suggestion: "Use cursor-acp/auto or check available models with: cursor-agent models",
    };
  }

  // Unknown error
  const recoverable = clean.includes("timeout") || clean.includes("ETIMEDOUT");
  return {
    type: "unknown",
    recoverable,
    message: clean,
    userMessage: clean.substring(0, 200) || "An error occurred",
    details: {},
  };
}

/**
 * Check if an error is recoverable (worth retrying).
 */
export function isRecoverableError(error: ParsedError): boolean {
  return error.recoverable;
}

/** Resume-specific failure signatures from cursor-agent stderr/stdout. */
const RESUME_FAILURE_PATTERNS = [
  /\bsession\s+(?:has\s+(?:been\s+)?|is\s+|was\s+)?(?:not\s+found|expired|deleted|missing|no\s+longer\s+exists)/i,
  /\bchat\s+(?:has\s+(?:been\s+)?|is\s+|was\s+)?(?:not\s+found|expired|deleted|missing|no\s+longer\s+exists)/i,
  /\bconversation\s+(?:has\s+(?:been\s+)?|is\s+|was\s+)?(?:not\s+found|expired|deleted|missing|no\s+longer\s+exists)/i,
  /\bthread\s+(?:has\s+(?:been\s+)?|is\s+|was\s+)?(?:not\s+found|expired|deleted|missing|no\s+longer\s+exists)/i,
  /\bresume\s+(?:failed|error|invalid|aborted)(?:\s+(?:session|chat|conversation|thread))?/i,
  /\bfailed\s+to\s+resume(?:\s+(?:session|chat|conversation|thread))?/i,
  /\bcould\s+not\s+resume(?:\s+(?:session|chat|conversation|thread))?/i,
  /\bno\s+active\s+session/i,
  /\bno\s+such\s+session/i,
  /\bno\s+such\s+chat/i,
  /\binvalid\s+(?:session|chat|conversation|thread)(?:\s+id)?/i,
  /\b(?:session|chat|conversation|thread)\s+invalid(?:\s+id)?/i,
  /\b(?:session|chat|conversation|thread)\s+id\s+(?:is\s+)?(?:invalid|not\s+found|expired|missing)/i,
  /\b(?:session|chat|conversation|thread)\s+(?:isn['’]t|wasn['’]t)\s+found/i,
  /\b(?:session|chat|conversation|thread)\s+(?:can(?:not|\s+not)|could\s+not)\s+(?:be\s+)?resumed/i,
  /\bunable\s+to\s+resume\b/i,
  /\bcan(?:not|\s+not)\s+resume\b/i,
];

/** Continuations that turn a session-gone phrase into an auth/validation/network error. */
const TRANSIENT_CONTINUATION_PATTERN = /^\s*[:;]?\s*(?:token|credential|credentials|auth|secret|password|format|network|quota|usage|limit|api|key|request(?:_|-|\s+)?id?|due\s+to\s+(?:network|auth|quota)|because\s+of\s+(?:network|auth|quota)|caused\s+by\s+(?:network|auth|quota))/i;

/** Words in a continuation clause that indicate a transient infrastructure failure. */
const TRANSIENT_CAUSE_WORDS =
  /\b(?:auth(?:enticat(?:e|ion|ed))?|re-auth(?:enticate)?|token(?:\s+rotation)?|credential|password|secret|network|connection|internet|offline|quota|usage(?:\s+limit)?|api[\s-]?key|fetch\s+failed|econnrefused|timeout|timed\s+out)\b/i;

/** Session-specific causes that should still count as resume failures. */
const SESSION_SPECIFIC_CAUSE_WORDS =
  /\b(?:inactiv(?:ity|e)|idle|policy|retention|archiv(?:e|ed)|purged|deleted|removed|expired)\b/i;

/**
 * Decide whether a cursor-agent failure is specific to the resumed session.
 * Transient errors (network, auth, OOM, signal kills) should not evict a
 * valid chat ID; only failures that indicate the session itself is gone.
 */
function isTransientContinuation(tail: string): boolean {
  const trimmed = tail.trim();
  if (!trimmed) return false;

  const stripped = trimmed.replace(/^[\s:;,.]+/, "");

  const causalMatch = stripped.match(/^(?:because of|due to)\s+(.+)/i);
  if (causalMatch) {
    const cause = causalMatch[1];
    if (SESSION_SPECIFIC_CAUSE_WORDS.test(cause) && !TRANSIENT_CAUSE_WORDS.test(cause)) {
      return false;
    }
    if (TRANSIENT_CAUSE_WORDS.test(cause)) {
      return true;
    }
  }

  const firstSegment = stripped.split(/[,;]/)[0]?.trim() ?? "";
  if (firstSegment && TRANSIENT_CAUSE_WORDS.test(firstSegment)) {
    return true;
  }

  if (TRANSIENT_CAUSE_WORDS.test(stripped)) {
    return true;
  }

  return TRANSIENT_CONTINUATION_PATTERN.test(tail);
}

export function isResumeSpecificFailure(stderr: unknown): boolean {
  const text = typeof stderr === "string" ? stderr : String(stderr ?? "");
  const clean = stripAnsi(text);
  for (const pattern of RESUME_FAILURE_PATTERNS) {
    const match = clean.match(pattern);
    if (!match) continue;
    const tail = clean.slice(match.index! + match[0].length);
    if (!isTransientContinuation(tail)) {
      return true;
    }
  }
  return false;
}

/**
 * Format parsed error for user display
 */
export function formatErrorForUser(error: ParsedError): string {
  let output = `cursor-acp error: ${error.userMessage || error.message || "Unknown error"}`;

  const details = error.details || {};
  if (Object.keys(details).length > 0) {
    const detailParts = Object.entries(details)
      .map(([k, v]) => `${k}: ${v}`)
      .join(" | ");
    output += `\n  ${detailParts}`;
  }

  if (error.suggestion) {
    output += `\n  Suggestion: ${error.suggestion}`;
  }

  return output;
}
