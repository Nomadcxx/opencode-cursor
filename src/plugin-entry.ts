/**
 * OpenCode plugin entrypoint (OpenCode 1.x + next-era dual export).
 *
 * OpenCode 1.x loads plugins as an async factory function (or an object with a
 * `server` field). The `setup` field targets the next-era OpenCode 2 preview
 * (`ctx.catalog`) via `plugin-v2.ts`.
 *
 * Stable OpenCode 2.0 removed `ctx.catalog`. Load the dedicated entry instead:
 *   `@rama_nigg/open-cursor/plugin/opencode2`
 * Do not rely on this dual export for stable 2.0.
 *
 * When cursor-acp is removed from the `plugin` array in opencode.json,
 * this entrypoint turns into a no-op so users can disable the plugin
 * without deleting the symlink file.
 */
import type { Plugin } from "@opencode-ai/plugin";
import { shouldEnableCursorPlugin } from "./plugin-toggle.js";
import { createLogger } from "./utils/logger.js";
import { createV2Setup } from "./plugin-v2.js";

const log = createLogger("plugin-entry");

const CursorPluginEntry: Plugin = async (input) => {
  const state = shouldEnableCursorPlugin();
  if (!state.enabled) {
    log.info("Plugin disabled in OpenCode config; skipping initialization", {
      configPath: state.configPath,
      reason: state.reason,
    });
    return {};
  }

  const mod = await import("./plugin.js");
  return mod.CursorPlugin(input);
};

export default {
  id: "open-cursor",
  server: CursorPluginEntry,
  setup: createV2Setup(),
};
