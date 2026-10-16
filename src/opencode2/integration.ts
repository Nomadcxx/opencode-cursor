import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCursorAgentBinary } from "../utils/binary.js";
import { createLogger } from "../utils/logger.js";
import { CURSOR_INTEGRATION_ID } from "./catalog.js";
import type { CredentialValue, IntegrationDomain, IntegrationDraft } from "./types.js";

/**
 * Integration registration for the OpenCode 2.0 plugin — the replacement for
 * the classic plugin's `auth` hook.
 *
 * Two ways in: `cursor-agent login` (a `command` method that stores the
 * `cursor-agent` placeholder, so requests use the CLI login), or a Cursor API
 * key (key / env methods, used by the SDK backend).
 */

const log = createLogger("opencode2:integration");

/** Env vars that can supply a Cursor API key without running /connect. */
export const CURSOR_ENV_NAMES = ["CURSOR_API_KEY"];

/** Locate scripts/cursor-agent-login.mjs from src/opencode2/ or the bundled dist/. */
export function resolveLoginScriptPath(
  currentFile: string = fileURLToPath(import.meta.url),
  checkExists: (path: string) => boolean = existsSync,
): string | undefined {
  const currentDir = dirname(currentFile);
  return [
    resolve(currentDir, "../../scripts/cursor-agent-login.mjs"),
    resolve(currentDir, "../scripts/cursor-agent-login.mjs"),
  ].find(checkExists);
}

/** Register the Cursor integration and its login / key / env connection methods. */
export function applyCursorIntegration(draft: IntegrationDraft): void {
  draft.update(CURSOR_INTEGRATION_ID, (integration) => {
    integration.id = CURSOR_INTEGRATION_ID;
    integration.name = "Cursor";
  });

  const loginScript = resolveLoginScriptPath();
  if (loginScript) {
    try {
      draft.method.update({
        integrationID: CURSOR_INTEGRATION_ID,
        method: {
          id: "cursor-agent-login",
          type: "command",
          label: "Log in with cursor-agent (browser)",
          command: [process.env.CURSOR_ACP_NODE_BIN || "node", loginScript, resolveCursorAgentBinary()],
        },
      });
    } catch (error) {
      // Hosts that predate command methods keep the key / env methods.
      log.warn("Could not register cursor-agent login method", { error: String(error) });
    }
  }

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
