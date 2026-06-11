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

export function selectBackendForRequest(
  input: SelectBackendForRequestInput,
): CursorRuntimeBackend {
  if (input.preference === "sdk") {
    return "sdk";
  }

  if (
    input.preference === "auto" &&
    !input.cursorAgentAvailable &&
    isUsableSdkApiKey(input.sdkApiKey)
  ) {
    return "sdk";
  }

  return "cursor-agent";
}
