import { describe, expect, it } from "bun:test";
import {
  buildContextLimitIndex,
  buildModelLimit,
  enrichModelsWithContextLimits,
  maxContextLimitForWireIds,
  parseContextFromDisplayName,
} from "../../../src/models/context-limits.js";

describe("models/context-limits", () => {
  it("builds Kilo-valid limit objects with default output cap", () => {
    expect(buildModelLimit(1_000_000)).toEqual({ context: 1_000_000, output: 65536 });
    expect(buildModelLimit(128_000)).toEqual({ context: 128_000, output: 32000 });
  });

  it("parses M and K hints from display names", () => {
    expect(parseContextFromDisplayName("Claude Opus 5 1M Thinking")).toBe(1_000_000);
    expect(parseContextFromDisplayName("Gemini 3.7 Flash 200K")).toBe(200_000);
    expect(parseContextFromDisplayName("GPT-5.2")).toBeUndefined();
  });

  it("builds wire id index from AvailableModels JSON", () => {
    const limits = buildContextLimitIndex({
      models: [
        {
          name: "claude-opus-5",
          contextTokenLimit: 200000,
          contextTokenLimitForMaxMode: 1000000,
          clientDisplayName: "Claude Opus 5",
          variants: [
            {
              displayName: "Claude Opus 5 1M Max",
              isMaxMode: true,
              parameterValues: [{ id: "effort", value: "max" }],
            },
            {
              displayName: "Claude Opus 5 High",
              parameterValues: [{ id: "effort", value: "high" }],
            },
          ],
        },
      ],
    });

    expect(limits.get("claude-opus-5")).toBe(200000);
    expect(limits.get("claude-opus-5-max")).toBe(1000000);
    expect(limits.get("claude-opus-5-high")).toBe(200000);
  });

  it("enriches discovered models from API index and display-name fallback", () => {
    const limits = new Map([
      ["gpt-5.2", 272000],
    ]);

    const enriched = enrichModelsWithContextLimits([
      { id: "gpt-5.2", name: "GPT-5.2" },
      { id: "claude-opus-5-high", name: "Claude Opus 5 1M" },
    ], limits);

    expect(enriched[0]?.contextLimit).toBe(272000);
    expect(enriched[1]?.contextLimit).toBe(1_000_000);
  });

  it("picks the largest context across grouped wire ids", () => {
    const discoveredById = new Map([
      ["claude-opus-5-high", { id: "claude-opus-5-high", name: "High", contextLimit: 200000 }],
      ["claude-opus-5-max", { id: "claude-opus-5-max", name: "Max", contextLimit: 1000000 }],
    ]);

    expect(
      maxContextLimitForWireIds(["claude-opus-5-high", "claude-opus-5-max"], discoveredById),
    ).toBe(1000000);
  });
});
