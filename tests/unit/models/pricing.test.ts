import { describe, expect, it } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  applyCursorModelCost,
  checkCursorPricingCoverage,
  getCursorModelCost,
  isOpenCodeModelCost,
  validateOpenCodeModelCost,
} from "../../../src/models/pricing.js";

describe("models/pricing", () => {
  it("returns official Auto and Composer costs", () => {
    expect(getCursorModelCost("auto")).toEqual({
      input: 1.25,
      output: 6,
      cache_read: 0.25,
      cache_write: 1.25,
    });
    expect(getCursorModelCost("composer-2-fast")).toEqual({
      input: 1.5,
      output: 7.5,
      cache_read: 0.35,
      cache_write: 1.5,
    });
  });

  it("maps Cursor model variants to their official family costs", () => {
    expect(getCursorModelCost("gpt-5.3-codex-high-fast")).toEqual({
      input: 1.75,
      output: 14,
      cache_read: 0.175,
      cache_write: 1.75,
    });
    expect(getCursorModelCost("claude-4.6-opus-max-thinking-fast")).toEqual({
      input: 30,
      output: 150,
      cache_read: 3,
      cache_write: 37.5,
    });
  });

  it("includes long-context pricing when Cursor documents it", () => {
    expect(getCursorModelCost("gpt-5.5-high")).toEqual({
      input: 5,
      output: 30,
      cache_read: 0.5,
      cache_write: 5,
      context_over_200k: {
        input: 10,
        output: 45,
        cache_read: 1,
        cache_write: 10,
      },
    });
    expect(getCursorModelCost("gemini-3.1-pro")?.context_over_200k).toEqual({
      input: 4,
      output: 18,
      cache_read: 0.4,
      cache_write: 4,
    });
  });

  it("preserves existing model entry fields while adding cost", () => {
    expect(applyCursorModelCost("grok-4-20-thinking", {
      name: "Grok 4.20 Thinking",
      options: { cursorModel: "grok-4-20-thinking" },
    })).toEqual({
      name: "Grok 4.20 Thinking",
      options: { cursorModel: "grok-4-20-thinking" },
      cost: {
        input: 2,
        output: 6,
        cache_read: 0.2,
        cache_write: 2,
        context_over_200k: {
          input: 4,
          output: 12,
          cache_read: 0.4,
          cache_write: 4,
        },
      },
    });
  });

  it("prices Cursor's own Grok and Composer 2.5 models", () => {
    expect(getCursorModelCost("composer-2.5")).toEqual({
      input: 0.5,
      output: 2.5,
      cache_read: 0.2,
      cache_write: 0.5,
    });
    expect(getCursorModelCost("grok-4.7-xhigh")).toEqual({
      input: 2,
      output: 6,
      cache_read: 0.5,
      cache_write: 2,
    });
    expect(getCursorModelCost("cursor-grok-4.6-high-fast")?.output).toBe(12);
    expect(getCursorModelCost("cursor-grok-4.5-low-fast")?.output).toBe(18);
  });

  it("keeps point releases apart from their base family", () => {
    expect(getCursorModelCost("claude-opus-5-5-high")?.input).toBe(4);
    expect(getCursorModelCost("claude-opus-5-high")?.input).toBe(5);
    expect(getCursorModelCost("claude-sonnet-5-5-max")?.cache_read).toBe(0.1);
    expect(getCursorModelCost("claude-sonnet-5-thinking-low")?.cache_read).toBe(0.2);
    expect(getCursorModelCost("claude-fable-5-2-high")?.input).toBe(8);
    expect(getCursorModelCost("claude-fable-5-1-max")?.cache_read).toBe(0.25);
    expect(getCursorModelCost("claude-fable-5-thinking-high")?.cache_read).toBe(1);
  });

  it("uses Cursor's published fast-mode rate, else leaves the fast id unpriced", () => {
    expect(getCursorModelCost("claude-opus-4-7-high-fast")?.input).toBe(30);
    expect(getCursorModelCost("claude-opus-4-8-max-fast")?.input).toBe(10);
    expect(getCursorModelCost("claude-opus-5-high-fast")).toBeUndefined();
    expect(getCursorModelCost("gpt-5.6-sol-high-fast")).toBeUndefined();
    expect(getCursorModelCost("gpt-5.6-sol-high")?.input).toBe(4);
  });

  it("drops the long-context surcharge Cursor no longer charges on Claude 4.6 Sonnet", () => {
    expect(getCursorModelCost("claude-4.6-sonnet-medium-thinking")?.context_over_200k).toBeUndefined();
  });

  it("leaves unknown models unchanged", () => {
    expect(applyCursorModelCost("unknown-model", { name: "Unknown" })).toEqual({
      name: "Unknown",
    });
  });

  it("reports pricing coverage for Cursor model ids", () => {
    expect(checkCursorPricingCoverage([
      "auto",
      "gpt-5.3-codex-high",
      "unknown-model",
    ])).toEqual({
      priced: ["auto", "gpt-5.3-codex-high"],
      missing: ["unknown-model"],
    });
  });

  it("covers representative current Cursor model families from the fixture", () => {
    const fixturePath = join(import.meta.dir, "../../fixtures/cursor-pricing-models.txt");
    const modelIds = readFileSync(fixturePath, "utf8")
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean);

    expect(checkCursorPricingCoverage(modelIds)).toEqual({
      priced: modelIds,
      missing: [],
    });
  });

  it("emits OpenCode-compatible cost config for known models", () => {
    const cost = getCursorModelCost("gpt-5.5-high");

    expect(isOpenCodeModelCost(cost)).toBe(true);
    expect(validateOpenCodeModelCost(cost)).toEqual({ valid: true, errors: [] });
  });

  it("reports invalid OpenCode cost config shapes", () => {
    expect(validateOpenCodeModelCost({
      input: 1,
      output: -1,
      context_over_200k: { input: 2 },
    })).toEqual({
      valid: false,
      errors: [
        "cost.output must be a non-negative finite number",
        "cost.context_over_200k.output must be a non-negative finite number",
      ],
    });
  });
});
