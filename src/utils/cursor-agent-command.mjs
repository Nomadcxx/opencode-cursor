import { existsSync } from "node:fs";
import { win32 } from "node:path";

/**
 * Bypass Cursor's batch launcher: its delayed expansion changes ! in argv.
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
      return [powershell, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, ...args]];
    }
  }
  return [command, args];
}
