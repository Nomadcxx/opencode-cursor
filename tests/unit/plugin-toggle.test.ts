/// <reference types="bun-types/test-globals" />

import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  isCursorPluginEnabledInConfig,
  resolveOpenCodeConfigPath,
  shouldEnableCursorPlugin,
} from "../../src/plugin-toggle";

describe("plugin toggle", () => {
  it("enables plugin when plugin array includes cursor-acp", () => {
    expect(isCursorPluginEnabledInConfig({ plugin: ["cursor-acp"] })).toBe(true);
  });

  it("enables plugin when plugin array includes npm package name", () => {
    expect(isCursorPluginEnabledInConfig({ plugin: ["@rama_nigg/open-cursor"] })).toBe(true);
  });

  it("enables plugin when plugin array includes npm package name with version", () => {
    expect(isCursorPluginEnabledInConfig({ plugin: ["@rama_nigg/open-cursor@latest"] })).toBe(true);
    expect(isCursorPluginEnabledInConfig({ plugin: ["@rama_nigg/open-cursor@2.3.2"] })).toBe(true);
  });

  it("disables plugin when plugin array excludes cursor-acp", () => {
    expect(isCursorPluginEnabledInConfig({ plugin: ["other-plugin"] })).toBe(false);
  });

  it("keeps legacy behavior when plugin array is missing", () => {
    expect(isCursorPluginEnabledInConfig({ provider: { "cursor-acp": {} } })).toBe(true);
    expect(isCursorPluginEnabledInConfig({ provider: {} })).toBe(true);
  });

  it("resolves config from OPENCODE_CONFIG first", () => {
    const customConfig = join(tmpdir(), "custom-opencode.json");
    const xdgHome = join(tmpdir(), "xdg");
    const path = resolveOpenCodeConfigPath({
      OPENCODE_CONFIG: customConfig,
      XDG_CONFIG_HOME: xdgHome,
    });
    expect(path).toBe(customConfig);
  });

  it("disables when config file exists and plugin array excludes cursor-acp", () => {
    const dir = mkdtempSync(join(tmpdir(), "cursor-toggle-"));
    const configPath = join(dir, "opencode.json");

    try {
      writeFileSync(configPath, JSON.stringify({ plugin: ["other-plugin"] }));
      const state = shouldEnableCursorPlugin({ OPENCODE_CONFIG: configPath });
      expect(state.enabled).toBe(false);
      expect(state.reason).toBe("disabled_in_plugin_array");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stays enabled when config is invalid JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "cursor-toggle-"));
    const configPath = join(dir, "opencode.json");

    try {
      writeFileSync(configPath, "{not-json");
      const state = shouldEnableCursorPlugin({ OPENCODE_CONFIG: configPath });
      expect(state.enabled).toBe(true);
      expect(state.reason).toBe("config_unreadable_or_invalid");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
