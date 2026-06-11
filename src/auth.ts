// src/auth.ts

import { existsSync } from "fs";
import { homedir, platform } from "os";
import { join } from "path";
import { createLogger } from "./utils/logger";

const log = createLogger("auth");

// Polling configuration for auth file detection
const AUTH_POLL_INTERVAL = 2000; // Check every 2 seconds
const AUTH_POLL_TIMEOUT = 5 * 60 * 1000; // 5 minutes total timeout
const URL_EXTRACTION_TIMEOUT = 10000; // Wait up to 10 seconds for URL

export interface AuthResult {
  type: "success" | "failed";
  provider?: string;
  key?: string;
  error?: string;
}

function getHomeDir(): string {
  const override = process.env.CURSOR_ACP_HOME_DIR;
  if (override && override.length > 0) {
    return override;
  }
  return homedir();
}

export async function pollForAuthFile(
  timeoutMs: number = AUTH_POLL_TIMEOUT,
  intervalMs: number = AUTH_POLL_INTERVAL
): Promise<boolean> {
  const startTime = Date.now();
  const possiblePaths = getPossibleAuthPaths();

  return new Promise((resolve) => {
    const check = () => {
      const elapsed = Date.now() - startTime;
      
      for (const authPath of possiblePaths) {
        if (existsSync(authPath)) {
          log.debug("Auth file detected", { path: authPath });
          resolve(true);
          return;
        }
      }

      log.debug("Polling for auth file", {
        checkedPaths: possiblePaths,
        elapsed: `${elapsed}ms`,
        timeout: `${timeoutMs}ms`,
      });

      if (elapsed >= timeoutMs) {
        log.debug("Auth file polling timed out");
        resolve(false);
        return;
      }

      setTimeout(check, intervalMs);
    };

    check();
  });
}

export function verifyCursorAuth(): boolean {
  // API key takes priority over auth file
  const apiKey = process.env.CURSOR_API_KEY;
  if (apiKey && apiKey.trim().length > 0) {
    log.debug("CURSOR_API_KEY found, auth verified");
    return true;
  }

  const possiblePaths = getPossibleAuthPaths();
  for (const authPath of possiblePaths) {
    if (existsSync(authPath)) {
      log.debug("Auth file found", { path: authPath });
      return true;
    }
  }

  log.debug("No auth found (no CURSOR_API_KEY, no auth file)", { checkedPaths: possiblePaths });
  return false;
}

/**
 * Returns all possible auth file paths in priority order.
 * Checks both auth.json (legacy) and cli-config.json (current cursor-agent format).
 * - macOS: ~/.cursor/ (primary), ~/.config/cursor/ (fallback)
 * - Linux: ~/.config/cursor/ (XDG), XDG_CONFIG_HOME/cursor/, ~/.cursor/
 */
export function getPossibleAuthPaths(): string[] {
  const home = getHomeDir();
  const paths: string[] = [];
  const isDarwin = platform() === "darwin";

  const authFiles = ["cli-config.json", "auth.json"];

  if (isDarwin) {
    for (const file of authFiles) {
      paths.push(join(home, ".cursor", file));
    }
    for (const file of authFiles) {
      paths.push(join(home, ".config", "cursor", file));
    }
  } else {
    for (const file of authFiles) {
      paths.push(join(home, ".config", "cursor", file));
    }

    const xdgConfig = process.env.XDG_CONFIG_HOME;
    if (xdgConfig && xdgConfig !== join(home, ".config")) {
      for (const file of authFiles) {
        paths.push(join(xdgConfig, "cursor", file));
      }
    }

    for (const file of authFiles) {
      paths.push(join(home, ".cursor", file));
    }
  }

  return paths;
}

export function getAuthFilePath(): string {
  const possiblePaths = getPossibleAuthPaths();
  
  for (const authPath of possiblePaths) {
    if (existsSync(authPath)) {
      return authPath;
    }
  }
  
  return possiblePaths[0];
}
