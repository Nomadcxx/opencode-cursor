import { describe, it, expect, beforeEach } from "vitest";
import { shouldProcessModel } from "../../../src/plugin.js";

describe("model filter", () => {
  describe("shouldProcessModel", () => {
    it("should return true for cursor-acp/ models", () => {
      expect(shouldProcessModel("cursor-acp/claude-sonnet")).toBe(true);
      expect(shouldProcessModel("cursor-acp/gpt-4")).toBe(true);
      expect(shouldProcessModel("cursor-acp/o1-mini")).toBe(true);
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
      // Must have full "cursor-acp/" prefix, not just "cursor-acp"
      expect(shouldProcessModel("cursor-acp")).toBe(false);
      expect(shouldProcessModel("cursor-acpmodel")).toBe(false);
    });
  });
});
