import { CURSOR_INTEGRATION_ID } from "./catalog.js";
import {
  CURSOR_AGENT_LOGIN_METHOD_ID,
  cursorAgentCredentialLabel,
  type CursorAgentLogin,
} from "./cursor-agent-login.js";
import type { CredentialValue, IntegrationDomain, IntegrationDraft } from "./types.js";

/**
 * Integration registration for the OpenCode 2.0 plugin — the replacement for
 * the classic plugin's `auth` hook.
 *
 * Two ways in: the cursor-agent login (an `oauth` method that stores a marker,
 * so requests use the CLI login), or a Cursor API key (key / env methods, used
 * by the SDK backend).
 */

/** Env vars that can supply a Cursor API key without running /connect. */
export const CURSOR_ENV_NAMES = ["CURSOR_API_KEY"];

/** Register the Cursor integration and its login / key / env connection methods. */
export function applyCursorIntegration(draft: IntegrationDraft, login: CursorAgentLogin): void {
  draft.update(CURSOR_INTEGRATION_ID, (integration) => {
    integration.id = CURSOR_INTEGRATION_ID;
    integration.name = "Cursor";
  });

  draft.method.update({
    integrationID: CURSOR_INTEGRATION_ID,
    method: { id: CURSOR_AGENT_LOGIN_METHOD_ID, type: "oauth", label: "Log in with cursor-agent (browser)" },
    authorize: () => login.authorize(),
    // No refresh: cursor-agent owns its token and renews it itself.
    label: cursorAgentCredentialLabel,
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
