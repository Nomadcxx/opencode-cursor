/**
 * Kilo Code plugin entrypoint (dual V1/V2).
 *
 * Kilo loads plugins as an async factory function (V1) or an object with
 * `id` + `setup` (V2). Exporting both keeps a single package working across
 * both API versions.
 *
 * When cursor-kilo is removed from the `plugin` array in kilo.jsonc,
 * this entrypoint turns into a no-op so users can disable the plugin
 * without deleting the symlink file.
 */
import type { Plugin } from "@kilocode/plugin";
import { shouldEnableCursorPlugin } from "./plugin-toggle.js";
import { createLogger } from "./utils/logger.js";
import { createV2Setup } from "./plugin-v2.js";

const log = createLogger("plugin-entry");

const CursorPluginEntry: Plugin = async (input) => {
  const state = shouldEnableCursorPlugin();
  if (!state.enabled) {
    log.info("Plugin disabled in Kilo config; skipping initialization", {
      configPath: state.configPath,
      reason: state.reason,
    });
    return {};
  }

  const mod = await import("./plugin.js");
  return mod.CursorPlugin(input);
};

export default {
  id: "kilo-cursor-plugin",
  server: CursorPluginEntry,
  setup: createV2Setup(),
};
