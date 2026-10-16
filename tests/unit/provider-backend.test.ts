import { describe, expect, it } from "bun:test";
import {
  isUsableSdkApiKey,
  parseCursorBackendPreference,
  resolveSdkApiKey,
  selectBackendForRequest,
  selectInitialBackend,
  shouldFallbackToSdk,
} from "../../src/provider/backend";
import { isEnvSdkApiKey, isSdkApiKeyRejected, markSdkApiKeyRejected } from "../../src/auth";

describe("provider backend compatibility", () => {
  it("prefers SDK for keyed 2.0 requests under auto while respecting explicit CLI selection", () => {
    const request = { cursorAgentAvailable: true, sdkApiKey: "cursor_123", preferSdk: true };
    expect(selectBackendForRequest({ ...request, preference: "auto" })).toBe("sdk");
    expect(selectBackendForRequest({ ...request, preference: "cursor-agent" })).toBe("cursor-agent");
    expect(selectBackendForRequest({ ...request, preference: "auto", sdkApiKey: "cursor-agent" })).toBe("cursor-agent");
  });
  it("defaults to auto and accepts explicit backend preferences", () => {
    expect(parseCursorBackendPreference(undefined)).toEqual({ preference: "auto", valid: true });
    expect(parseCursorBackendPreference("auto")).toEqual({ preference: "auto", valid: true });
    expect(parseCursorBackendPreference("cursor-agent")).toEqual({ preference: "cursor-agent", valid: true });
    expect(parseCursorBackendPreference("sdk")).toEqual({ preference: "sdk", valid: true });
    expect(parseCursorBackendPreference("nonsense")).toEqual({ preference: "auto", valid: false });
  });

  it("does not treat the historical cursor-agent placeholder as a real SDK API key", () => {
    expect(isUsableSdkApiKey(undefined)).toBe(false);
    expect(isUsableSdkApiKey("")).toBe(false);
    expect(isUsableSdkApiKey("cursor-agent")).toBe(false);
    expect(isUsableSdkApiKey("  cursor-agent  ")).toBe(false);
    expect(isUsableSdkApiKey("cursor_123")).toBe(true);
    expect(isUsableSdkApiKey("sk-real-key")).toBe(true);
  });

  it("rejects placeholders written by older 1.x login flows and the installer", () => {
    // OpenCode 2.0 imports the 1.x auth store, so these reach the v2 request hook.
    expect(isUsableSdkApiKey("cursor-auth")).toBe(false);
    expect(isUsableSdkApiKey("cursor-agent-auth")).toBe(false);
    expect(isUsableSdkApiKey("cursor-agent-handles-auth-separately")).toBe(false);
    expect(resolveSdkApiKey({ env: {}, storedApiKey: "cursor-auth", authorizationHeader: "Bearer cursor-auth" })).toBeUndefined();
  });

  it("expires a key rejection so a re-enabled key recovers without a restart", () => {
    const now = 1_000_000;
    markSdkApiKeyRejected("cursor_ttl", now);
    expect(isSdkApiKeyRejected("cursor_ttl", now + 9 * 60 * 1000)).toBe(true);
    expect(isSdkApiKeyRejected("cursor_ttl", now + 10 * 60 * 1000)).toBe(false);
    expect(isSdkApiKeyRejected("cursor_ttl", now)).toBe(false);
  });

  it("recognises the CURSOR_API_KEY env key, which cursor-agent also reads", () => {
    expect(isEnvSdkApiKey("cursor_env", { CURSOR_API_KEY: " cursor_env " })).toBe(true);
    expect(isEnvSdkApiKey("cursor_stored", { CURSOR_API_KEY: "cursor_env" })).toBe(false);
    expect(isEnvSdkApiKey("cursor_stored", {})).toBe(false);
  });

  it("resolves SDK keys from env, stored auth, then Authorization header", () => {
    expect(
      resolveSdkApiKey({
        env: { CURSOR_API_KEY: "env-key" },
        storedApiKey: "stored-key",
        authorizationHeader: "Bearer header-key",
      }),
    ).toBe("env-key");

    expect(
      resolveSdkApiKey({
        env: {},
        storedApiKey: "stored-key",
        authorizationHeader: "Bearer header-key",
      }),
    ).toBe("stored-key");

    expect(
      resolveSdkApiKey({
        env: {},
        authorizationHeader: "Bearer header-key",
      }),
    ).toBe("header-key");
  });

  it("ignores placeholder Authorization header values so auto can preserve cursor-agent", () => {
    expect(
      resolveSdkApiKey({
        env: {},
        authorizationHeader: "Bearer cursor-agent",
      }),
    ).toBeUndefined();
    expect(
      resolveSdkApiKey({
        env: {},
        authorizationHeader: "cursor-agent",
      }),
    ).toBeUndefined();
  });

  it("prefers cursor-agent in auto mode and only falls back to SDK when a real key exists", () => {
    expect(selectInitialBackend("auto")).toBe("cursor-agent");
    expect(selectInitialBackend("cursor-agent")).toBe("cursor-agent");
    expect(selectInitialBackend("sdk")).toBe("sdk");

    expect(shouldFallbackToSdk("auto", "cursor_123")).toBe(true);
    expect(shouldFallbackToSdk("auto", "cursor-agent")).toBe(false);
    expect(shouldFallbackToSdk("cursor-agent", "cursor_123")).toBe(false);
    expect(shouldFallbackToSdk("sdk", "cursor_123")).toBe(false);
  });

  it("routes a key Cursor rejected to cursor-agent in auto mode, but not under an explicit sdk preference", () => {
    const base = { cursorAgentAvailable: true, sdkApiKey: "cursor_123", preferSdk: true };
    expect(selectBackendForRequest({ ...base, preference: "auto" })).toBe("sdk");
    expect(selectBackendForRequest({ ...base, preference: "auto", sdkApiKeyRejected: true })).toBe("cursor-agent");
    expect(selectBackendForRequest({ ...base, preference: "sdk", sdkApiKeyRejected: true })).toBe("sdk");
  });

  it("uses SDK in auto mode only when cursor-agent is unavailable and SDK auth is real", () => {
    expect(
      selectBackendForRequest({
        preference: "auto",
        cursorAgentAvailable: true,
        sdkApiKey: "cursor_123",
      }),
    ).toBe("cursor-agent");

    expect(
      selectBackendForRequest({
        preference: "auto",
        cursorAgentAvailable: false,
        sdkApiKey: "cursor_123",
      }),
    ).toBe("sdk");

    expect(
      selectBackendForRequest({
        preference: "auto",
        cursorAgentAvailable: false,
        sdkApiKey: "cursor-agent",
      }),
    ).toBe("cursor-agent");

    expect(
      selectBackendForRequest({
        preference: "sdk",
        cursorAgentAvailable: true,
        sdkApiKey: "cursor_123",
      }),
    ).toBe("sdk");
  });
});
