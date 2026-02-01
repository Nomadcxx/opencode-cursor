import { spawn } from "child_process";
import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export interface AuthResult {
  type: "success" | "failed";
  provider?: string;
  key?: string;
}

export async function startCursorOAuth(): Promise<{
  url: string;
  instructions: string;
  callback: () => Promise<AuthResult>;
}> {
  return new Promise((resolve, reject) => {
    const proc = spawn("cursor-agent", ["login"], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    // Strip ANSI escape codes and extract URL
    const stripAnsi = (str: string) => str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");

    const extractUrl = () => {
      const cleanOutput = stripAnsi(stdout);
      // Handle URL that might span multiple lines
      const normalized = cleanOutput.replace(/\n/g, " ");
      const urlMatch = normalized.match(/https:\/\/cursor\.com\/loginDeepControl[^\s]+/);
      if (urlMatch) {
        return urlMatch[0];
      }
      return null;
    };

    // Give cursor-agent time to output the URL
    setTimeout(() => {
      const url = extractUrl();

      if (!url) {
        proc.kill();
        reject(new Error("Failed to get login URL from cursor-agent. Is cursor-agent installed?"));
        return;
      }

      resolve({
        url,
        instructions: "Click 'Continue with Cursor' in your browser to authenticate",
        callback: async () => {
          // Wait for process to complete
          return new Promise((resolve) => {
            proc.on("close", (code) => {
              const isAuthenticated = verifyCursorAuth();
              if (code === 0 && isAuthenticated) {
                resolve({
                  type: "success",
                  provider: "cursor-acp",
                  key: "cursor-agent-auth",
                });
              } else {
                resolve({ type: "failed" });
              }
            });

            // Timeout after 5 minutes
            setTimeout(() => {
              proc.kill();
              resolve({ type: "failed" });
            }, 5 * 60 * 1000);
          });
        },
      });
    }, 1000);
  });
}

export function verifyCursorAuth(): boolean {
  const authFile = join(homedir(), ".cursor", "auth.json");
  return existsSync(authFile);
}
