// src/commands/status.ts

import { existsSync, readFileSync } from "fs";
import { getAuthFilePath } from "../auth";
import { createLogger } from "../utils/logger";

const log = createLogger("status");

export interface AuthStatus {
  authenticated: boolean;
  authFilePath: string;
  message: string;
}

export function checkAuthStatus(): AuthStatus {
  const authFilePath = getAuthFilePath();
  const exists = existsSync(authFilePath);

  log.debug("Checking auth status", { path: authFilePath });

  if (exists) {
    return {
      authenticated: true,
      authFilePath,
      message: `✓ Cursor: Authenticated\n  Auth file: ${authFilePath}`,
    };
  }

  return {
    authenticated: false,
    authFilePath,
    message: `✗ Cursor: Not authenticated\n  Run: opencode auth login cursor-kilo`,
  };
}

export function formatStatusOutput(): string {
  const status = checkAuthStatus();
  return status.message;
}
