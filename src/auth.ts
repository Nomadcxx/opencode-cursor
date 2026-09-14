// src/auth.ts

import { existsSync, readFileSync } from "fs";
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

export interface ResolveSdkApiKeyInput {
  env?: Pick<NodeJS.ProcessEnv, "CURSOR_API_KEY">;
  storedApiKey?: string;
  authorizationHeader?: string | null;
}

const PLACEHOLDER_API_KEYS = new Set(["cursor-agent"]);

function getHomeDir(): string {
  const override = process.env.CURSOR_KILO_HOME_DIR;
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
        if (fileHasCursorCredentials(authPath)) {
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
    if (fileHasCursorCredentials(authPath)) {
      log.debug("Auth file found", { path: authPath });
      return true;
    }
  }

  log.debug("No auth found (no CURSOR_API_KEY, no credential file)", { checkedPaths: possiblePaths });
  return false;
}

/** Parse `cursor-agent status` / `whoami` text. Exit code 0 does not mean logged in. */
export function cursorAgentStatusLooksLoggedIn(output: string): boolean {
  const text = output.replace(/\u001b\[[0-9;]*m/g, "");
  if (/not logged in/i.test(text) || /partially authenticated/i.test(text)) {
    return false;
  }
  return /logged in/i.test(text) || /login successful/i.test(text);
}

/** True when a cursor-agent credential file contains usable tokens. */
export function fileHasCursorCredentials(authPath: string): boolean {
  if (!existsSync(authPath)) {
    return false;
  }

  try {
    const parsed = JSON.parse(readFileSync(authPath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return false;
    }
    const record = parsed as Record<string, unknown>;
    return [record.accessToken, record.refreshToken, record.apiKey].some(
      (value) => typeof value === "string" && value.trim().length > 0,
    );
  } catch {
    return false;
  }
}

export function isUsableSdkApiKey(value: string | undefined | null): value is string {
  const trimmed = value?.trim();
  if (!trimmed) {
    return false;
  }

  return !PLACEHOLDER_API_KEYS.has(trimmed.toLowerCase());
}

export function normalizeAuthorizationHeader(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }

  const bearerMatch = /^bearer\s+(.+)$/i.exec(trimmed);
  return bearerMatch?.[1]?.trim() ?? trimmed;
}

export function resolveSdkApiKey(input: ResolveSdkApiKeyInput): string | undefined {
  const candidates = [
    input.env?.CURSOR_API_KEY,
    input.storedApiKey,
    normalizeAuthorizationHeader(input.authorizationHeader),
  ];

  return candidates.find(isUsableSdkApiKey)?.trim();
}

/**
 * Returns credential file paths in priority order.
 * cursor-agent 2026.09+ stores tokens in auth.json (or the OS keychain on macOS).
 * cli-config.json is CLI settings; older builds sometimes put tokens there too.
 * - macOS: ~/.cursor/auth.json (primary)
 * - Linux: ~/.config/cursor/auth.json (XDG)
 * - Windows: %APPDATA%/Cursor/auth.json
 */
export function getPossibleAuthPaths(): string[] {
  const home = getHomeDir();
  const paths: string[] = [];
  const os = platform();

  const addDir = (dir: string) => {
    paths.push(join(dir, "auth.json"));
    paths.push(join(dir, "cli-config.json"));
  };

  if (os === "win32") {
    const appData = process.env.APPDATA || join(home, "AppData", "Roaming");
    addDir(join(appData, "Cursor"));
    addDir(join(home, ".cursor"));
    addDir(join(home, ".config", "cursor"));
    return paths;
  }

  if (os === "darwin") {
    addDir(join(home, ".cursor"));
    addDir(join(home, ".config", "cursor"));
    return paths;
  }

  const xdgConfig = process.env.XDG_CONFIG_HOME || join(home, ".config");
  addDir(join(xdgConfig, "cursor"));
  if (xdgConfig !== join(home, ".config")) {
    addDir(join(home, ".config", "cursor"));
  }
  addDir(join(home, ".cursor"));
  return paths;
}

export function getAuthFilePath(): string {
  const possiblePaths = getPossibleAuthPaths();
  
  for (const authPath of possiblePaths) {
    if (fileHasCursorCredentials(authPath)) {
      return authPath;
    }
  }

  const authJson = possiblePaths.find((path) => path.endsWith("auth.json"));
  return authJson ?? possiblePaths[0];
}
