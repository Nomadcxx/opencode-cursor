import { describe, expect, it } from "bun:test";

import {
  parseAgentError,
  isRecoverableError,
  formatErrorForUser,
  stripAnsi,
  isResumeSpecificFailure,
} from "../../src/utils/errors.js";

describe("parseAgentError", () => {
  it("classifies quota errors as non-recoverable", () => {
    const err = parseAgentError("You've hit your usage limit for claude-3.5-sonnet");
    expect(err.type).toBe("quota");
    expect(err.recoverable).toBe(false);
    expect(err.userMessage).toContain("usage limit");
  });

  it("classifies auth errors as non-recoverable", () => {
    const err = parseAgentError("Error: not logged in");
    expect(err.type).toBe("auth");
    expect(err.recoverable).toBe(false);
  });

  it("classifies network errors as recoverable", () => {
    const err = parseAgentError("Error: fetch failed ECONNREFUSED");
    expect(err.type).toBe("network");
    expect(err.recoverable).toBe(true);
  });

  it("classifies model errors as non-recoverable", () => {
    const err = parseAgentError("Cannot use this model: gpt-5");
    expect(err.type).toBe("model");
    expect(err.recoverable).toBe(false);
  });

  it("classifies unknown timeout errors as recoverable", () => {
    const err = parseAgentError("request timeout after 30s");
    expect(err.type).toBe("unknown");
    expect(err.recoverable).toBe(true);
  });

  it("classifies unknown ETIMEDOUT errors as recoverable", () => {
    const err = parseAgentError("connect ETIMEDOUT 1.2.3.4:443");
    expect(err.type).toBe("unknown");
    expect(err.recoverable).toBe(true);
  });

  it("classifies generic unknown errors as non-recoverable", () => {
    const err = parseAgentError("something went wrong");
    expect(err.type).toBe("unknown");
    expect(err.recoverable).toBe(false);
  });

  it("extracts quota details when present", () => {
    const err = parseAgentError(
      "You've hit your usage limit. You saved $5.50. Reset on 02/15/2026. Continue with claude.",
    );
    expect(err.type).toBe("quota");
    expect(err.details.savings).toBe("$5.50");
    expect(err.details.resetDate).toBe("02/15/2026");
  });

  it("extracts model details when present", () => {
    const err = parseAgentError(
      "Cannot use this model: gpt-5. Available models: auto, claude-3.5-sonnet, gpt-4o",
    );
    expect(err.details.requested).toBe("gpt-5");
    expect(err.details.available).toBeDefined();
  });

  it("handles non-string input", () => {
    const err = parseAgentError(null);
    expect(err.type).toBe("unknown");
    expect(err.recoverable).toBe(false);
  });

  it("handles empty string", () => {
    const err = parseAgentError("");
    expect(err.type).toBe("unknown");
    expect(err.userMessage).toBe("An error occurred");
  });
});

describe("isRecoverableError", () => {
  it("returns true for network errors", () => {
    const err = parseAgentError("ECONNREFUSED 127.0.0.1:443");
    expect(isRecoverableError(err)).toBe(true);
  });

  it("returns false for auth errors", () => {
    const err = parseAgentError("not logged in");
    expect(isRecoverableError(err)).toBe(false);
  });

  it("returns false for quota errors", () => {
    const err = parseAgentError("hit your usage limit");
    expect(isRecoverableError(err)).toBe(false);
  });

  it("returns false for model errors", () => {
    const err = parseAgentError("model not found");
    expect(isRecoverableError(err)).toBe(false);
  });

  it("returns true for timeout in unknown category", () => {
    const err = parseAgentError("operation timeout");
    expect(isRecoverableError(err)).toBe(true);
  });

  it("returns false for generic unknown errors", () => {
    const err = parseAgentError("segfault");
    expect(isRecoverableError(err)).toBe(false);
  });
});

describe("formatErrorForUser", () => {
  it("formats basic error", () => {
    const err = parseAgentError("not logged in");
    const msg = formatErrorForUser(err);
    expect(msg).toContain("cursor-acp error");
    expect(msg).toContain("Not authenticated");
    expect(msg).toContain("Suggestion:");
  });

  it("formats error with details", () => {
    const err = parseAgentError("Cannot use this model: gpt-5");
    const msg = formatErrorForUser(err);
    expect(msg).toContain("gpt-5");
  });
});

describe("stripAnsi", () => {
  it("strips ANSI codes", () => {
    expect(stripAnsi("\x1b[31mred\x1b[0m")).toBe("red");
  });

  it("handles non-string input", () => {
    expect(stripAnsi(42 as any)).toBe("42");
    expect(stripAnsi(null as any)).toBe("");
  });
});

describe("isResumeSpecificFailure", () => {
  it("detects session-not-found failures", () => {
    expect(isResumeSpecificFailure("session not found")).toBe(true);
    expect(isResumeSpecificFailure("session not found?")).toBe(true);
    expect(isResumeSpecificFailure("session expired")).toBe(true);
    expect(isResumeSpecificFailure("session invalid")).toBe(true);
    expect(isResumeSpecificFailure("session deleted")).toBe(true);
    expect(isResumeSpecificFailure("session no longer exists")).toBe(true);
  });

  it("detects chat/conversation/thread failures", () => {
    expect(isResumeSpecificFailure("chat expired")).toBe(true);
    expect(isResumeSpecificFailure("chat not found")).toBe(true);
    expect(isResumeSpecificFailure("chat invalid")).toBe(true);
    expect(isResumeSpecificFailure("conversation not found")).toBe(true);
    expect(isResumeSpecificFailure("thread missing")).toBe(true);
  });

  it("detects resume failed failures", () => {
    expect(isResumeSpecificFailure("resume failed")).toBe(true);
    expect(isResumeSpecificFailure("resume failed?")).toBe(true);
    expect(isResumeSpecificFailure("resume error")).toBe(true);
    expect(isResumeSpecificFailure("resume invalid")).toBe(true);
    expect(isResumeSpecificFailure("could not resume")).toBe(true);
    expect(isResumeSpecificFailure("could not resume session")).toBe(true);
    expect(isResumeSpecificFailure("failed to resume")).toBe(true);
    expect(isResumeSpecificFailure("failed to resume session")).toBe(true);
    expect(isResumeSpecificFailure("session cannot be resumed")).toBe(true);
    expect(isResumeSpecificFailure("unable to resume")).toBe(true);
    expect(isResumeSpecificFailure("cannot resume")).toBe(true);
    expect(isResumeSpecificFailure("can not resume")).toBe(true);
  });

  it("detects invalid session id failures", () => {
    expect(isResumeSpecificFailure("invalid session id")).toBe(true);
    expect(isResumeSpecificFailure("session id invalid")).toBe(true);
    expect(isResumeSpecificFailure("session id is invalid")).toBe(true);
    expect(isResumeSpecificFailure("invalid chat")).toBe(true);
    expect(isResumeSpecificFailure("no such session")).toBe(true);
    expect(isResumeSpecificFailure("no active session")).toBe(true);
  });

  it("detects helper-verb variations", () => {
    expect(isResumeSpecificFailure("session has expired")).toBe(true);
    expect(isResumeSpecificFailure("session was not found")).toBe(true);
    expect(isResumeSpecificFailure("chat is missing")).toBe(true);
    expect(isResumeSpecificFailure("conversation has been deleted")).toBe(true);
    expect(isResumeSpecificFailure("session isn't found")).toBe(true);
  });

  it("handles punctuation and closers around session-gone phrases", () => {
    expect(isResumeSpecificFailure("session not found)")).toBe(true);
    expect(isResumeSpecificFailure('session not found"')).toBe(true);
  });

  it("is case insensitive", () => {
    expect(isResumeSpecificFailure("SESSION NOT FOUND")).toBe(true);
    expect(isResumeSpecificFailure("Chat Expired")).toBe(true);
  });

  it("does not flag transient network failures", () => {
    expect(isResumeSpecificFailure("fetch failed")).toBe(false);
    expect(isResumeSpecificFailure("ECONNREFUSED")).toBe(false);
  });

  it("does not flag usage/quota failures", () => {
    expect(isResumeSpecificFailure("usage limit")).toBe(false);
  });

  it("does not flag generic errors", () => {
    expect(isResumeSpecificFailure("something went wrong")).toBe(false);
    expect(isResumeSpecificFailure("timeout")).toBe(false);
  });

  it("does not flag words that merely contain session/resume/chat", () => {
    expect(isResumeSpecificFailure("presumed failure")).toBe(false);
    expect(isResumeSpecificFailure("chatting is not found")).toBe(false);
    expect(isResumeSpecificFailure("sessioning error")).toBe(false);
  });

  it("does not flag auth/validation continuations after session phrases", () => {
    expect(isResumeSpecificFailure("session has expired token")).toBe(false);
    expect(isResumeSpecificFailure("session wasn't deleted")).toBe(false);
    expect(isResumeSpecificFailure("session isn't missing")).toBe(false);
    expect(isResumeSpecificFailure("session id invalid token")).toBe(false);
    expect(isResumeSpecificFailure("resume failed due to network error")).toBe(false);
    expect(isResumeSpecificFailure("resume failed: network error")).toBe(false);
    expect(isResumeSpecificFailure("failed to resume: network error")).toBe(false);
    expect(isResumeSpecificFailure("could not resume due to network error")).toBe(false);
    expect(isResumeSpecificFailure("could not resume because of network error")).toBe(false);
    expect(isResumeSpecificFailure("session expired; auth required")).toBe(false);
    expect(isResumeSpecificFailure("resume timed out")).toBe(false);
    expect(isResumeSpecificFailure("session has expired because of an auth problem")).toBe(false);
    expect(isResumeSpecificFailure("resume failed due to token rotation")).toBe(false);
    expect(isResumeSpecificFailure("session not found; please re-authenticate")).toBe(false);
    expect(isResumeSpecificFailure("chat not found. The network may be down.")).toBe(false);
    expect(isResumeSpecificFailure("session not found, auth failed")).toBe(false);
  });

  it("still flags session-gone messages with natural continuations", () => {
    expect(isResumeSpecificFailure("session not found in our system")).toBe(true);
    expect(isResumeSpecificFailure("session has expired due to inactivity")).toBe(true);
  });

  it("handles non-string input safely", () => {
    expect(isResumeSpecificFailure(null)).toBe(false);
    expect(isResumeSpecificFailure(undefined)).toBe(false);
    expect(isResumeSpecificFailure(42)).toBe(false);
  });

  it("does not flag invalid-session-style auth/validation phrases", () => {
    expect(isResumeSpecificFailure("invalid session token")).toBe(false);
    expect(isResumeSpecificFailure("session invalid token")).toBe(false);
    expect(isResumeSpecificFailure("invalid chat format")).toBe(false);
    expect(isResumeSpecificFailure("chat invalid format")).toBe(false);
  });

  it("does not flag empty strings", () => {
    expect(isResumeSpecificFailure("")).toBe(false);
  });

  it("handles Error objects and ANSI-wrapped strings", () => {
    expect(isResumeSpecificFailure(new Error("session not found"))).toBe(true);
    expect(isResumeSpecificFailure("\x1b[31msession not found\x1b[0m")).toBe(true);
    expect(isResumeSpecificFailure(new Error("fetch failed"))).toBe(false);
  });
});
