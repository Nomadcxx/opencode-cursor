/**
 * Cursor OAuth (PKCE browser login) — adapted from cursor-kilocode-provider.
 * Works alongside cursor-agent auth; tokens can feed the SDK backend path.
 */
import { createLogger } from "../utils/logger.js";
import { verifyCursorAuth } from "../auth.js";

const log = createLogger("auth:oauth");

const CURSOR_API_HOST = process.env.CURSOR_API_HOST ?? "api2.cursor.sh";
const CURSOR_WEBSITE_HOST = process.env.CURSOR_WEBSITE_HOST ?? "cursor.com";
const API_BASE = process.env.CURSOR_API_BASE_URL ?? `https://${CURSOR_API_HOST}`;

export class AuthPollError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "AuthPollError";
    if (cause) (this as any).cause = cause;
  }
}

export class AuthTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthTimeoutError";
  }
}

export class AuthExchangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthExchangeError";
  }
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function isExpiringSoon(jwt: string, thresholdS = 300): boolean {
  try {
    const payload = JSON.parse(atob(jwt.split(".")[1]!));
    return payload.exp * 1000 - Date.now() < thresholdS * 1000;
  } catch {
    return true;
  }
}

export function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  try {
    return JSON.parse(atob(jwt.split(".")[1]!));
  } catch {
    return null;
  }
}

export function decodeExpFromJwt(jwt: string): number {
  const payload = decodeJwtPayload(jwt);
  if (payload && typeof payload.exp === "number") return payload.exp * 1000;
  return Date.now() + 3600_000;
}

export function generatePkceParams(): { verifier: string; uuid: string } {
  const verifierBytes = new Uint8Array(32);
  crypto.getRandomValues(verifierBytes);
  return { verifier: base64url(verifierBytes), uuid: crypto.randomUUID() };
}

export async function generatePkceChallenge(verifier: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(hash));
}

export function buildLoginUrl(
  challenge: string,
  uuid: string,
  websiteUrl = `https://${CURSOR_WEBSITE_HOST}`,
): string {
  return `${websiteUrl}/loginDeepControl?challenge=${encodeURIComponent(challenge)}&uuid=${encodeURIComponent(uuid)}&mode=login&redirectTarget=cli`;
}

export async function pollForTokens(
  uuid: string,
  verifier: string,
  baseUrl = API_BASE,
  signal?: AbortSignal,
  maxAttempts = 150,
): Promise<{ accessToken: string; refreshToken: string }> {
  let failures = 0;
  for (let i = 0; i < maxAttempts; i++) {
    if (signal?.aborted) throw new AuthTimeoutError("Poll cancelled");
    const delay = Math.min(1000 * Math.pow(1.2, i), 10000);
    await new Promise((r) => setTimeout(r, delay));
    try {
      const url = `${baseUrl}/auth/poll?uuid=${encodeURIComponent(uuid)}&verifier=${encodeURIComponent(verifier)}`;
      const res = await fetch(url);
      if (res.status === 404) {
        failures = 0;
        continue;
      }
      if (!res.ok) {
        failures++;
        if (failures >= 3) {
          throw new AuthPollError(`Poll failed after ${failures} consecutive errors (last: ${res.status})`);
        }
        continue;
      }
      const body = (await res.json()) as { accessToken?: string; refreshToken?: string };
      if (body.accessToken && body.refreshToken) {
        log.debug("OAuth poll succeeded");
        return { accessToken: body.accessToken, refreshToken: body.refreshToken };
      }
      failures++;
      if (failures >= 3) {
        throw new AuthPollError("Poll returned 200 without tokens");
      }
    } catch (err) {
      if (err instanceof AuthPollError) throw err;
      failures++;
      if (failures >= 3) {
        throw new AuthPollError("Poll failed after network errors", err);
      }
    }
  }
  throw new AuthTimeoutError(`Poll timed out after ${maxAttempts} attempts`);
}

export async function exchangeApiKey(
  apiKey: string,
  baseUrl = API_BASE,
): Promise<{ accessToken: string; refreshToken: string }> {
  const res = await fetch(`${baseUrl}/auth/exchange_user_api_key`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: "{}",
  });
  if (!res.ok) {
    throw new AuthExchangeError(`API key exchange failed: ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as { accessToken?: string; refreshToken?: string };
  if (!body.accessToken || !body.refreshToken) {
    throw new AuthExchangeError("Exchange response missing tokens");
  }
  return { accessToken: body.accessToken, refreshToken: body.refreshToken };
}

export async function refreshAccessToken(
  refreshToken: string,
  baseUrl = API_BASE,
): Promise<{ accessToken: string; refreshToken: string }> {
  const res = await fetch(`${baseUrl}/auth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken }),
  });
  if (!res.ok) {
    throw new AuthExchangeError(`Token refresh failed: ${res.status}`);
  }
  const body = (await res.json()) as { accessToken?: string; refreshToken?: string };
  if (!body.accessToken || !body.refreshToken) {
    throw new AuthExchangeError("Refresh response missing tokens");
  }
  return { accessToken: body.accessToken, refreshToken: body.refreshToken };
}

/** Build Kilo auth hook methods for Cursor OAuth + API key */
export function buildCursorAuthMethods(providerId: string) {
  const websiteUrl = process.env.CURSOR_WEBSITE_URL ?? `https://${CURSOR_WEBSITE_HOST}`;
  const apiBaseUrl = process.env.CURSOR_API_BASE_URL ?? API_BASE;

  return [
    {
      type: "oauth" as const,
      label: "Cursor account (browser login)",
      async authorize() {
        const params = generatePkceParams();
        const challenge = await generatePkceChallenge(params.verifier);
        const url = buildLoginUrl(challenge, params.uuid, websiteUrl);
        return {
          url,
          instructions: "Abra esta URL no navegador para entrar na sua conta Cursor",
          method: "auto" as const,
          async callback() {
            const result = await pollForTokens(params.uuid, params.verifier, apiBaseUrl);
            return {
              type: "success" as const,
              provider: providerId,
              access: result.accessToken,
              refresh: result.refreshToken,
              expires: decodeExpFromJwt(result.accessToken),
            };
          },
        };
      },
    },
    {
      type: "api" as const,
      label: "Cursor API Key (cursor.com/settings)",
      prompts: [
        {
          type: "text" as const,
          key: "apiKey",
          message: "Cursor API key",
          placeholder: "key_... ou sk-...",
          validate(value: string) {
            if (!value?.trim()) return "API key is required";
            return undefined;
          },
        },
      ],
      async authorize(inputs: { apiKey?: string }) {
        const apiKey = inputs?.apiKey?.trim();
        if (!apiKey) return { type: "failed" as const };
        try {
          const result = await exchangeApiKey(apiKey, apiBaseUrl);
          return {
            type: "success" as const,
            provider: providerId,
            // Keep the raw user API key for @cursor/sdk; store exchanged tokens in metadata.
            key: apiKey,
            metadata: {
              refreshToken: result.refreshToken,
              accessToken: result.accessToken,
              sourceApiKey: "true",
            },
          };
        } catch (err) {
          log.debug("API key exchange failed, storing raw key for cursor-agent", { error: String(err) });
          // Fallback: store raw key for cursor-agent / SDK paths that accept it directly
          return {
            type: "success" as const,
            provider: providerId,
            key: apiKey,
          };
        }
      },
    },
    {
      type: "api" as const,
      label: "cursor-agent CLI (run: cursor-agent login)",
      async authorize() {
        if (verifyCursorAuth()) {
          return { type: "success" as const, provider: providerId, key: "cursor-agent" };
        }
        return {
          type: "failed" as const,
          error: "cursor-agent não autenticado. Execute: cursor-agent login",
        };
      },
    },
  ];
}
