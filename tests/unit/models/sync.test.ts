import { beforeEach, describe, expect, it, vi } from "bun:test";
import { autoRefreshModels } from "../../../src/models/sync.js";

type MockDeps = Parameters<typeof autoRefreshModels>[0];

function createDeps(overrides: MockDeps = {}) {
  const debug = vi.fn();
  const info = vi.fn();
  const existsSync = vi.fn(() => true);
  const readFileSync = vi.fn(() =>
    JSON.stringify({
      provider: {
        "cursor-acp": {
          models: {
            auto: { name: "Auto" },
          },
        },
      },
    }),
  );
  const writeFileSync = vi.fn();
  const discoverModels = vi.fn(async () => [
    { id: "auto", name: "Auto" },
    { id: "gpt-5.4-high", name: "GPT-5.4 High" },
  ]);

  const deps = {
    defer: async () => {},
    discoverModels,
    env: { ...process.env, OPENCODE_CONFIG: "/tmp/opencode.json" },
    existsSync,
    log: { debug, info, warn: vi.fn(), error: vi.fn() },
    readFileSync,
    writeFileSync,
    ...overrides,
  };

  return { deps, debug, info, existsSync, readFileSync, writeFileSync, discoverModels };
}

describe("models/sync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("adds newly discovered models without removing existing entries", async () => {
    const { deps, writeFileSync } = createDeps({
      readFileSync: vi.fn(() =>
        JSON.stringify({
          provider: {
            "cursor-acp": {
              models: {
                auto: { name: "Auto" },
                "custom-model": { name: "Custom" },
              },
            },
          },
        }),
      ),
      discoverModels: vi.fn(async () => [
        { id: "auto", name: "Auto" },
        { id: "gpt-5.4-high", name: "GPT-5.4 High" },
        { id: "kimi-k2.5", name: "Kimi K2.5" },
      ]),
    });

    await autoRefreshModels(deps);

    expect(writeFileSync).toHaveBeenCalledTimes(1);
    const [, writtenConfig] = writeFileSync.mock.calls[0];
    const parsed = JSON.parse(writtenConfig as string);
    expect(parsed.provider["cursor-acp"].models).toEqual({
      auto: { name: "Auto" },
      "custom-model": { name: "Custom" },
      "gpt-5.4-high": { name: "GPT-5.4 High" },
      "kimi-k2.5": { name: "Kimi K2.5" },
    });
  });

  it("uses direct additive sync when explicitly requested", async () => {
    const { deps, writeFileSync } = createDeps({
      env: {
        ...process.env,
        OPENCODE_CONFIG: "/tmp/opencode.json",
        CURSOR_ACP_MODEL_AUTO_REFRESH: "direct",
      },
      readFileSync: vi.fn(() =>
        JSON.stringify({
          provider: {
            "cursor-acp": {
              models: {
                auto: { name: "Auto" },
                "custom-model": { name: "Custom" },
              },
            },
          },
        }),
      ),
      discoverModels: vi.fn(async () => [
        { id: "auto", name: "Auto" },
        { id: "gpt-5.4-high", name: "GPT-5.4 High" },
      ]),
    });

    await autoRefreshModels(deps);

    expect(writeFileSync).toHaveBeenCalledTimes(1);
    const [, writtenConfig] = writeFileSync.mock.calls[0];
    const parsed = JSON.parse(writtenConfig as string);
    expect(parsed.provider["cursor-acp"].models).toEqual({
      auto: { name: "Auto" },
      "custom-model": { name: "Custom" },
      "gpt-5.4-high": { name: "GPT-5.4 High" },
    });
  });

  it("can disable startup model refresh", async () => {
    const { deps, readFileSync, writeFileSync, discoverModels } = createDeps({
      env: {
        ...process.env,
        OPENCODE_CONFIG: "/tmp/opencode.json",
        CURSOR_ACP_MODEL_AUTO_REFRESH: "false",
      },
    });

    await autoRefreshModels(deps);

    expect(readFileSync).not.toHaveBeenCalled();
    expect(discoverModels).not.toHaveBeenCalled();
    expect(writeFileSync).not.toHaveBeenCalled();
  });

  it("uses compact variant sync only when explicitly requested", async () => {
    const { deps, writeFileSync } = createDeps({
      env: {
        ...process.env,
        OPENCODE_CONFIG: "/tmp/opencode.json",
        CURSOR_ACP_MODEL_AUTO_REFRESH: "compact",
      },
      readFileSync: vi.fn(() =>
        JSON.stringify({
          provider: {
            "cursor-acp": {
              models: {
                auto: { name: "Auto" },
                "custom-model": { name: "Custom" },
                "gpt-5.4-low": { name: "Old Low" },
                "gpt-5.4-high": { name: "Old High" },
              },
            },
          },
        }),
      ),
      discoverModels: vi.fn(async () => [
        { id: "auto", name: "Auto" },
        { id: "gpt-5.4", name: "GPT-5.4" },
        { id: "gpt-5.4-low", name: "GPT-5.4 Low" },
        { id: "gpt-5.4-high", name: "GPT-5.4 High" },
      ]),
    });

    await autoRefreshModels(deps);

    expect(writeFileSync).toHaveBeenCalledTimes(1);
    const [, writtenConfig] = writeFileSync.mock.calls[0];
    const parsed = JSON.parse(writtenConfig as string);
    expect(parsed.provider["cursor-acp"].models).toMatchObject({
      auto: { name: "Auto" },
      "custom-model": { name: "Custom" },
      "gpt-5.4": {
        name: "GPT-5.4",
        options: { cursorModel: "gpt-5.4" },
        variants: {
          low: { cursorModel: "gpt-5.4-low" },
          high: { cursorModel: "gpt-5.4-high" },
        },
      },
    });
    expect(parsed.provider["cursor-acp"].models["gpt-5.4-low"]).toBeUndefined();
    expect(parsed.provider["cursor-acp"].models["gpt-5.4-high"]).toBeUndefined();
  });

  it("returns silently when the config file is missing", async () => {
    const { deps, readFileSync, writeFileSync, discoverModels } = createDeps({
      existsSync: vi.fn(() => false),
    });

    await expect(autoRefreshModels(deps)).resolves.toBeUndefined();
    expect(readFileSync).not.toHaveBeenCalled();
    expect(discoverModels).not.toHaveBeenCalled();
    expect(writeFileSync).not.toHaveBeenCalled();
  });

  it("returns silently when the config file is invalid JSON", async () => {
    const { deps, writeFileSync, discoverModels } = createDeps({
      readFileSync: vi.fn(() => "{invalid"),
    });

    await expect(autoRefreshModels(deps)).resolves.toBeUndefined();
    expect(discoverModels).not.toHaveBeenCalled();
    expect(writeFileSync).not.toHaveBeenCalled();
  });

  it("returns silently when the provider section is missing", async () => {
    const { deps, writeFileSync, discoverModels } = createDeps({
      readFileSync: vi.fn(() => JSON.stringify({ provider: {} })),
    });

    await expect(autoRefreshModels(deps)).resolves.toBeUndefined();
    expect(discoverModels).not.toHaveBeenCalled();
    expect(writeFileSync).not.toHaveBeenCalled();
  });

  it("returns silently when model discovery fails", async () => {
    const { deps, writeFileSync } = createDeps({
      discoverModels: vi.fn(async () => {
        throw new Error("discovery unavailable");
      }),
    });

    await expect(autoRefreshModels(deps)).resolves.toBeUndefined();
    expect(writeFileSync).not.toHaveBeenCalled();
  });

  it("does not rewrite the config when no new models are discovered", async () => {
    const { deps, writeFileSync, info } = createDeps({
      discoverModels: vi.fn(async () => [{ id: "auto", name: "Auto" }]),
    });

    await autoRefreshModels(deps);

    expect(writeFileSync).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });

  it("uses OPENCODE_CONFIG when resolving the config path", async () => {
    const { deps, existsSync, readFileSync, writeFileSync } = createDeps();

    await autoRefreshModels(deps);

    expect(existsSync).toHaveBeenCalledWith("/tmp/opencode.json");
    expect(readFileSync).toHaveBeenCalledWith("/tmp/opencode.json", "utf8");
    expect(writeFileSync).toHaveBeenCalledWith(
      "/tmp/opencode.json",
      expect.any(String),
      "utf8",
    );
  });

  it("never lets unexpected IO failures escape", async () => {
    const { deps } = createDeps({
      readFileSync: vi.fn(() => {
        throw new Error("read failed");
      }),
    });

    await expect(autoRefreshModels(deps)).resolves.toBeUndefined();
  });
});
