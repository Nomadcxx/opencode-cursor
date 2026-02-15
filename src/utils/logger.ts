// src/utils/logger.ts

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_DIR = path.join(os.homedir(), ".opencode-cursor");
const LOG_FILE = path.join(LOG_DIR, "plugin.log");
const MAX_LOG_SIZE = 5 * 1024 * 1024;

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function getConfiguredLevel(): LogLevel {
  const env = process.env.CURSOR_ACP_LOG_LEVEL?.toLowerCase();
  if (env && env in LEVEL_PRIORITY) {
    return env as LogLevel;
  }
  return "info";
}

function isSilent(): boolean {
  return process.env.CURSOR_ACP_LOG_SILENT === "1" ||
         process.env.CURSOR_ACP_LOG_SILENT === "true";
}

function shouldLog(level: LogLevel): boolean {
  if (isSilent()) return false;
  const configured = getConfiguredLevel();
  return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[configured];
}

function formatMessage(level: LogLevel, component: string, message: string, data?: unknown): string {
  const timestamp = new Date().toISOString();
  const prefix = `[cursor-acp:${component}]`;
  const levelTag = level.toUpperCase().padEnd(5);

  let formatted = `${prefix} ${levelTag} ${message}`;

  if (data !== undefined) {
    if (typeof data === "object") {
      formatted += ` ${JSON.stringify(data)}`;
    } else {
      formatted += ` ${data}`;
    }
  }

  return formatted;
}

function isConsoleEnabled(): boolean {
  const consoleEnv = process.env.CURSOR_ACP_LOG_CONSOLE;
  return consoleEnv === "1" || consoleEnv === "true";
}

let logDirEnsured = false;
let logFileError = false;

/** Reset internal state (for testing only) */
export function _resetLoggerState(): void {
  logDirEnsured = false;
  logFileError = false;
}

function ensureLogDir(): void {
  if (logDirEnsured) return;
  try {
    if (!fs.existsSync(LOG_DIR)) {
      fs.mkdirSync(LOG_DIR, { recursive: true });
    }
    logDirEnsured = true;
  } catch {
    logFileError = true;
  }
}

function rotateIfNeeded(): void {
  try {
    const stats = fs.statSync(LOG_FILE);
    if (stats.size >= MAX_LOG_SIZE) {
      const backupFile = LOG_FILE + ".1";
      fs.renameSync(LOG_FILE, backupFile);
    }
  } catch {
  }
}

function writeToFile(message: string): void {
  if (logFileError) return;

  ensureLogDir();
  if (logFileError) return;

  try {
    rotateIfNeeded();
    const timestamp = new Date().toISOString();
    fs.appendFileSync(LOG_FILE, `${timestamp} ${message}\n`);
  } catch {
    if (!logFileError) {
      logFileError = true;
      console.error(`[cursor-acp] Failed to write logs. Using: ${LOG_FILE}`);
    }
  }
}

export interface Logger {
  debug: (message: string, data?: unknown) => void;
  info: (message: string, data?: unknown) => void;
  warn: (message: string, data?: unknown) => void;
  error: (message: string, data?: unknown) => void;
}

export function createLogger(component: string): Logger {
  return {
    debug: (message: string, data?: unknown) => {
      if (!shouldLog("debug")) return;
      const formatted = formatMessage("debug", component, message, data);
      writeToFile(formatted);
      if (isConsoleEnabled()) console.error(formatted);
    },
    info: (message: string, data?: unknown) => {
      if (!shouldLog("info")) return;
      const formatted = formatMessage("info", component, message, data);
      writeToFile(formatted);
      if (isConsoleEnabled()) console.error(formatted);
    },
    warn: (message: string, data?: unknown) => {
      if (!shouldLog("warn")) return;
      const formatted = formatMessage("warn", component, message, data);
      writeToFile(formatted);
      if (isConsoleEnabled()) console.error(formatted);
    },
    error: (message: string, data?: unknown) => {
      if (!shouldLog("error")) return;
      const formatted = formatMessage("error", component, message, data);
      writeToFile(formatted);
      if (isConsoleEnabled()) console.error(formatted);
    },
  };
}
