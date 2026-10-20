import { describe, expect, it } from "bun:test";
import {
  appendIdeEnabledModels,
  cursorStateDbPath,
  mergeIdeEnabledModels,
  readCursorIdeCatalog,
  type IdeCatalog,
} from "../../../src/models/ide-catalog.js";

const glmCatalog: IdeCatalog = {
  availableDefaultModels2: [
    {
      name: "glm-5.2",
      clientDisplayName: "GLM 5.2",
      serverModelName: "glm-5.2",
      supportsAgent: true,
      defaultOn: false,
      legacySlugs: ["glm-5.2-high", "glm-5.2-max"],
    },
    {
      name: "glm-5p3",
      clientDisplayName: "GLM 5.3",
      serverModelName: "glm-5p3",
      supportsAgent: true,
      defaultOn: false,
      legacySlugs: ["glm-5p3", "glm-5p3-low", "glm-5p3-high", "glm-5p3-max"],
      variants: [
        {
          legacySlug: "glm-5p3-high",
          displayName: "GLM 5.3 <span style=\"color: var(--cursor-text-tertiary);\">High</span>",
          parameterValues: [{ id: "reasoning", value: "high" }],
        },
        {
          legacySlug: "glm-5p3-max",
          displayName: "GLM 5.3 <span>Max</span>",
          parameterValues: [{ id: "reasoning", value: "max" }],
        },
      ],
    },
    {
      name: "glm-5p3-flash",
      clientDisplayName: "GLM 5.3 Flash",
      serverModelName: "glm-5p3-flash",
      supportsAgent: true,
      defaultOn: false,
      legacySlugs: ["glm-5p3-flash", "glm-5p3-flash-high"],
    },
    {
      name: "hidden-model",
      clientDisplayName: "Hidden",
      supportsAgent: false,
      defaultOn: true,
      legacySlugs: ["hidden-model"],
    },
  ],
  aiSettings: {
    modelOverrideEnabled: ["glm-5p3", "glm-5p3-flash", "grok-4.7"],
    modelOverrideDisabled: ["gpt-5.6-sol"],
  },
};

describe("models/ide-catalog", () => {
  it("adds picker-enabled models missing from the CLI list, using Cursor's real ids", () => {
    const merged = mergeIdeEnabledModels(
      [{ id: "glm-5.2-high", name: "GLM 5.2" }, { id: "auto", name: "Auto" }],
      glmCatalog,
    );

    expect(merged.map((model) => model.id)).toEqual([
      "glm-5.2-high",
      "auto",
      "glm-5p3",
      "glm-5p3-low",
      "glm-5p3-high",
      "glm-5p3-max",
      "glm-5p3-flash",
      "glm-5p3-flash-high",
    ]);
    expect(merged.find((model) => model.id === "glm-5p3")?.name).toBe("GLM 5.3");
    expect(merged.find((model) => model.id === "glm-5p3-high")?.name).toBe("GLM 5.3 High");
    expect(merged.find((model) => model.id === "glm-5p3-flash")?.name).toBe("GLM 5.3 Flash");
  });

  it("does not duplicate a family the CLI already lists", () => {
    const merged = mergeIdeEnabledModels(
      [{ id: "glm-5.2-high", name: "GLM 5.2" }],
      {
        availableDefaultModels2: glmCatalog.availableDefaultModels2?.slice(0, 1),
        aiSettings: { modelOverrideEnabled: ["glm-5.2"] },
      },
    );

    expect(merged).toEqual([{ id: "glm-5.2-high", name: "GLM 5.2" }]);
  });

  it("skips models the user turned off and models that cannot run the agent", () => {
    const merged = mergeIdeEnabledModels([], {
      availableDefaultModels2: [
        {
          name: "gpt-5.6-sol",
          clientDisplayName: "GPT-5.6 Sol",
          defaultOn: true,
          supportsAgent: true,
          legacySlugs: ["gpt-5.6-sol-high"],
        },
        {
          name: "hidden-model",
          clientDisplayName: "Hidden",
          defaultOn: true,
          supportsAgent: false,
          legacySlugs: ["hidden-model"],
        },
      ],
      aiSettings: { modelOverrideDisabled: ["gpt-5.6-sol"] },
    });

    expect(merged).toEqual([]);
  });

  it("reads an injected catalog and ignores a missing database", () => {
    expect(readCursorIdeCatalog({
      dbPath: "/missing/state.vscdb",
      existsSync: () => false,
    })).toBeNull();

    const merged = appendIdeEnabledModels(
      [{ id: "auto", name: "Auto" }],
      () => glmCatalog,
    );
    expect(merged.some((model) => model.id === "glm-5p3")).toBe(true);
  });

  it("keeps the CLI list when catalog parsing throws", () => {
    const models = [{ id: "auto", name: "Auto" }];
    expect(appendIdeEnabledModels(models, () => {
      throw new Error("locked");
    })).toEqual(models);
  });

  it("points at the platform Cursor state database", () => {
    expect(cursorStateDbPath("darwin", "/Users/ada")).toBe(
      "/Users/ada/Library/Application Support/Cursor/User/globalStorage/state.vscdb",
    );
    expect(cursorStateDbPath("linux", "/home/ada", {})).toBe(
      "/home/ada/.config/Cursor/User/globalStorage/state.vscdb",
    );
    expect(cursorStateDbPath("win32", "C:\\Users\\ada", { APPDATA: "C:\\Users\\ada\\AppData\\Roaming" })).toBe(
      "C:\\Users\\ada\\AppData\\Roaming\\Cursor\\User\\globalStorage\\state.vscdb",
    );
  });
});
