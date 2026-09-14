import type { Auth } from "@kilocode/sdk";
import type { StoredAuth } from "./auth-store.js";

export type CursorCredentialKind = "sdk-api-key" | "oauth-jwt" | "cursor-agent-placeholder";

export type CursorCredential =
  | { kind: "sdk-api-key"; token: string }
  | { kind: "oauth-jwt"; accessToken: string; refreshToken?: string }
  | { kind: "cursor-agent-placeholder" };

const USER_API_KEY_RE = /^(sk-|key_)/i;

export function looksLikeUserApiKey(value: string): boolean {
  return USER_API_KEY_RE.test(value.trim());
}

export function looksLikeJwt(value: string): boolean {
  return value.trim().split(".").length === 3;
}

export function classifyStoredAuth(auth: StoredAuth | undefined): CursorCredential | undefined {
  if (!auth) return undefined;

  if (auth.type === "oauth" && typeof auth.access === "string" && auth.access.length > 0) {
    return {
      kind: "oauth-jwt",
      accessToken: auth.access,
      refreshToken: typeof auth.refresh === "string" ? auth.refresh : undefined,
    };
  }

  if (auth.type === "api" && typeof auth.key === "string" && auth.key.length > 0) {
    if (auth.key === "cursor-agent") {
      return { kind: "cursor-agent-placeholder" };
    }
    if (looksLikeUserApiKey(auth.key)) {
      return { kind: "sdk-api-key", token: auth.key.trim() };
    }
    if (looksLikeJwt(auth.key)) {
      const refresh = auth.metadata?.refreshToken;
      return {
        kind: "oauth-jwt",
        accessToken: auth.key.trim(),
        refreshToken: typeof refresh === "string" ? refresh : undefined,
      };
    }
    return { kind: "sdk-api-key", token: auth.key.trim() };
  }

  return undefined;
}

export function sdkApiKeyFromCredential(credential: CursorCredential | undefined): string | undefined {
  if (!credential) return undefined;
  if (credential.kind === "sdk-api-key") return credential.token;
  return undefined;
}

export function oauthRequiresCursorAgent(credential: CursorCredential | undefined): boolean {
  return credential?.kind === "oauth-jwt";
}

export function describeCredentialRequirement(credential: CursorCredential | undefined): string {
  if (credential?.kind === "oauth-jwt") {
    return "OAuth login uses cursor-agent as backend. Install it (https://cursor.com/docs/cli) or re-auth with a Cursor API key from cursor.com/settings.";
  }
  if (credential?.kind === "cursor-agent-placeholder") {
    return "Run `cursor-agent login` (the CLI prints this as `agent login`), or use `kilo auth login --provider cursor` with browser/API key.";
  }
  return "Authenticate with `kilo auth login --provider cursor`, `cursor-agent login`, or set CURSOR_API_KEY.";
}

/**
 * Auth for a cursor-agent child spawned by the plugin.
 *
 * cursor-agent cannot read ~/.local/share/kilo/auth.json. On Linux it always
 * looks at ~/.config/cursor/auth.json (or the keychain on macOS). Pass the
 * Kilo token through CURSOR_AUTH_TOKEN / CURSOR_API_KEY and force
 * AGENT_CLI_CREDENTIAL_STORE=memory so this child neither reads nor overwrites
 * the CLI's own auth.json.
 */
export function envWithCursorAgentAuth(
  env: NodeJS.ProcessEnv,
  credential: CursorCredential | undefined,
): NodeJS.ProcessEnv {
  const next = { ...env };
  if (credential?.kind === "oauth-jwt" && credential.accessToken) {
    next.CURSOR_AUTH_TOKEN = credential.accessToken;
    next.AGENT_CLI_CREDENTIAL_STORE = "memory";
  } else if (credential?.kind === "sdk-api-key" && credential.token) {
    next.CURSOR_API_KEY = credential.token;
    next.AGENT_CLI_CREDENTIAL_STORE = "memory";
  }
  return next;
}

/** Apply Kilo credentials onto this process so pooled cursor-agent children inherit them. */
export function applyCursorAgentAuthToProcessEnv(
  env: NodeJS.ProcessEnv,
  credential: CursorCredential | undefined,
): void {
  const next = envWithCursorAgentAuth(env, credential);
  if (next.CURSOR_AUTH_TOKEN) env.CURSOR_AUTH_TOKEN = next.CURSOR_AUTH_TOKEN;
  if (next.CURSOR_API_KEY) env.CURSOR_API_KEY = next.CURSOR_API_KEY;
  if (next.AGENT_CLI_CREDENTIAL_STORE) {
    env.AGENT_CLI_CREDENTIAL_STORE = next.AGENT_CLI_CREDENTIAL_STORE;
  }
}
