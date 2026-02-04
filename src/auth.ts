// src/auth.ts

import { spawn } from "child_process";
import { existsSync } from "fs";
import { homedir } from "os";
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

/**
 * Poll for authentication file with timeout
 */
async function pollForAuthFile(
  timeoutMs: number = AUTH_POLL_TIMEOUT,
  intervalMs: number = AUTH_POLL_INTERVAL
): Promise<boolean> {
  const startTime = Date.now();
  const authFile = getAuthFilePath();

  return new Promise((resolve) => {
    const check = () => {
      const elapsed = Date.now() - startTime;
      const exists = existsSync(authFile);

      log.debug("Polling for auth file", {
        path: authFile,
        exists,
        elapsed: `${elapsed}ms`,
        timeout: `${timeoutMs}ms`,
      });

      if (exists) {
        log.info("Auth file detected");
        resolve(true);
        return;
      }

      if (elapsed >= timeoutMs) {
        log.warn("Auth file polling timed out");
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
  // cursor-agent stores auth in ~/.config/cursor/auth.json (not ~/.cursor/)
  const authFile = join(homedir(), ".config", "cursor", "auth.json");
  const exists = existsSync(authFile);
  log.debug("Checking auth file", { path: authFile, exists });
  return exists;
}

export function getAuthFilePath(): string {
  return join(homedir(), ".config", "cursor", "auth.json");
}
