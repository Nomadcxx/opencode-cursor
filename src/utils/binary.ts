import { existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export function resolveCursorAgentBinary(): string {
  const envOverride = process.env.CURSOR_AGENT_EXECUTABLE;
  if (envOverride && envOverride.length > 0) {
    return envOverride;
  }

  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
    const knownPath = join(localAppData, "cursor-agent", "cursor-agent.cmd");
    if (existsSync(knownPath)) {
      return knownPath;
    }
    return "cursor-agent.cmd";
  }

  const home = homedir();
  const knownPaths = [
    join(home, ".cursor-agent", "cursor-agent"),
    "/usr/local/bin/cursor-agent",
  ];
  for (const p of knownPaths) {
    if (existsSync(p)) {
      return p;
    }
  }

  return "cursor-agent";
}
