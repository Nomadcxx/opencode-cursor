/**
 * OpenCode plugin entrypoint (OpenCode 1.x + 2.0 dual export).
 *
 * Both hosts install the bare package name and resolve `exports["."]` to this
 * module; neither reads custom `exports` subpaths (OpenCode 2.0 treats
 * `@scope/pkg/sub/path` as a local directory and fails with ENOENT, issue #135).
 * So one default export serves both:
 *   - OpenCode 1.x (>= 1.18.29) calls `server()`; older 1.x unwraps `.server`.
 *   - OpenCode 2.0 decodes `{ id, setup }` and ignores the extra `server` key.
 *
 * Config: `{ "plugin": ["@rama_nigg/open-cursor"] }` on 1.x,
 *         `{ "plugins": ["@rama_nigg/open-cursor"] }` on 2.0.
 *
 * When cursor-acp is removed from the `plugin` array in opencode.json,
 * this entrypoint turns into a no-op so users can disable the plugin
 * without deleting the symlink file.
 */
import type { Plugin } from "@opencode-ai/plugin";
import { shouldEnableCursorPlugin } from "./plugin-toggle.js";
import { createLogger } from "./utils/logger.js";
import type { Plugin2 } from "./opencode2/types.js";
import { claimLocation } from "./opencode2/location-claim.js";

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

// Stable OpenCode 2.0 (`ctx.provider.transform`). Lazy so the 1.x path does
// not pay for the 2.0 module graph.
const setup: Plugin2["setup"] = async (ctx) => {
  const directory = ctx.location?.directory || process.cwd();
  const claim = claimLocation(directory, import.meta.url);
  if (!claim.claimed) {
    log.warn("Another open-cursor copy is already set up here; skipping this one. "
      + "Remove the 1.x plugin file (usually ~/.config/opencode/plugin/cursor-acp.js).", {
      directory,
      active: claim.owner,
      skipped: import.meta.url,
    });
    return;
  }

  try {
    const mod = await import("./plugin-opencode2.js");
    const cleanup = await mod.default.setup(ctx);
    return async () => {
      try {
        await cleanup?.();
      } finally {
        claim.release();
      }
    };
  } catch (error) {
    claim.release();
    throw error;
  }
};

export default {
  id: "open-cursor",
  server: CursorPluginEntry,
  setup,
};
