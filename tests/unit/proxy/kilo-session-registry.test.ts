import { afterEach, describe, expect, it } from "bun:test";
import {
  _getSessionKeysForKiloSession,
  _resetKiloSessionRegistry,
  clearResumeForKiloSession,
  consumeCompactionInvalidation,
  readKiloSessionIdFromHeaders,
  reaffirmKiloSessionMapping,
  registerKiloSessionKey,
  trackKiloSession,
} from "../../../src/proxy/kilo-session-registry.js";
import {
  _resetSessionResumeCache,
  buildSessionKey,
  getResumeChatId,
  recordResumeChatId,
} from "../../../src/proxy/session-resume.js";

describe("kilo-session-registry", () => {
  afterEach(() => {
    _resetKiloSessionRegistry();
    _resetSessionResumeCache();
  });

  it("tracks and registers session keys for a Kilo session", () => {
    trackKiloSession("kilo-1");
    registerKiloSessionKey("kilo-1", "session-key-a");
    registerKiloSessionKey("kilo-1", "session-key-b");
    expect(_getSessionKeysForKiloSession("kilo-1").sort()).toEqual([
      "session-key-a",
      "session-key-b",
    ]);
  });

  it("reaffirms the last registered session key from chat.params", () => {
    registerKiloSessionKey("kilo-1", "session-key-a");
    reaffirmKiloSessionMapping("kilo-1");
    expect(_getSessionKeysForKiloSession("kilo-1")).toEqual(["session-key-a"]);
  });

  it("clears resume cache for all mapped session keys on compaction", () => {
    const sessionKey = buildSessionKey("/ws", "model", "anchor", "kilo-1");
    recordResumeChatId(sessionKey, "chat-123", "prefix");
    registerKiloSessionKey("kilo-1", sessionKey);
    clearResumeForKiloSession("kilo-1");
    expect(getResumeChatId(sessionKey, "prefix")).toBeUndefined();
  });

  it("marks compaction invalidation for the next HTTP request", () => {
    clearResumeForKiloSession("kilo-1");
    expect(consumeCompactionInvalidation("kilo-1")).toBe(true);
    expect(consumeCompactionInvalidation("kilo-1")).toBe(false);
  });

  it("reads X-Kilo-Session-ID from Headers and node-style records", () => {
    const headers = new Headers({ "X-Kilo-Session-ID": "sess-abc" });
    expect(readKiloSessionIdFromHeaders(headers)).toBe("sess-abc");
    expect(readKiloSessionIdFromHeaders({ "x-kilo-session-id": "sess-node" })).toBe("sess-node");
    expect(readKiloSessionIdFromHeaders({})).toBeUndefined();
  });
});
