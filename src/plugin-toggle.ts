import { existsSync, readFileSync } from "fs";
import {
  isKiloPluginEnabledInConfig,
  KILO_PROVIDER_ID,
  matchesPlugin,
  parseConfigJson,
  resolveKiloConfigPath,
} from "./kilo/platform.js";

export {
  KILO_PROVIDER_ID as CURSOR_PROVIDER_ID,
  matchesPlugin,
  resolveKiloConfigPath,
};

/** @deprecated Use resolveKiloConfigPath */
export const resolveOpenCodeConfigPath = resolveKiloConfigPath;

export function isCursorPluginEnabledInConfig(config: unknown): boolean {
  return isKiloPluginEnabledInConfig(config);
}

export function shouldEnableCursorPlugin(env: Record<string, string | undefined> = process.env): {
  enabled: boolean;
  configPath: string;
  reason: string;
} {
  const configPath = resolveKiloConfigPath(env);

  if (!existsSync(configPath)) {
    return {
      enabled: true,
      configPath,
      reason: "config_missing",
    };
  }

  try {
    const raw = readFileSync(configPath, "utf8");
    const parsed = parseConfigJson(raw);
    if (!parsed) {
      return {
        enabled: true,
        configPath,
        reason: "config_unreadable_or_invalid",
      };
    }
    const enabled = isKiloPluginEnabledInConfig(parsed);

    return {
      enabled,
      configPath,
      reason: enabled ? "enabled" : "disabled_in_plugin_array",
    };
  } catch {
    return {
      enabled: true,
      configPath,
      reason: "config_unreadable_or_invalid",
    };
  }
}
