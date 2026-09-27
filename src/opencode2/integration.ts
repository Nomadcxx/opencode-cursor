import { CURSOR_INTEGRATION_ID } from "./catalog.js";
import type { CredentialValue, IntegrationDomain, IntegrationDraft } from "./types.js";

/**
 * Integration registration for the OpenCode 2.0 plugin — the replacement for
 * the classic plugin's `auth` hook.
 *
 * open-cursor authenticates with a Cursor API key (env or /connect key method).
 * Browser OAuth via `cursor-agent login` was removed upstream; do not reintroduce it here.
 */

/** Env vars that can supply a Cursor API key without running /connect. */
export const CURSOR_ENV_NAMES = ["CURSOR_API_KEY"];

/** Register the Cursor integration and its key / env connection methods. */
export function applyCursorIntegration(draft: IntegrationDraft): void {
  draft.update(CURSOR_INTEGRATION_ID, (integration) => {
    integration.id = CURSOR_INTEGRATION_ID;
    integration.name = "Cursor";
  });

  draft.method.update({
    integrationID: CURSOR_INTEGRATION_ID,
    method: { type: "key", label: "Cursor API Key (cursor.com/settings)" },
  });

  draft.method.update({
    integrationID: CURSOR_INTEGRATION_ID,
    method: { type: "env", names: CURSOR_ENV_NAMES },
  });
}

/** Turn a stored credential into a Cursor API key string, if any. */
export function apiKeyFromCredential(
  credential: CredentialValue | undefined,
): string | undefined {
  if (!credential) return undefined;
  if (credential.type === "key" && typeof credential.key === "string") {
    const key = credential.key.trim();
    return key.length > 0 ? key : undefined;
  }
  return undefined;
}

/** Resolve the active Cursor connection into an API key, if any. */
export async function resolveCursorApiKey(
  integration: IntegrationDomain,
): Promise<string | undefined> {
  try {
    const connection = await integration.connection.active(CURSOR_INTEGRATION_ID);
    if (!connection) return undefined;
    return apiKeyFromCredential(await integration.connection.resolve(connection));
  } catch {
    return undefined;
  }
}
