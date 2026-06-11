import { describe, expect, it } from "bun:test";
import {
  isUsableSdkApiKey,
  parseCursorBackendPreference,
  resolveSdkApiKey,
  selectBackendForRequest,
  selectInitialBackend,
  shouldFallbackToSdk,
} from "../../src/provider/backend";

describe("provider backend compatibility", () => {
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
