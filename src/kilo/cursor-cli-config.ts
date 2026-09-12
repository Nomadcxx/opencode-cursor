import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { getPossibleAuthPaths } from "../auth.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("cursor-cli-config");

type CliConfig = {
  accessToken?: string;
  refreshToken?: string;
  [key: string]: unknown;
};

function cursorConfigDirs(): string[] {
  const home = process.env.CURSOR_KILO_HOME_DIR || homedir();
  const dirs = new Set<string>();
  for (const path of getPossibleAuthPaths()) {
    dirs.add(dirname(path));
  }
  dirs.add(join(home, ".config", "cursor"));
  dirs.add(join(home, ".cursor"));
  return [...dirs];
}

async function readJson(path: string): Promise<CliConfig> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed as CliConfig : {};
  } catch {
    return {};
  }
}

/** Best-effort sync of Kilo OAuth tokens into cursor-agent cli-config.json. */
export async function syncOAuthToCursorCliConfig(
  accessToken: string,
  refreshToken?: string,
): Promise<void> {
  const targets = cursorConfigDirs().map((dir) => join(dir, "cli-config.json"));

  for (const target of targets) {
    try {
      const existing = await readJson(target);
      const next: CliConfig = {
        ...existing,
        accessToken,
        ...(refreshToken ? { refreshToken } : {}),
      };
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, `${JSON.stringify(next, null, 2)}\n`, "utf8");
      log.debug("Synced OAuth tokens to cursor cli-config", { target });
    } catch (err) {
      log.debug("Failed to sync cursor cli-config", { target, error: String(err) });
    }
  }
}
