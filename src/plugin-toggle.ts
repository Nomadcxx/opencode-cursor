import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";

const CURSOR_PROVIDER_ID = "cursor-acp";
const NPM_PACKAGE_NAME = "@rama_nigg/open-cursor";

type EnvLike = Record<string, string | undefined>;

export function resolveOpenCodeConfigPath(env: EnvLike = process.env): string {
  if (env.OPENCODE_CONFIG && env.OPENCODE_CONFIG.length > 0) {
    return resolve(env.OPENCODE_CONFIG);
  }

  const configHome = env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.length > 0
    ? env.XDG_CONFIG_HOME
    : join(homedir(), ".config");

  return join(configHome, "opencode", "opencode.json");
}

function matchesPlugin(entry: unknown): boolean {
  if (typeof entry !== "string") return false;
  if (entry === CURSOR_PROVIDER_ID) return true;
  if (entry === NPM_PACKAGE_NAME || entry.startsWith(NPM_PACKAGE_NAME + "@")) return true;
  return false;
}

export function isCursorPluginEnabledInConfig(config: unknown): boolean {
  if (!config || typeof config !== "object") {
    return true;
  }

  const configObject = config as { plugin?: unknown; provider?: unknown };

  if (Array.isArray(configObject.plugin)) {
    return configObject.plugin.some(matchesPlugin);
  }

  return true;
}

export function shouldEnableCursorPlugin(env: EnvLike = process.env): {
  enabled: boolean;
  configPath: string;
  reason: string;
} {
  const configPath = resolveOpenCodeConfigPath(env);

  if (!existsSync(configPath)) {
    return {
      enabled: true,
      configPath,
      reason: "config_missing",
    };
  }

  try {
    const raw = readFileSync(configPath, "utf8");
    const parsed = JSON.parse(raw);
    const enabled = isCursorPluginEnabledInConfig(parsed);

    return {
      enabled,
      configPath,
      reason: enabled ? "enabled_in_plugin_array_or_legacy" : "disabled_in_plugin_array",
    };
  } catch {
    return {
      enabled: true,
      configPath,
      reason: "config_unreadable_or_invalid",
    };
  }
}
