export {
  isUsableSdkApiKey,
  normalizeAuthorizationHeader,
  resolveSdkApiKey,
  type ResolveSdkApiKeyInput,
} from "../auth.js";
import { isUsableSdkApiKey } from "../auth.js";

export type CursorBackendPreference = "auto" | "cursor-agent" | "sdk";
export type CursorRuntimeBackend = "cursor-agent" | "sdk";

export interface BackendPreferenceParseResult {
  preference: CursorBackendPreference;
  valid: boolean;
}

export interface SelectBackendForRequestInput {
  preference: CursorBackendPreference;
  cursorAgentAvailable: boolean;
  sdkApiKey?: string;
}

export function parseCursorBackendPreference(
  value: string | undefined,
): BackendPreferenceParseResult {
  if (value === undefined || value.trim() === "") {
    return { preference: "auto", valid: true };
  }

  const normalized = value.trim().toLowerCase();
  if (
    normalized === "auto" ||
    normalized === "cursor-agent" ||
    normalized === "sdk"
  ) {
    return { preference: normalized, valid: true };
  }

  return { preference: "auto", valid: false };
}

export function selectInitialBackend(
  preference: CursorBackendPreference,
): CursorRuntimeBackend {
  return preference === "sdk" ? "sdk" : "cursor-agent";
}

export function shouldFallbackToSdk(
  preference: CursorBackendPreference,
  sdkApiKey: string | undefined,
): boolean {
  return preference === "auto" && isUsableSdkApiKey(sdkApiKey);
}

/** In auto mode, prefer SDK when Kilo/OpenCode auth provided a real token. */
export function shouldPreferSdkInAuto(
  preference: CursorBackendPreference,
  sdkApiKey: string | undefined,
): boolean {
  return preference === "auto" && isUsableSdkApiKey(sdkApiKey);
}

export function selectBackendForRequest(
  input: SelectBackendForRequestInput,
): CursorRuntimeBackend {
  if (input.preference === "sdk") {
    return "sdk";
  }

  if (input.preference === "cursor-agent") {
    return "cursor-agent";
  }

  // Auto: Kilo OAuth/API credentials live in the auth store. cursor-agent is
  // fed that token via CURSOR_AUTH_TOKEN; prefer SDK when we already have a
  // real API key from `kilo auth login --provider cursor`.
  if (shouldPreferSdkInAuto(input.preference, input.sdkApiKey)) {
    return "sdk";
  }

  if (!input.cursorAgentAvailable) {
    return "sdk";
  }

  return "cursor-agent";
}
