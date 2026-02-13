#!/usr/bin/env node

import { execFileSync } from "child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { homedir } from "os";
import { basename, dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import {
  discoverModelsFromCursorAgent,
  fallbackModels,
} from "./model-discovery.js";

const BRANDING_HEADER = `
 ▄▄▄  ▄▄▄▄  ▄▄▄▄▄ ▄▄  ▄▄      ▄▄▄  ▄▄ ▄▄ ▄▄▄▄   ▄▄▄▄   ▄▄▄   ▄▄▄▄
██ ██ ██ ██ ██▄▄  ███▄██ ▄▄▄ ██ ▀▀ ██ ██ ██ ██ ██▄▄▄  ██ ██  ██ ██
▀█▄█▀ ██▀▀  ██▄▄▄ ██ ▀██     ▀█▄█▀ ▀█▄█▀ ██▀█▄ ▄▄▄█▀  ▀█▄█▀  ██▀█▄
`;

export function getBrandingHeader(): string {
  return BRANDING_HEADER.trim();
}

type CheckResult = {
  name: string;
  passed: boolean;
  message: string;
  warning?: boolean;
};

type StatusResult = {
  plugin: {
    path: string;
    type: "symlink" | "file" | "missing";
    target?: string;
  };
  provider: {
    configPath: string;
    name: string;
    enabled: boolean;
    baseUrl: string;
    modelCount: number;
  };
  aiSdk: {
    installed: boolean;
  };
};

export function checkBun(): CheckResult {
  try {
    const version = execFileSync("bun", ["--version"], { encoding: "utf8" }).trim();
    return { name: "bun", passed: true, message: `v${version}` };
  } catch {
    return {
      name: "bun",
      passed: false,
      message: "not found - install with: curl -fsSL https://bun.sh/install | bash",
    };
  }
}

export function checkCursorAgent(): CheckResult {
  try {
    const output = execFileSync("cursor-agent", ["--version"], { encoding: "utf8" }).trim();
    const version = output.split("\n")[0] || "installed";
    return { name: "cursor-agent", passed: true, message: version };
  } catch {
    return {
      name: "cursor-agent",
      passed: false,
      message: "not found - install with: curl -fsS https://cursor.com/install | bash",
    };
  }
}

export function checkCursorAgentLogin(): CheckResult {
  try {
    // cursor-agent stores credentials in ~/.cursor-agent or similar
    // Try running a command that requires auth
    execFileSync("cursor-agent", ["models"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { name: "cursor-agent login", passed: true, message: "logged in" };
  } catch {
    return {
      name: "cursor-agent login",
      passed: false,
      message: "not logged in - run: cursor-agent login",
      warning: true,
    };
  }
}

function checkOpenCode(): CheckResult {
  try {
    const version = execFileSync("opencode", ["--version"], { encoding: "utf8" }).trim();
    return { name: "OpenCode", passed: true, message: version };
  } catch {
    return {
      name: "OpenCode",
      passed: false,
      message: "not found - install with: curl -fsSL https://opencode.ai/install | bash",
    };
  }
}

function checkPluginFile(pluginPath: string): CheckResult {
  try {
    if (!existsSync(pluginPath)) {
      return {
        name: "Plugin file",
        passed: false,
        message: "not found - run: open-cursor install",
      };
    }
    const stat = lstatSync(pluginPath);
    if (stat.isSymbolicLink()) {
      const target = readFileSync(pluginPath, "utf8");
      return { name: "Plugin file", passed: true, message: `symlink → ${target}` };
    }
    return { name: "Plugin file", passed: true, message: "file (copy)" };
  } catch {
    return {
      name: "Plugin file",
      passed: false,
      message: "error reading plugin file",
    };
  }
}

function checkProviderConfig(configPath: string): CheckResult {
  try {
    if (!existsSync(configPath)) {
      return {
        name: "Provider config",
        passed: false,
        message: "config not found - run: open-cursor install",
      };
    }
    const config = readConfig(configPath);
    const provider = config.provider?.["cursor-acp"];
    if (!provider) {
      return {
        name: "Provider config",
        passed: false,
        message: "cursor-acp provider missing - run: open-cursor install",
      };
    }
    const modelCount = Object.keys(provider.models || {}).length;
    return { name: "Provider config", passed: true, message: `${modelCount} models` };
  } catch {
    return {
      name: "Provider config",
      passed: false,
      message: "error reading config",
    };
  }
}

function checkAiSdk(opencodeDir: string): CheckResult {
  try {
    const sdkPath = join(opencodeDir, "node_modules", "@ai-sdk", "openai-compatible");
    if (existsSync(sdkPath)) {
      return { name: "AI SDK", passed: true, message: "@ai-sdk/openai-compatible installed" };
    }
    return {
      name: "AI SDK",
      passed: false,
      message: "not installed - run: open-cursor install",
    };
  } catch {
    return {
      name: "AI SDK",
      passed: false,
      message: "error checking AI SDK",
    };
  }
}

export function runDoctorChecks(configPath: string, pluginPath: string): CheckResult[] {
  const opencodeDir = dirname(configPath);
  return [
    checkBun(),
    checkCursorAgent(),
    checkCursorAgentLogin(),
    checkOpenCode(),
    checkPluginFile(pluginPath),
    checkProviderConfig(configPath),
    checkAiSdk(opencodeDir),
  ];
}

type Command = "install" | "sync-models" | "uninstall" | "status" | "doctor" | "help";

type Options = {
  config?: string;
  pluginDir?: string;
  baseUrl?: string;
  copy?: boolean;
  skipModels?: boolean;
  noBackup?: boolean;
  json?: boolean;
};

const PROVIDER_ID = "cursor-acp";
const DEFAULT_BASE_URL = "http://127.0.0.1:32124/v1";

function printHelp() {
  const binName = basename(process.argv[1] || "open-cursor");
  console.log(getBrandingHeader());
  console.log(`${binName}

Commands:
  install     Configure OpenCode for Cursor (idempotent, safe to re-run)
  sync-models Refresh model list from cursor-agent
  status      Show current configuration state
  doctor      Diagnose common issues
  uninstall   Remove cursor-acp from OpenCode config
  help        Show this help message

Options:
  --config <path>       Path to opencode.json (default: ~/.config/opencode/opencode.json)
  --plugin-dir <path>   Path to plugin directory (default: ~/.config/opencode/plugin)
  --base-url <url>      Proxy base URL (default: http://127.0.0.1:32124/v1)
  --copy                Copy plugin instead of symlink
  --skip-models         Skip model sync during install
  --no-backup           Don't create config backup
  --json                Output in JSON format (status command only)
`);
}

function parseArgs(argv: string[]): { command: Command; options: Options } {
  const [commandRaw, ...rest] = argv;
  const command = normalizeCommand(commandRaw);
  const options: Options = {};

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--copy") {
      options.copy = true;
    } else if (arg === "--skip-models") {
      options.skipModels = true;
    } else if (arg === "--no-backup") {
      options.noBackup = true;
    } else if (arg === "--config" && rest[i + 1]) {
      options.config = rest[i + 1];
      i += 1;
    } else if (arg === "--plugin-dir" && rest[i + 1]) {
      options.pluginDir = rest[i + 1];
      i += 1;
    } else if (arg === "--base-url" && rest[i + 1]) {
      options.baseUrl = rest[i + 1];
      i += 1;
    } else if (arg === "--json") {
      options.json = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return { command, options };
}

function normalizeCommand(value: string | undefined): Command {
  switch ((value || "help").toLowerCase()) {
    case "install":
    case "sync-models":
    case "uninstall":
    case "status":
    case "doctor":
    case "help":
      return value ? (value.toLowerCase() as Command) : "help";
    default:
      throw new Error(`Unknown command: ${value}`);
  }
}

function getConfigHome(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg && xdg.length > 0) return xdg;
  return join(homedir(), ".config");
}

function resolvePaths(options: Options) {
  const opencodeDir = join(getConfigHome(), "opencode");
  const configPath = resolve(options.config || join(opencodeDir, "opencode.json"));
  const pluginDir = resolve(options.pluginDir || join(opencodeDir, "plugin"));
  const pluginPath = join(pluginDir, `${PROVIDER_ID}.js`);
  return { opencodeDir, configPath, pluginDir, pluginPath };
}

function resolvePluginSource(): string {
  const currentFile = fileURLToPath(import.meta.url);
  const currentDir = dirname(currentFile);
  const candidates = [
    join(currentDir, "plugin-entry.js"),
    join(currentDir, "..", "plugin-entry.js"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error("Unable to locate plugin-entry.js next to CLI distribution files");
}

function readConfig(configPath: string): any {
  if (!existsSync(configPath)) {
    return { plugin: [], provider: {} };
  }
  const raw = readFileSync(configPath, "utf8");
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON in config: ${configPath} (${String(error)})`);
  }
}

function writeConfig(configPath: string, config: any, noBackup: boolean) {
  mkdirSync(dirname(configPath), { recursive: true });
  if (!noBackup && existsSync(configPath)) {
    const backupPath = `${configPath}.bak.${new Date().toISOString().replace(/[:]/g, "-")}`;
    copyFileSync(configPath, backupPath);
    console.log(`Backup written: ${backupPath}`);
  }
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function ensureProvider(config: any, baseUrl: string) {
  config.plugin = Array.isArray(config.plugin) ? config.plugin : [];
  if (!config.plugin.includes(PROVIDER_ID)) {
    config.plugin.push(PROVIDER_ID);
  }

  config.provider = config.provider && typeof config.provider === "object" ? config.provider : {};
  const current = config.provider[PROVIDER_ID] && typeof config.provider[PROVIDER_ID] === "object"
    ? config.provider[PROVIDER_ID]
    : {};
  const options = current.options && typeof current.options === "object" ? current.options : {};
  const models = current.models && typeof current.models === "object" ? current.models : {};

  config.provider[PROVIDER_ID] = {
    ...current,
    name: "Cursor",
    npm: "@ai-sdk/openai-compatible",
    options: {
      ...options,
      baseURL: baseUrl,
    },
    models,
  };
}

function ensurePluginLink(pluginSource: string, pluginPath: string, copyMode: boolean) {
  mkdirSync(dirname(pluginPath), { recursive: true });
  rmSync(pluginPath, { force: true });
  if (copyMode) {
    copyFileSync(pluginSource, pluginPath);
    return;
  }
  symlinkSync(pluginSource, pluginPath);
}

function discoverModelsSafe() {
  try {
    return discoverModelsFromCursorAgent();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Warning: cursor-agent models failed; using fallback models (${message})`);
    return fallbackModels();
  }
}

function installAiSdk(opencodeDir: string) {
  try {
    execFileSync("bun", ["install", "@ai-sdk/openai-compatible"], {
      cwd: opencodeDir,
      stdio: "inherit",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Warning: failed to install @ai-sdk/openai-compatible via bun (${message})`);
  }
}

function commandInstall(options: Options) {
  const { opencodeDir, configPath, pluginPath } = resolvePaths(options);
  const baseUrl = options.baseUrl || DEFAULT_BASE_URL;
  const copyMode = options.copy === true;
  const pluginSource = resolvePluginSource();

  mkdirSync(opencodeDir, { recursive: true });
  ensurePluginLink(pluginSource, pluginPath, copyMode);
  const config = readConfig(configPath);
  ensureProvider(config, baseUrl);

  if (!options.skipModels) {
    const models = discoverModelsSafe();
    for (const model of models) {
      config.provider[PROVIDER_ID].models[model.id] = { name: model.name };
    }
    console.log(`Models synced: ${models.length}`);
  }

  writeConfig(configPath, config, options.noBackup === true);
  installAiSdk(opencodeDir);

  console.log(`Installed ${PROVIDER_ID}`);
  console.log(`Plugin path: ${pluginPath}${copyMode ? " (copy)" : " (symlink)"}`);
  console.log(`Config path: ${configPath}`);
}

function commandSyncModels(options: Options) {
  const { configPath } = resolvePaths(options);
  const config = readConfig(configPath);
  ensureProvider(config, options.baseUrl || DEFAULT_BASE_URL);

  const models = discoverModelsSafe();
  for (const model of models) {
    config.provider[PROVIDER_ID].models[model.id] = { name: model.name };
  }

  writeConfig(configPath, config, options.noBackup === true);
  console.log(`Models synced: ${models.length}`);
  console.log(`Config path: ${configPath}`);
}

function commandUninstall(options: Options) {
  const { configPath, pluginPath } = resolvePaths(options);
  rmSync(pluginPath, { force: true });

  if (existsSync(configPath)) {
    const config = readConfig(configPath);
    if (Array.isArray(config.plugin)) {
      config.plugin = config.plugin.filter((name: string) => name !== PROVIDER_ID);
    }
    if (config.provider && typeof config.provider === "object") {
      delete config.provider[PROVIDER_ID];
    }
    writeConfig(configPath, config, options.noBackup === true);
  }

  console.log(`Removed plugin link: ${pluginPath}`);
  console.log(`Removed provider "${PROVIDER_ID}" from ${configPath}`);
}

export function getStatusResult(configPath: string, pluginPath: string): StatusResult {
  // Plugin
  let pluginType: "symlink" | "file" | "missing" = "missing";
  let pluginTarget: string | undefined;
  if (existsSync(pluginPath)) {
    const stat = lstatSync(pluginPath);
    pluginType = stat.isSymbolicLink() ? "symlink" : "file";
    if (pluginType === "symlink") {
      try {
        pluginTarget = readFileSync(pluginPath, "utf8");
      } catch {
        pluginTarget = undefined;
      }
    }
  }

  // Provider
  let providerEnabled = false;
  let baseUrl = "http://127.0.0.1:32124/v1";
  let modelCount = 0;
  if (existsSync(configPath)) {
    const config = readConfig(configPath);
    const provider = config.provider?.["cursor-acp"];
    providerEnabled = !!provider;
    if (provider?.options?.baseURL) {
      baseUrl = provider.options.baseURL;
    }
    modelCount = Object.keys(provider?.models || {}).length;
  }

  // AI SDK
  const opencodeDir = dirname(configPath);
  const sdkPath = join(opencodeDir, "node_modules", "@ai-sdk", "openai-compatible");
  const aiSdkInstalled = existsSync(sdkPath);

  return {
    plugin: {
      path: pluginPath,
      type: pluginType,
      target: pluginTarget,
    },
    provider: {
      configPath,
      name: "cursor-acp",
      enabled: providerEnabled,
      baseUrl,
      modelCount,
    },
    aiSdk: {
      installed: aiSdkInstalled,
    },
  };
}

function commandStatus(options: Options) {
  const { configPath, pluginPath } = resolvePaths(options);
  const result = getStatusResult(configPath, pluginPath);

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log("");
  console.log("Plugin");
  console.log(`  Path: ${result.plugin.path}`);
  if (result.plugin.type === "symlink" && result.plugin.target) {
    console.log(`  Type: symlink → ${result.plugin.target}`);
  } else if (result.plugin.type === "file") {
    console.log(`  Type: file (copy)`);
  } else {
    console.log(`  Type: missing`);
  }

  console.log("");
  console.log("Provider");
  console.log(`  Config: ${result.provider.configPath}`);
  console.log(`  Name: ${result.provider.name}`);
  console.log(`  Enabled: ${result.provider.enabled ? "yes" : "no"}`);
  console.log(`  Base URL: ${result.provider.baseUrl}`);
  console.log(`  Models: ${result.provider.modelCount}`);

  console.log("");
  console.log("AI SDK");
  console.log(`  @ai-sdk/openai-compatible: ${result.aiSdk.installed ? "installed" : "not installed"}`);
}

function commandDoctor(options: Options) {
  const { configPath, pluginPath } = resolvePaths(options);
  const checks = runDoctorChecks(configPath, pluginPath);

  console.log("");
  for (const check of checks) {
    const symbol = check.passed ? "\u2713" : (check.warning ? "\u26A0" : "\u2717");
    const color = check.passed ? "\x1b[32m" : (check.warning ? "\x1b[33m" : "\x1b[31m");
    console.log(` ${color}${symbol}\x1b[0m ${check.name}: ${check.message}`);
  }

  const failed = checks.filter(c => !c.passed && !c.warning);
  console.log("");
  if (failed.length === 0) {
    console.log("All checks passed!");
  } else {
    console.log(`${failed.length} check(s) failed. See messages above.`);
  }
}

function main() {
  let parsed: { command: Command; options: Options };
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    printHelp();
    process.exit(1);
    return;
  }

  try {
    switch (parsed.command) {
      case "install":
        commandInstall(parsed.options);
        return;
      case "sync-models":
        commandSyncModels(parsed.options);
        return;
      case "uninstall":
        commandUninstall(parsed.options);
        return;
      case "status":
        commandStatus(parsed.options);
        return;
      case "doctor":
        commandDoctor(parsed.options);
        return;
      case "help":
        printHelp();
        return;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    process.exit(1);
  }
}

main();
