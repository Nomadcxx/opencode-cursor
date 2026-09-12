import { describe, it, expect, beforeEach } from "vitest";
import { shouldProcessModel } from "../../../src/plugin.js";

describe("model filter", () => {
  describe("shouldProcessModel", () => {
    it("should return true for cursor-kilo/ models", () => {
      expect(shouldProcessModel("cursor-kilo/claude-sonnet")).toBe(true);
      expect(shouldProcessModel("cursor-kilo/gpt-4")).toBe(true);
      expect(shouldProcessModel("cursor-kilo/o1-mini")).toBe(true);
    });

    it("should return false for non-cursor models", () => {
      expect(shouldProcessModel("openai/gpt-4")).toBe(false);
      expect(shouldProcessModel("anthropic/claude-3")).toBe(false);
      expect(shouldProcessModel("gpt-4")).toBe(false);
      expect(shouldProcessModel("claude-3-opus")).toBe(false);
    });

    it("should return false for undefined or empty model", () => {
      expect(shouldProcessModel(undefined)).toBe(false);
      expect(shouldProcessModel("")).toBe(false);
    });

    it("should return false for partial prefix matches", () => {
      // Must have full "cursor-kilo/" prefix, not just "cursor-kilo"
      expect(shouldProcessModel("cursor-kilo")).toBe(false);
      expect(shouldProcessModel("cursor-kilomodel")).toBe(false);
    });
  });
});
