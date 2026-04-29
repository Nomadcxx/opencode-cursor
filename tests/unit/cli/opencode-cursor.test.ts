// tests/unit/cli/opencode-cursor.test.ts
import { describe, expect, it } from "bun:test";
import {
  getBrandingHeader,
  checkBun,
  checkCursorAgent,
  checkCursorAgentLogin,
  runDoctorChecks,
  getStatusResult,
  explainCursorModels,
  summarizeModelSync,
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
  }, 10000);
});

describe("cli/opencode-cursor status", () => {
  it("getStatusResult returns structured data", () => {
    const result = getStatusResult("/tmp/test-config.json", "/tmp/test-plugin");
    expect(result).toHaveProperty("plugin");
    expect(result).toHaveProperty("provider");
    expect(result).toHaveProperty("aiSdk");
  });
});

describe("cli/opencode-cursor sync summary", () => {
  it("reports added, updated, removed, priced, and skipped entries", () => {
    const before = {
      unchanged: { name: "Unchanged" },
      changed: { name: "Old" },
      removed: { name: "Removed" },
    };
    const after = {
      unchanged: { name: "Unchanged" },
      changed: { name: "New" },
      added: { name: "Added", cost: { input: 1, output: 2 } },
      variants: {
        name: "Variants",
        variants: {
          high: { cursorModel: "variants-high", cost: { input: 1, output: 2 } },
        },
      },
    };

    expect(summarizeModelSync(before, after)).toEqual({
      added: 2,
      updated: 1,
      removed: 1,
      priced: 2,
      skipped: 1,
    });
  });
});

describe("cli/opencode-cursor model explanation", () => {
  it("explains compact model groups and direct models", () => {
    const explanation = explainCursorModels([
      { id: "gpt-5.3-codex", name: "GPT-5.3 Codex" },
      { id: "gpt-5.3-codex-low", name: "GPT-5.3 Codex Low" },
      { id: "gpt-5.3-codex-high", name: "GPT-5.3 Codex High" },
      { id: "auto", name: "Auto" },
    ]);

    expect(explanation.modelCount).toBe(4);
    expect(explanation.groupedCount).toBe(3);
    expect(explanation.direct).toEqual(["auto"]);
    expect(explanation.groups).toEqual([
      {
        id: "gpt-5.3-codex",
        name: "GPT-5.3 Codex",
        defaultCursorModel: "gpt-5.3-codex",
        memberCount: 3,
        variants: {
          low: "gpt-5.3-codex-low",
          high: "gpt-5.3-codex-high",
        },
      },
    ]);
  });
});
