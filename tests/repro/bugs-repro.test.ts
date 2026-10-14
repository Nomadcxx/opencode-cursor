/**
 * Regression tests for two bugs caused by the plugin registering tool hooks that
 * shadowed Kilo-native tools with the same name:
 *
 *  Bug 1 — image `read` returned truncated/garbled TEXT instead of an image attachment.
 *  Bug 2 — plugin-wrapped native tools bypassed the Kilo `permission` rules.
 *
 * Root cause: in `opencode` mode Kilo owns execution of edit/write/read/bash/glob, but
 * the plugin registered same-named hooks. "A custom tool with the same name as a built-in
 * wins", so the plugin's text-only `read` (and its permission-less bash/glob/... handlers)
 * replaced the native implementations — dropping native image/PDF attachments and the
 * `ctx.ask(...)` permission checks embedded in the native tools.
 *
 * Fix: exclude these native names from the tool-hook map in `opencode` mode
 * (see `shouldRegisterNativeToolHook` / `OPENCODE_NATIVE_TOOL_HOOK_EXCLUSIONS`) and keep
 * the `oc_*` aliases for local execution. The canonical fallback entries advertise the
 * Kilo-native schemas so model calls route correctly to the native tools.
 */
import { describe, it, expect } from "bun:test";
import { CursorPlugin, buildLocalFallbackTools, shouldRegisterNativeToolHook } from "../../src/plugin";
import { ToolRegistry as CoreRegistry } from "../../src/tools/core/registry";
import { registerDefaultTools } from "../../src/tools/defaults";
import type { PluginInput } from "@kilocode/plugin";

function createMockInput(directory: string, worktree: string = directory): PluginInput {
  return {
    directory,
    worktree,
    serverUrl: new URL("http://localhost:8080"),
    client: { tool: { list: async () => [] } } as any,
    project: {} as any,
    $: {} as any,
  };
}

// Kilo-native tool names that the plugin's local registry also uses. Shadowing any of
// these in `opencode` mode breaks native attachments and/or permission enforcement.
const KILO_NATIVE_NAMES = ["read", "bash", "glob", "edit", "write"] as const;

describe("bug 1 regression: native `read` is not shadowed (image/PDF attachments preserved)", () => {
  it("does not register a `read` tool hook in opencode mode", async () => {
    const hooks = await CursorPlugin(createMockInput("/test/dir"));

    // If the plugin shadowed `read`, Kilo's image-aware native read would never run.
    expect(hooks.tool?.read).toBeUndefined();

    // The plugin keeps its own local/compat alias for explicit/late-bound calls.
    expect(hooks.tool?.oc_read).toBeDefined();
    expect(typeof hooks.tool?.oc_read?.execute).toBe("function");
  }, 30000);

  it("advertises the canonical `read` fallback with the native filePath schema", () => {
    const registry = new CoreRegistry();
    registerDefaultTools(registry);
    const tools = buildLocalFallbackTools(registry, "opencode");

    const read = tools.find((t) => t.name === "read") as any;
    expect(read.parameters.required).toEqual(["filePath"]);
    expect(read.parameters.properties).toHaveProperty("filePath");
    expect(read.parameters.properties).not.toHaveProperty("path");

    // The oc_read alias keeps the plugin's snake_case contract.
    const ocRead = tools.find((t) => t.name === "oc_read") as any;
    expect(ocRead.parameters.required).toEqual(["path"]);
  });
});

describe("bug 2 regression: native tool names are not shadowed (permission rules apply)", () => {
  it("registers no hook for any Kilo-native tool name in opencode mode", async () => {
    const hooks = await CursorPlugin(createMockInput("/test/dir"));
    const names = Object.keys(hooks.tool || {});

    for (const native of KILO_NATIVE_NAMES) {
      expect(names).not.toContain(native);
    }
    // `shell` is a cursor-agent alias for the native `bash` tool; leaving it as a
    // plugin hook would re-open the same permission bypass under a different name.
    expect(names).not.toContain("shell");
    // Local aliases remain available for the compatibility/fallback path.
    for (const native of KILO_NATIVE_NAMES) {
      expect(names).toContain(`oc_${native}`);
    }
  }, 30000);

  it("gates shadowing to opencode mode only", () => {
    for (const native of KILO_NATIVE_NAMES) {
      expect(shouldRegisterNativeToolHook(native, "opencode")).toBe(false);
      // Legacy proxy-exec and off modes execute plugin-locally, so hooks stay.
      expect(shouldRegisterNativeToolHook(native, "proxy-exec")).toBe(true);
      expect(shouldRegisterNativeToolHook(native, "off")).toBe(true);
    }
    // Non-native plugin tools keep their hooks in every mode.
    expect(shouldRegisterNativeToolHook("ls", "opencode")).toBe(true);
    expect(shouldRegisterNativeToolHook("mkdir", "opencode")).toBe(true);
    expect(shouldRegisterNativeToolHook("stat", "opencode")).toBe(true);
  });

  it("advertises native schemas for canonical bash/glob fallbacks", () => {
    const registry = new CoreRegistry();
    registerDefaultTools(registry);
    const tools = buildLocalFallbackTools(registry, "opencode");
    const byName = (name: string) => tools.find((t) => t.name === name) as any;

    // Native bash uses `workdir`; the plugin's local bash uses `cwd`.
    expect(byName("bash").parameters.properties).toHaveProperty("workdir");
    expect(byName("bash").parameters.properties).not.toHaveProperty("cwd");

    // Native and plugin glob share `pattern`/`path`, so no remap is expected.
    expect(byName("glob").parameters.properties).toHaveProperty("pattern");
    expect(byName("glob").parameters.properties).toHaveProperty("path");

    // Aliases stay snake_case.
    expect(byName("oc_bash").parameters.properties).toHaveProperty("cwd");
  });
});
