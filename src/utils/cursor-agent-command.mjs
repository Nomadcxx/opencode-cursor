import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { win32 } from "node:path";

/**
 * Bypass Cursor's batch launcher: its delayed expansion changes ! in argv.
 * Spawn the result with `windowsHide: true`: a console-less parent (OpenCode
 * run as a service) otherwise opens a visible window per call. With the window
 * hidden nobody can answer a prompt, so PowerShell runs `-NonInteractive` and
 * fails instead of waiting forever.
 * @param {string} command
 * @param {string[]} args
 * @param {{platform?: NodeJS.Platform, env?: Record<string, string | undefined>, existsSync?: (path: string) => boolean}} deps
 * @returns {[string, string[]]}
 */
export function buildCursorAgentSpawnCommand(command, args, deps = {}) {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const exists = deps.existsSync ?? existsSync;
  if (platform === "win32" && win32.isAbsolute(command) && /\.cmd$/i.test(command)) {
    const script = command.replace(/\.cmd$/i, ".ps1");
    if (exists(script)) {
      const powershell = win32.join(env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      return [powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, ...args]];
    }
  }
  return [command, args];
}

/**
 * Stop a cursor-agent child and everything it started. On Windows the child
 * is `powershell.exe` running `cursor-agent.ps1`; killing it alone leaves the
 * `node.exe` it launched running, so `taskkill /T` takes the whole tree. The
 * tree is only reachable while the parent lives, so taskkill runs first.
 * Children without a pid (SDK and pool wrappers) stop through their own kill().
 * @param {{pid?: number, kill: (signal?: NodeJS.Signals) => unknown} | null | undefined} child
 * @param {NodeJS.Signals} [signal]
 * @param {{platform?: NodeJS.Platform, spawnSync?: typeof spawnSync}} [deps]
 */
export function killCursorAgentTree(child, signal = "SIGTERM", deps = {}) {
  if (!child) return;
  const platform = deps.platform ?? process.platform;
  if (platform === "win32" && typeof child.pid === "number") {
    const run = deps.spawnSync ?? spawnSync;
    const result = run("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
      timeout: 5000,
    });
    if (!result.error && result.status === 0) return;
  }
  try {
    child.kill(signal);
  } catch {
    // Already exited.
  }
}
