/// <reference path="../../../node_modules/bun-types/test.d.ts" />

import { describe, it, expect, vi, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import { createLogger, _resetLoggerState } from "../../../src/utils/logger.ts";

vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  appendFileSync: vi.fn(),
  statSync: vi.fn(),
  renameSync: vi.fn(),
}));

type MockedFs = {
  existsSync: ReturnType<typeof vi.fn>;
  mkdirSync: ReturnType<typeof vi.fn>;
  appendFileSync: ReturnType<typeof vi.fn>;
  statSync: ReturnType<typeof vi.fn>;
  renameSync: ReturnType<typeof vi.fn>;
};

const mockedFs = fs as unknown as MockedFs;

describe("logger", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    _resetLoggerState(); // Reset module-level state before each test
    process.env = { ...originalEnv };
    delete process.env.CURSOR_ACP_LOG_LEVEL;
    delete process.env.CURSOR_ACP_LOG_SILENT;
    delete process.env.CURSOR_ACP_LOG_CONSOLE;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("file logging", () => {
    it("creates log directory if missing", () => {
      mockedFs.existsSync.mockReturnValue(false);
      mockedFs.statSync.mockReturnValue({ size: 1000 } as fs.Stats);

      const log = createLogger("test");
      log.info("test message");

      expect(mockedFs.mkdirSync).toHaveBeenCalledWith(
        expect.stringContaining(".opencode-cursor"),
        { recursive: true },
      );
    });

    it("writes logs to file by default (not console)", () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.statSync.mockReturnValue({ size: 1000 } as fs.Stats);
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const log = createLogger("test");
      log.info("test message");

      expect(mockedFs.appendFileSync).toHaveBeenCalledWith(
        expect.stringContaining("plugin.log"),
        expect.stringMatching(/\[cursor-acp:test\] INFO\s+test message/),
      );
      expect(consoleSpy).not.toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it("writes to console only when CURSOR_ACP_LOG_CONSOLE=1", () => {
      process.env.CURSOR_ACP_LOG_CONSOLE = "1";
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.statSync.mockReturnValue({ size: 1000 } as fs.Stats);
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const log = createLogger("test");
      log.info("test message");

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringMatching(/\[cursor-acp:test\] INFO\s+test message/),
      );
      consoleSpy.mockRestore();
    });

    it("rotates log file when exceeds 5MB", () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.statSync.mockReturnValue({ size: 6 * 1024 * 1024 } as fs.Stats);

      const log = createLogger("test");
      log.info("test message");

      expect(mockedFs.renameSync).toHaveBeenCalledWith(
        expect.stringContaining("plugin.log"),
        expect.stringContaining("plugin.log.1"),
      );
    });

    it("respects CURSOR_ACP_LOG_SILENT", () => {
      process.env.CURSOR_ACP_LOG_SILENT = "1";
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.statSync.mockReturnValue({ size: 1000 } as fs.Stats);

      const log = createLogger("test");
      log.info("test message");

      expect(mockedFs.appendFileSync).not.toHaveBeenCalled();
    });

    it("does not crash and falls back to silent if file write fails", () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.statSync.mockReturnValue({ size: 1000 } as fs.Stats);
      mockedFs.appendFileSync.mockImplementationOnce(() => {
        throw new Error("EACCES");
      });
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const log = createLogger("test");

      expect(() => log.info("test message")).not.toThrow();
      expect(() => log.info("test message 2")).not.toThrow();

      // First call throws, second call is skipped due to logFileError flag
      expect(mockedFs.appendFileSync).toHaveBeenCalledTimes(1);
      consoleSpy.mockRestore();
    });
  });
});
