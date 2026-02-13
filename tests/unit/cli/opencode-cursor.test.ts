// tests/unit/cli/opencode-cursor.test.ts
import { describe, expect, it } from "bun:test";
import {
  getBrandingHeader,
  checkBun,
  checkCursorAgent,
  checkCursorAgentLogin,
  runDoctorChecks,
  getStatusResult,
} from "../../../src/cli/opencode-cursor.js";

describe("cli/opencode-cursor branding", () => {
  it("returns ASCII art header with correct format", () => {
    const header = getBrandingHeader();
    // ASCII art uses block characters, check for structure
    expect(header.length).toBeGreaterThan(50);
    const lines = header.split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(3);
    // Verify it contains ASCII block characters
    expect(header).toMatch(/[▄██▀]/);
  });
});

describe("cli/opencode-cursor doctor checks", () => {
  it("checkBun returns status object", () => {
    const result = checkBun();
    expect(result.name).toBe("bun");
    expect(typeof result.passed).toBe("boolean");
    expect(typeof result.message).toBe("string");
  });

  it("checkCursorAgent returns status object", () => {
    const result = checkCursorAgent();
    expect(result.name).toBe("cursor-agent");
    expect(typeof result.passed).toBe("boolean");
  });

  it("checkCursorAgentLogin returns status object", () => {
    const result = checkCursorAgentLogin();
    expect(result.name).toBe("cursor-agent login");
    expect(typeof result.passed).toBe("boolean");
  });
});

describe("cli/opencode-cursor commandDoctor", () => {
  it("runs all checks and returns results", () => {
    const results = runDoctorChecks("/tmp/test-config.json", "/tmp/test-plugin");
    expect(results.length).toBeGreaterThan(5);
    expect(results.every(r => typeof r.passed === "boolean")).toBe(true);
  });
});

describe("cli/opencode-cursor status", () => {
  it("getStatusResult returns structured data", () => {
    const result = getStatusResult("/tmp/test-config.json", "/tmp/test-plugin");
    expect(result).toHaveProperty("plugin");
    expect(result).toHaveProperty("provider");
    expect(result).toHaveProperty("aiSdk");
  });
});