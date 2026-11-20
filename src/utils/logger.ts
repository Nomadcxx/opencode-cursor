// src/utils/logger.ts

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

type LogLevel = "debug" | "info" | "warn" | "error";

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

const REDACTED = "[REDACTED]";

// Bearer credentials first, so a key-value match below cannot leave the token behind.
const SECRET_KEYS = "authorization|x-open-cursor-token|api[_-]?key|api[_-]?token|access[_-]?token|refresh[_-]?token|client[_-]?secret|cursor_api_key|token|password|secret";

// Credentials with a scheme first, so a key-value match below cannot leave the
// credential behind. Keys need a boundary on the left, so "hasApiKey" or
// "maxTokens" stay readable.
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/=-]+/gi, `$1 ${REDACTED}`],
  [new RegExp(`((?<![A-Za-z0-9_])["']?(?:${SECRET_KEYS})["']?\\s*[:=]\\s*["']?)[^"'\\s,}&]+`, "gi"), `$1${REDACTED}`],
  [new RegExp(`(--(?:${SECRET_KEYS})[=\\s]+)[^\\s"']+`, "gi"), `$1${REDACTED}`],
  [/([?&](?:key|token|api_key|apikey|access_token)=)[^&\s"']+/gi, `$1${REDACTED}`],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g, REDACTED],
  [/\b(?:key|crsr)_[A-Za-z0-9]{20,}|\bsk-[A-Za-z0-9_-]{20,}/g, REDACTED],
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

function formatMessage(level: LogLevel, component: string, message: string, data?: unknown): string {
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

  return redactSecrets(formatted);
}

function isConsoleEnabled(): boolean {
  const consoleEnv = process.env.CURSOR_ACP_LOG_CONSOLE;
  return consoleEnv === "1" || consoleEnv === "true";
}

let logDirEnsured = false;
let logFileError = false;
let logStream: fs.WriteStream | null = null;
let logBytesWritten = 0;

function getLogDir(): string {
  const override = process.env.CURSOR_ACP_LOG_DIR?.trim();
  return override || path.join(os.homedir(), ".opencode-cursor");
}

function getLogFile(): string {
  return path.join(getLogDir(), "plugin.log");
}

/** Reset internal state (for testing only) */
export function _resetLoggerState(): void {
  logDirEnsured = false;
  logFileError = false;
  if (logStream) {
    logStream.end();
    logStream = null;
  }
  logBytesWritten = 0;
}

function ensureLogDir(): void {
  if (logDirEnsured) return;
  try {
    const logDir = getLogDir();
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
    }
    logDirEnsured = true;
  } catch {
    logFileError = true;
  }
}

function openLogStream(): void {
  if (logStream || logFileError) return;
  ensureLogDir();
  if (logFileError) return;

  try {
    // Seed byte counter from existing file size
    try {
      logBytesWritten = fs.statSync(getLogFile()).size;
    } catch {
      logBytesWritten = 0;
    }
    // Prompts and child stderr land here; keep the file owner-only, including
    // a file an earlier version created with the default umask.
    logStream = fs.createWriteStream(getLogFile(), { flags: "a", mode: 0o600 });
    for (const file of [getLogFile(), getLogFile() + ".1"]) {
      try {
        fs.chmodSync(file, 0o600);
      } catch {
        // Not yet created or not supported; the open mode applies on creation.
      }
    }
    logStream.on("error", () => {
      if (!logFileError) {
        logFileError = true;
        console.error(`[cursor-acp] Failed to write logs. Using: ${getLogFile()}`);
      }
      logStream = null;
    });
  } catch {
    logFileError = true;
  }
}

function rotateIfNeeded(): void {
  if (logBytesWritten < MAX_LOG_SIZE) return;
  try {
    if (logStream) {
      logStream.end();
      logStream = null;
    }
    const logFile = getLogFile();
    fs.renameSync(logFile, logFile + ".1");
    logBytesWritten = 0;
    openLogStream();
  } catch {
    if (!logFileError && !logStream) {
      openLogStream();
    }
  }
}

function writeToFile(message: string): void {
  if (logFileError) return;

  if (!logStream) openLogStream();
  if (logFileError || !logStream) return;

  rotateIfNeeded();
  if (logFileError || !logStream) return;

  const timestamp = new Date().toISOString();
  const line = `${timestamp} ${message}\n`;
  logStream.write(line);
  logBytesWritten += Buffer.byteLength(line);
}

export interface Logger {
  debug: (message: string, data?: unknown) => void;
  info: (message: string, data?: unknown) => void;
  warn: (message: string, data?: unknown) => void;
  error: (message: string, data?: unknown) => void;
  isDebugEnabled: () => boolean;
}

export function createLogger(component: string): Logger {
  return {
    isDebugEnabled: () => shouldLog("debug"),
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
