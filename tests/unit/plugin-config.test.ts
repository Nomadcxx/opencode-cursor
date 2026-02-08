import { describe, it, expect } from "vitest";

describe("Plugin Configuration", () => {
  describe("envBool helper", () => {
    function envBool(key: string, defaultValue: boolean): boolean {
      const val = process.env[key];
      if (val === undefined) return defaultValue;
      return val !== "false" && val !== "0";
    }

    it("returns default when env var is undefined", () => {
      delete process.env.TEST_VAR;
      expect(envBool("TEST_VAR", true)).toBe(true);
      expect(envBool("TEST_VAR", false)).toBe(false);
    });

    it("returns false when env var is 'false'", () => {
      process.env.TEST_VAR = "false";
      expect(envBool("TEST_VAR", true)).toBe(false);
    });

    it("returns false when env var is '0'", () => {
      process.env.TEST_VAR = "0";
      expect(envBool("TEST_VAR", true)).toBe(false);
    });

    it("returns true for any other value", () => {
      process.env.TEST_VAR = "true";
      expect(envBool("TEST_VAR", false)).toBe(true);

      process.env.TEST_VAR = "1";
      expect(envBool("TEST_VAR", false)).toBe(true);

      process.env.TEST_VAR = "yes";
      expect(envBool("TEST_VAR", false)).toBe(true);

      process.env.TEST_VAR = "";
      expect(envBool("TEST_VAR", false)).toBe(true);
    });
  });

  describe("FORWARD_TOOL_CALLS default", () => {
    it("should default to true when not set", () => {
      delete process.env.CURSOR_ACP_FORWARD_TOOL_CALLS;
      const enabled = process.env.CURSOR_ACP_FORWARD_TOOL_CALLS !== "false";
      expect(enabled).toBe(true);
    });

    it("should be false when explicitly set to 'false'", () => {
      process.env.CURSOR_ACP_FORWARD_TOOL_CALLS = "false";
      const enabled = process.env.CURSOR_ACP_FORWARD_TOOL_CALLS !== "false";
      expect(enabled).toBe(false);
    });
  });
});
