import { describe, expect, it } from "bun:test";
import { migrateLegacyModelKeys } from "../../../src/models/discover-with-auth.js";

describe("discover-with-auth helpers", () => {
  it("migrates legacy cursor/ model keys", () => {
    const models = {
      "cursor/auto": { name: "Auto" },
      "gpt-5.4": { name: "GPT" },
    };
    const migrated = migrateLegacyModelKeys(models);
    expect(migrated).toBe(1);
    expect(models.auto).toEqual({ name: "Auto" });
    expect(models["cursor/auto"]).toBeUndefined();
  });
});
