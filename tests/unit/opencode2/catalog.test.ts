import { describe, expect, it } from "bun:test";
import { discoveredModelToInfo } from "../../../src/opencode2/catalog.js";

describe("opencode2/catalog", () => {
  it("publishes the discovered context window instead of a flat 200k", () => {
    expect(
      discoveredModelToInfo({ id: "claude-opus-5-high", name: "Opus 5", contextWindow: 1_000_000 }).limit,
    ).toEqual({ context: 1_000_000, output: 8192 });

    expect(discoveredModelToInfo({ id: "grok-4.7-high", name: "Grok 4.7" }).limit.context).toBe(200_000);
  });
});
