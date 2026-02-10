// src/auth.ts

import { spawn } from "child_process";
import { existsSync } from "fs";
import { homedir, platform } from "os";
import { join } from "path";
import { createLogger } from "./utils/logger";
import { stripAnsi } from "./utils/errors";

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

export async function startCursorOAuth(): Promise<{
  url: string;
  instructions: string;
  callback: () => Promise<AuthResult>;
}> {
  return new Promise((resolve, reject) => {
    log.info("Starting cursor-cli login process");

    const proc = spawn("cursor-agent", ["login"], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let urlExtracted = false;

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    const extractUrl = () => {
      // Step 1: Strip ANSI codes
      let cleanOutput = stripAnsi(stdout);
      // Step 2: Remove ALL whitespace (newlines, spaces, tabs)
      // The URL is split across lines with continuation spaces
      cleanOutput = cleanOutput.replace(/\s/g, "");
      // Step 3: Now extract the continuous URL
      const urlMatch = cleanOutput.match(/https:\/\/cursor\.com\/loginDeepControl[^\s]*/);
      if (urlMatch) {
        return urlMatch[0];
      }
      return null;
    };

    // Try to extract URL with polling instead of fixed timeout
    const tryExtractUrl = () => {
      const url = extractUrl();

      if (url && !urlExtracted) {
        urlExtracted = true;
        log.debug("Captured stdout", { length: stdout.length });
        log.debug("Extracted URL", { url: url.substring(0, 50) + "..." });
        log.info("Got login URL, waiting for browser auth");

        resolve({
          url,
          instructions: "Click 'Continue with Cursor' in your browser to authenticate",
          callback: async () => {
            // Wait for process to complete
            return new Promise((resolve) => {
              let resolved = false;

              const resolveOnce = (result: AuthResult) => {
                if (!resolved) {
                  resolved = true;
                  resolve(result);
                }
              };

              proc.on("close", async (code) => {
                log.debug("Login process closed", { code });

                // If process exited successfully, poll for auth file
                if (code === 0) {
                  log.info("Process exited successfully, polling for auth file...");
                  const isAuthenticated = await pollForAuthFile();

                  if (isAuthenticated) {
                    log.info("Authentication successful");
                    resolveOnce({
                      type: "success",
                      provider: "cursor-acp",
                      key: "cursor-auth",
                    });
                  } else {
                    log.warn("Auth file not found after polling");
                    resolveOnce({
                      type: "failed",
                      error: "Authentication was not completed. Please try again.",
                    });
                  }
                } else {
                  log.warn("Login process failed", { code });
                  resolveOnce({
                    type: "failed",
                    error: stderr ? stripAnsi(stderr) : `Authentication failed with code ${code}`,
                  });
                }
              });

              // Timeout after 5 minutes
              setTimeout(() => {
                log.warn("Authentication timed out after 5 minutes");
                proc.kill();
                resolveOnce({
                  type: "failed",
                  error: "Authentication timed out. Please try again.",
                });
              }, AUTH_POLL_TIMEOUT);
            });
          },
        });
      }
    };

    // Poll for URL extraction with timeout
    const urlPollStart = Date.now();
    const pollForUrl = () => {
      if (urlExtracted) return;

      const elapsed = Date.now() - urlPollStart;
      if (elapsed >= URL_EXTRACTION_TIMEOUT) {
        proc.kill();
        const errorMsg = stderr ? stripAnsi(stderr) : "No login URL received within timeout";
        log.error("Failed to extract login URL", { error: errorMsg, elapsed: `${elapsed}ms` });
        reject(new Error(`Failed to get login URL: ${errorMsg}`));
        return;
      }

      tryExtractUrl();

      if (!urlExtracted) {
        setTimeout(pollForUrl, 100); // Check every 100ms
      }
    };

    // Start polling for URL
    pollForUrl();
  });
}

export function verifyCursorAuth(): boolean {
  const possiblePaths = getPossibleAuthPaths();
  
  for (const authPath of possiblePaths) {
    if (existsSync(authPath)) {
      log.debug("Auth file found", { path: authPath });
      return true;
    }
  }
  
  log.debug("No auth file found", { checkedPaths: possiblePaths });
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
