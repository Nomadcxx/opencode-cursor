import { describe, expect, it } from "bun:test";
import { CursorPlugin } from "../../src/plugin";
import type { PluginInput } from "@opencode-ai/plugin";

function createMockInput(directory: string, worktree: string = directory): PluginInput {
  return {
    directory,
    worktree,
    serverUrl: new URL("http://localhost:8080"),
    client: {
      tool: {
        list: async () => [],
      },
    } as any,
    project: {} as any,
    $: {} as any,
  };
}

describe("experimental.chat.system.transform", () => {
  it("injects system guidance for cursor-acp models", async () => {
    const hooks = await CursorPlugin(createMockInput("/tmp/opencode-cursor-test"));
    const transform = hooks["experimental.chat.system.transform"] as any;
    const output: { system?: string[] } = {};

    await transform({ model: { providerID: "cursor-acp" } }, output);

    expect(output.system).toBeArray();
    expect(output.system?.length).toBeGreaterThan(0);
  });

  it("does not inject system guidance for non-cursor providers", async () => {
    const hooks = await CursorPlugin(createMockInput("/tmp/opencode-cursor-test"));
    const transform = hooks["experimental.chat.system.transform"] as any;
    const output: { system?: string[] } = {};

    await transform({ model: { providerID: "sglang" } }, output);

    expect(output.system).toBeUndefined();
  });
});
