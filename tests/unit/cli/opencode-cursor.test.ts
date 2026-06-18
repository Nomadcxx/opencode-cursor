// tests/unit/cli/opencode-cursor.test.ts
import { describe, expect, it } from "bun:test";
import { closeSync, mkdtempSync, openSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  getBrandingHeader,
  checkBun,
  checkCursorAgent,
  checkCursorAgentLogin,
  runDoctorChecks,
  getStatusResult,
  explainCursorModels,
  summarizeModelSync,
  isCliEntrypoint,
  resolvePaths,
} from "../../../src/cli/opencode-cursor.js";

describe("cli/opencode-cursor entrypoint", () => {
  it("detects invocation through a symlinked bin", () => {
    const dir = mkdtempSync(join(tmpdir(), "open-cursor-bin-"));
    const binPath = join(dir, "open-cursor");
    const realPath = join(dir, "opencode-cursor.js");
    closeSync(openSync(realPath, "w"));
    symlinkSync(realPath, binPath);

    try {
      expect(isCliEntrypoint(pathToFileURL(realPath).href, binPath)).toBe(true);
      expect(isCliEntrypoint(pathToFileURL(binPath).href, binPath)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not treat unrelated argv paths as the cli entrypoint", () => {
    expect(
      isCliEntrypoint(
        pathToFileURL(resolve("dist/cli/opencode-cursor.js")).href,
        resolve("dist/cli/discover.js"),
      ),
    ).toBe(false);
  });
});

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

  it("reports missing cursor-agent as a warning when SDK backend has a real key", () => {
    const originalBackend = process.env.CURSOR_ACP_BACKEND;
    const originalApiKey = process.env.CURSOR_API_KEY;
    const originalCursorAgent = process.env.CURSOR_AGENT_EXECUTABLE;

    process.env.CURSOR_ACP_BACKEND = "sdk";
    process.env.CURSOR_API_KEY = "cursor_123";
    process.env.CURSOR_AGENT_EXECUTABLE = "/definitely/missing/cursor-agent";

    try {
      const results = runDoctorChecks("/tmp/test-config.json", "/tmp/test-plugin");
      const cursorAgent = results.find((result) => result.name === "cursor-agent");
      const sdkAuth = results.find((result) => result.name === "Cursor SDK API key");

      expect(cursorAgent?.passed).toBe(false);
      expect(cursorAgent?.warning).toBe(true);
      expect(sdkAuth?.passed).toBe(true);
    } finally {
      if (originalBackend === undefined) {
        delete process.env.CURSOR_ACP_BACKEND;
      } else {
        process.env.CURSOR_ACP_BACKEND = originalBackend;
      }
      if (originalApiKey === undefined) {
        delete process.env.CURSOR_API_KEY;
      } else {
        process.env.CURSOR_API_KEY = originalApiKey;
      }
      if (originalCursorAgent === undefined) {
        delete process.env.CURSOR_AGENT_EXECUTABLE;
      } else {
        process.env.CURSOR_AGENT_EXECUTABLE = originalCursorAgent;
      }
    }
  });
});

describe("cli/opencode-cursor status", () => {
  it("getStatusResult returns structured data", () => {
    const result = getStatusResult("/tmp/test-config.json", "/tmp/test-plugin");
    expect(result).toHaveProperty("plugin");
    expect(result).toHaveProperty("provider");
    expect(result).toHaveProperty("aiSdk");
  });

  it("reports the resolved default log directory", () => {
    const originalLogDir = process.env.CURSOR_ACP_LOG_DIR;
    delete process.env.CURSOR_ACP_LOG_DIR;

    try {
      const result = getStatusResult("/tmp/test-config.json", "/tmp/test-plugin");

      expect(result.runtime.logging.dir).toBe(join(homedir(), ".opencode-cursor"));
    } finally {
      if (originalLogDir === undefined) {
        delete process.env.CURSOR_ACP_LOG_DIR;
      } else {
        process.env.CURSOR_ACP_LOG_DIR = originalLogDir;
      }
    }
  });

  it("reports runtime settings that affect request performance", () => {
    const originalEnv = {
      CURSOR_ACP_AGENT_POOL: process.env.CURSOR_ACP_AGENT_POOL,
      CURSOR_ACP_AGENT_POOL_IDLE_MS: process.env.CURSOR_ACP_AGENT_POOL_IDLE_MS,
      CURSOR_ACP_SESSION_RESUME: process.env.CURSOR_ACP_SESSION_RESUME,
      CURSOR_ACP_BACKEND: process.env.CURSOR_ACP_BACKEND,
      CURSOR_ACP_LOG_LEVEL: process.env.CURSOR_ACP_LOG_LEVEL,
      CURSOR_ACP_LOG_CONSOLE: process.env.CURSOR_ACP_LOG_CONSOLE,
      CURSOR_ACP_LOG_DIR: process.env.CURSOR_ACP_LOG_DIR,
    };

    process.env.CURSOR_ACP_AGENT_POOL = "1";
    process.env.CURSOR_ACP_AGENT_POOL_IDLE_MS = "0";
    process.env.CURSOR_ACP_SESSION_RESUME = "yes";
    process.env.CURSOR_ACP_BACKEND = "sdk";
    process.env.CURSOR_ACP_LOG_LEVEL = "debug";
    process.env.CURSOR_ACP_LOG_CONSOLE = "1";
    process.env.CURSOR_ACP_LOG_DIR = "/tmp/open-cursor-logs";

    try {
      const result = getStatusResult("/tmp/test-config.json", "/tmp/test-plugin");

      expect(result.runtime).toEqual({
        backend: {
          preference: "sdk",
        },
        agentPool: {
          enabled: true,
          idleMs: 0,
        },
        sessionResume: {
          enabled: true,
        },
        logging: {
          level: "debug",
          console: true,
          dir: "/tmp/open-cursor-logs",
        },
      });
    } finally {
      for (const [key, value] of Object.entries(originalEnv)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });
});

describe("cli/opencode-cursor path resolution", () => {
  it("uses the default config path when no config is provided", () => {
    const originalConfig = process.env.OPENCODE_CONFIG;
    const expectedConfig = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode", "opencode.json");
    delete process.env.OPENCODE_CONFIG;

    try {
      expect(resolvePaths({}).configPath).toBe(resolve(expectedConfig));
    } finally {
      if (originalConfig === undefined) {
        delete process.env.OPENCODE_CONFIG;
      } else {
        process.env.OPENCODE_CONFIG = originalConfig;
      }
    }
  });

  it("uses OPENCODE_CONFIG when --config is not provided", () => {
    const originalConfig = process.env.OPENCODE_CONFIG;
    const customConfig = join(tmpdir(), "cursor-models.json");
    process.env.OPENCODE_CONFIG = customConfig;

    try {
      expect(resolvePaths({}).configPath).toBe(resolve(customConfig));
    } finally {
      if (originalConfig === undefined) {
        delete process.env.OPENCODE_CONFIG;
      } else {
        process.env.OPENCODE_CONFIG = originalConfig;
      }
    }
  });

  it("prefers --config over OPENCODE_CONFIG", () => {
    const originalConfig = process.env.OPENCODE_CONFIG;
    const envConfig = join(tmpdir(), "env-opencode.json");
    const flagConfig = join(tmpdir(), "flag-opencode.json");
    process.env.OPENCODE_CONFIG = envConfig;

    try {
      expect(resolvePaths({ config: flagConfig }).configPath).toBe(resolve(flagConfig));
    } finally {
      if (originalConfig === undefined) {
        delete process.env.OPENCODE_CONFIG;
      } else {
        process.env.OPENCODE_CONFIG = originalConfig;
      }
    }
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
