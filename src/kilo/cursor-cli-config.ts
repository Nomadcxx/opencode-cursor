import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir, platform } from "node:os";
import { getPossibleAuthPaths } from "../auth.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("cursor-cli-config");

type CliAuthFile = {
  accessToken?: string;
  refreshToken?: string;
  apiKey?: string;
  bedrockCredentials?: unknown;
  [key: string]: unknown;
};

function getHomeDir(): string {
  const override = process.env.CURSOR_KILO_HOME_DIR;
  if (override && override.length > 0) {
    return override;
  }
  return homedir();
}

/**
 * Official cursor-agent credential file (2026.09+).
 * Linux: ~/.config/cursor/auth.json
 * macOS: ~/.cursor/auth.json
 * Windows: %APPDATA%/Cursor/auth.json
 *
 * Tokens are no longer stored in cli-config.json (that file is CLI settings).
 */
export function getCursorAgentAuthFilePaths(): string[] {
  const home = getHomeDir();
  const paths = new Set<string>();

  for (const path of getPossibleAuthPaths()) {
    if (path.endsWith("auth.json")) {
      paths.add(path);
    }
  }

  switch (platform()) {
    case "win32": {
      const appData = process.env.APPDATA || join(home, "AppData", "Roaming");
      paths.add(join(appData, "Cursor", "auth.json"));
      paths.add(join(home, ".cursor", "auth.json"));
      break;
    }
    case "darwin":
      paths.add(join(home, ".cursor", "auth.json"));
      paths.add(join(home, ".config", "cursor", "auth.json"));
      break;
    default: {
      const xdg = process.env.XDG_CONFIG_HOME || join(home, ".config");
      paths.add(join(xdg, "cursor", "auth.json"));
      paths.add(join(home, ".config", "cursor", "auth.json"));
      paths.add(join(home, ".cursor", "auth.json"));
      break;
    }
  }

  return [...paths];
}

async function readJson(path: string): Promise<CliAuthFile> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed as CliAuthFile : {};
  } catch {
    return {};
  }
}

function mergeAuthFile(
  existing: CliAuthFile,
  accessToken: string,
  refreshToken?: string,
): CliAuthFile {
  const next: CliAuthFile = {
    accessToken,
  };
  const refresh = refreshToken || (typeof existing.refreshToken === "string" ? existing.refreshToken : undefined);
  if (refresh) next.refreshToken = refresh;
  if (typeof existing.apiKey === "string" && existing.apiKey.length > 0) {
    next.apiKey = existing.apiKey;
  }
  if (existing.bedrockCredentials) {
    next.bedrockCredentials = existing.bedrockCredentials;
  }
  return next;
}

/** Best-effort sync of Kilo OAuth tokens into cursor-agent auth.json. */
export async function syncOAuthToCursorAgentAuth(
  accessToken: string,
  refreshToken?: string,
): Promise<void> {
  const targets = getCursorAgentAuthFilePaths();

  for (const target of targets) {
    try {
      const existing = await readJson(target);
      const next = mergeAuthFile(existing, accessToken, refreshToken);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await chmod(target, 0o600).catch(() => undefined);
      log.debug("Synced OAuth tokens to cursor-agent auth.json", { target });
    } catch (err) {
      log.debug("Failed to sync cursor-agent auth.json", { target, error: String(err) });
    }
  }
}

/** @deprecated Use {@link syncOAuthToCursorAgentAuth}. Tokens belong in auth.json, not cli-config.json. */
export async function syncOAuthToCursorCliConfig(
  accessToken: string,
  refreshToken?: string,
): Promise<void> {
  await syncOAuthToCursorAgentAuth(accessToken, refreshToken);
}
