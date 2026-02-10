import { describe, it, expect, beforeEach, afterEach, afterAll, mock } from "bun:test";
import { existsSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { pollForAuthFile, verifyCursorAuth, getAuthFilePath, getPossibleAuthPaths } from "../../src/auth";

const TEST_TIMEOUT = 10000;
const ORIGINAL_CURSOR_ACP_HOME_DIR = process.env.CURSOR_ACP_HOME_DIR;
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_XDG_CONFIG_HOME = process.env.XDG_CONFIG_HOME;
let testHome = "";

function authPaths() {
  const home = testHome;
  const testAuthDir = join(home, ".config", "cursor");
  const testCliConfigDir = join(home, ".cursor");
  return {
    testAuthDir,
    testCliConfigDir,
    testConfigAuthFile: join(testAuthDir, "auth.json"),
    testConfigCliConfigFile: join(testAuthDir, "cli-config.json"),
    testCursorCliConfigFile: join(testCliConfigDir, "cli-config.json"),
    testCursorAuthFile: join(testCliConfigDir, "auth.json"),
  };
}

describe("Auth Module", () => {
  const cleanupAuthFiles = () => {
    const paths = authPaths();
    const files = [
      paths.testConfigAuthFile,
      paths.testConfigCliConfigFile,
      paths.testCursorCliConfigFile,
      paths.testCursorAuthFile,
    ];
    for (const file of files) {
      rmSync(file, { force: true });
    }
  };

  beforeEach(() => {
    testHome = mkdtempSync(join(tmpdir(), "cursor-auth-test-"));
    process.env.HOME = testHome;
    process.env.XDG_CONFIG_HOME = join(testHome, ".config");
    process.env.CURSOR_ACP_HOME_DIR = testHome;
    cleanupAuthFiles();
  });

  afterEach(() => {
    cleanupAuthFiles();
    if (testHome) {
      rmSync(testHome, { recursive: true, force: true });
      testHome = "";
    }
  });

  afterAll(() => {
    if (ORIGINAL_CURSOR_ACP_HOME_DIR === undefined) {
      delete process.env.CURSOR_ACP_HOME_DIR;
    } else {
      process.env.CURSOR_ACP_HOME_DIR = ORIGINAL_CURSOR_ACP_HOME_DIR;
    }
    if (ORIGINAL_HOME === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = ORIGINAL_HOME;
    }
    if (ORIGINAL_XDG_CONFIG_HOME === undefined) {
      delete process.env.XDG_CONFIG_HOME;
      return;
    }
    process.env.XDG_CONFIG_HOME = ORIGINAL_XDG_CONFIG_HOME;
  });

  describe("getAuthFilePath", () => {
    it("should return correct auth file path", () => {
      const path = getAuthFilePath();
      expect(path).toContain("cursor");
      expect(path).toMatch(/(cli-config|auth)\.json/);
    });
  });

  describe("getPossibleAuthPaths", () => {
    it("should include cli-config.json paths", () => {
      const paths = getPossibleAuthPaths();
      const hasCliConfig = paths.some((path) => path.includes("cli-config.json"));
      expect(hasCliConfig).toBe(true);
    });

    it("should check both auth.json and cli-config.json", () => {
      const paths = getPossibleAuthPaths();
      const hasAuthJson = paths.some((path) => path.includes("auth.json"));
      const hasCliConfig = paths.some((path) => path.includes("cli-config.json"));
      expect(hasAuthJson).toBe(true);
      expect(hasCliConfig).toBe(true);
    });
  });

  describe("verifyCursorAuth", () => {
    it("should return false when auth file does not exist", () => {
      const result = verifyCursorAuth();
      expect(result).toBe(false);
    });

    it("should return true when auth file exists", () => {
      const paths = authPaths();
      if (!existsSync(paths.testAuthDir)) {
        mkdirSync(paths.testAuthDir, { recursive: true });
      }
      writeFileSync(paths.testConfigAuthFile, JSON.stringify({ token: "test" }));
      
      const result = verifyCursorAuth();
      expect(result).toBe(true);
    });

    it("should return true when cli-config.json exists", () => {
      const paths = authPaths();
      if (!existsSync(paths.testCliConfigDir)) {
        mkdirSync(paths.testCliConfigDir, { recursive: true });
      }
      writeFileSync(paths.testCursorCliConfigFile, JSON.stringify({ accessToken: "test" }));

      const result = verifyCursorAuth();
      expect(result).toBe(true);
    });
  });

  describe("pollForAuthFile", () => {
    it("should return true when auth file already exists", async () => {
      const paths = authPaths();
      if (!existsSync(paths.testAuthDir)) {
        mkdirSync(paths.testAuthDir, { recursive: true });
      }
      writeFileSync(paths.testConfigAuthFile, JSON.stringify({ token: "test" }));

      const result = await pollForAuthFile(1000, 100);
      expect(result).toBe(true);
    }, TEST_TIMEOUT);

    it("should return false when auth file never appears", async () => {
      const result = await pollForAuthFile(500, 100);
      expect(result).toBe(false);
    }, TEST_TIMEOUT);

    it("should detect auth file created during polling", async () => {
      const pollPromise = pollForAuthFile(2000, 100);
      
      setTimeout(() => {
        const paths = authPaths();
        if (!existsSync(paths.testAuthDir)) {
          mkdirSync(paths.testAuthDir, { recursive: true });
        }
        writeFileSync(paths.testConfigAuthFile, JSON.stringify({ token: "test" }));
      }, 300);

      const result = await pollPromise;
      expect(result).toBe(true);
    }, TEST_TIMEOUT);

    it("should respect custom timeout", async () => {
      const startTime = Date.now();
      const result = await pollForAuthFile(300, 50);
      const elapsed = Date.now() - startTime;
      
      expect(result).toBe(false);
      expect(elapsed).toBeGreaterThanOrEqual(250);
      expect(elapsed).toBeLessThan(500);
    }, TEST_TIMEOUT);

    it("should respect custom interval", async () => {
      let checkCount = 0;
      const originalExistsSync = existsSync;
      const paths = authPaths();
      
      mock.module("fs", () => ({
        ...require("fs"),
        existsSync: (path: string) => {
          if (path === paths.testConfigAuthFile) {
            checkCount++;
          }
          return originalExistsSync(path);
        }
      }));

      await pollForAuthFile(500, 100);
      
      expect(checkCount).toBeGreaterThanOrEqual(4);
      expect(checkCount).toBeLessThanOrEqual(7);
    }, TEST_TIMEOUT);
  });
});
