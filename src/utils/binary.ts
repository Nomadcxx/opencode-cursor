// src/utils/binary.ts
//
// Resolves the cursor-agent executable path. On Windows the binary is a `.cmd`
// shim, which Node's spawn cannot execute directly without `shell: true` —
// callers therefore pair this resolver with `shell: process.platform === "win32"`
// and `formatShellCommandForPlatform()` at every Node spawn site. That re-enables
// shell metacharacter interpretation, so any user-controlled string passed as an
// argument on Windows must be treated as untrusted; never concatenate user input
// into argv on win32.
import { existsSync as fsExistsSync } from "fs";
import * as pathModule from "path";
import { homedir as osHomedir } from "os";
import { createLogger } from "./logger.js";
import { BinaryNotFoundError } from "./errors.js";

const log = createLogger("binary");

export type BinaryDeps = {
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  existsSync?: (path: string) => boolean;
  homedir?: () => string;
};

export function resolveCursorAgentBinary(deps: BinaryDeps = {}): string {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const checkExists = deps.existsSync ?? fsExistsSync;
  const home = (deps.homedir ?? osHomedir)();

  const envOverride = env.CURSOR_AGENT_EXECUTABLE;
  if (envOverride && envOverride.length > 0) {
    return envOverride;
  }

  if (platform === "win32") {
    const pathJoin = pathModule.win32.join;
    const localAppData = env.LOCALAPPDATA ?? pathJoin(home, "AppData", "Local");
    const knownPath = pathJoin(localAppData, "cursor-agent", "cursor-agent.cmd");
    if (checkExists(knownPath)) {
      return knownPath;
    }
    log.warn("cursor-agent not found at known Windows path, falling back to PATH", { checkedPath: knownPath });
    return "cursor-agent.cmd";
  }

  const knownPaths = [
    pathModule.join(home, ".cursor-agent", "cursor-agent"),
    "/usr/local/bin/cursor-agent",
  ];
  for (const p of knownPaths) {
    if (checkExists(p)) {
      return p;
    }
  }

  log.warn("cursor-agent not found at known paths, falling back to PATH", { checkedPaths: knownPaths });
  return "cursor-agent";
}

/**
 * Strict variant of resolveCursorAgentBinary for use by the pool runner.
 * On win32, throws BinaryNotFoundError when the known install path does not
 * exist and no CURSOR_AGENT_EXECUTABLE env override is set. On non-win32,
 * behaves identically to resolveCursorAgentBinary (no throw).
 */
export function resolveCursorAgentBinaryStrict(deps: BinaryDeps = {}): string {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const checkExists = deps.existsSync ?? fsExistsSync;
  const home = (deps.homedir ?? osHomedir)();

  const envOverride = env.CURSOR_AGENT_EXECUTABLE;
  if (envOverride && envOverride.length > 0) {
    return envOverride;
  }

  if (platform === "win32") {
    const pathJoin = pathModule.win32.join;
    const localAppData = env.LOCALAPPDATA ?? pathJoin(home, "AppData", "Local");
    const knownPath = pathJoin(localAppData, "cursor-agent", "cursor-agent.cmd");
    if (checkExists(knownPath)) {
      return knownPath;
    }
    throw new BinaryNotFoundError(knownPath);
  }

  // Non-win32: delegate to the plain resolver (no throw).
  return resolveCursorAgentBinary(deps);
}

export function formatShellCommandForPlatform(
  command: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== "win32") {
    return command;
  }
  if (command.startsWith("\"") && command.endsWith("\"")) {
    return command;
  }
  return `"${command}"`;
}
