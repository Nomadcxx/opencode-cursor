/// <reference path="../../../node_modules/bun-types/test.d.ts" />

import { describe, it, expect, vi, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import { createLogger, _resetLoggerState } from "../../../src/utils/logger.ts";

const mockWrite = vi.fn().mockReturnValue(true);
const mockEnd = vi.fn();
const mockOn = vi.fn().mockReturnThis();

vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  statSync: vi.fn(),
  renameSync: vi.fn(),
  createWriteStream: vi.fn(() => ({
    write: mockWrite,
    end: mockEnd,
    on: mockOn,
  })),
}));

type MockedFs = {
  existsSync: ReturnType<typeof vi.fn>;
  mkdirSync: ReturnType<typeof vi.fn>;
  statSync: ReturnType<typeof vi.fn>;
  renameSync: ReturnType<typeof vi.fn>;
  createWriteStream: ReturnType<typeof vi.fn>;
};

const mockedFs = fs as unknown as MockedFs;

describe("logger", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    _resetLoggerState();
    process.env = { ...originalEnv };
    delete process.env.CURSOR_KILO_LOG_LEVEL;
    delete process.env.CURSOR_KILO_LOG_SILENT;
    delete process.env.CURSOR_KILO_LOG_CONSOLE;
    mockedFs.statSync.mockReturnValue({ size: 1000 } as fs.Stats);
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("file logging", () => {
    it("creates log directory if missing", () => {
      mockedFs.existsSync.mockReturnValue(false);

      const log = createLogger("test");
      log.info("test message");

      expect(mockedFs.mkdirSync).toHaveBeenCalledWith(
        expect.stringContaining(".opencode-cursor"),
        { recursive: true },
      );
    });

    it("opens a write stream and writes logs (not console)", () => {
      mockedFs.existsSync.mockReturnValue(true);
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const log = createLogger("test");
      log.info("test message");

      expect(mockedFs.createWriteStream).toHaveBeenCalledWith(
        expect.stringContaining("plugin.log"),
        { flags: "a" },
      );
      expect(mockWrite).toHaveBeenCalledWith(
        expect.stringMatching(/\[cursor-kilo:test\] INFO\s+test message/),
      );
      expect(consoleSpy).not.toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it("honors CURSOR_KILO_LOG_DIR for verification and sandboxed runs", () => {
      process.env.CURSOR_KILO_LOG_DIR = "/tmp/kilo-cursor-plugin-logs";
      mockedFs.existsSync.mockReturnValue(false);

      const log = createLogger("test");
      log.info("test message");

      expect(mockedFs.mkdirSync).toHaveBeenCalledWith(
        "/tmp/kilo-cursor-plugin-logs",
        { recursive: true },
      );
      expect(mockedFs.createWriteStream).toHaveBeenCalledWith(
        "/tmp/kilo-cursor-plugin-logs/plugin.log",
        { flags: "a" },
      );
    });

    it("writes to console only when CURSOR_KILO_LOG_CONSOLE=1", () => {
      process.env.CURSOR_KILO_LOG_CONSOLE = "1";
      mockedFs.existsSync.mockReturnValue(true);
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const log = createLogger("test");
      log.info("test message");

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringMatching(/\[cursor-kilo:test\] INFO\s+test message/),
      );
      consoleSpy.mockRestore();
    });

    it("rotates log file when byte counter exceeds 5MB", () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.statSync.mockReturnValue({ size: 6 * 1024 * 1024 } as fs.Stats);

      const log = createLogger("test");
      log.info("test message");

      expect(mockedFs.renameSync).toHaveBeenCalledWith(
        expect.stringContaining("plugin.log"),
        expect.stringContaining("plugin.log.1"),
      );
    });

    it("respects CURSOR_KILO_LOG_SILENT", () => {
      process.env.CURSOR_KILO_LOG_SILENT = "1";
      mockedFs.existsSync.mockReturnValue(true);

      const log = createLogger("test");
      log.info("test message");

      expect(mockWrite).not.toHaveBeenCalled();
    });

    it("does not crash if stream creation fails", () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.createWriteStream.mockImplementationOnce(() => {
        throw new Error("EACCES");
      });

      const log = createLogger("test");

      expect(() => log.info("test message")).not.toThrow();
      expect(() => log.info("test message 2")).not.toThrow();

      expect(mockWrite).not.toHaveBeenCalled();
    });
  });

  describe("isDebugEnabled", () => {
    it("returns false at default log level (info)", () => {
      const log = createLogger("test");
      expect(log.isDebugEnabled()).toBe(false);
    });

    it("returns true when log level is debug", () => {
      process.env.CURSOR_KILO_LOG_LEVEL = "debug";
      _resetLoggerState();
      const log = createLogger("test");
      expect(log.isDebugEnabled()).toBe(true);
    });

    it("returns false when silent", () => {
      process.env.CURSOR_KILO_LOG_LEVEL = "debug";
      process.env.CURSOR_KILO_LOG_SILENT = "1";
      _resetLoggerState();
      const log = createLogger("test");
      expect(log.isDebugEnabled()).toBe(false);
    });
  });
});
