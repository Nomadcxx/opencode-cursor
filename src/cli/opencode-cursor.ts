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
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import {
  discoverModelsFromCursorAgent,
  fallbackModels,
} from "./model-discovery.js";

type Command = "install" | "sync-models" | "uninstall" | "status" | "help";

type Options = {
  config?: string;
  pluginDir?: string;
  baseUrl?: string;
  copy?: boolean;
  skipModels?: boolean;
  noBackup?: boolean;
};

const PROVIDER_ID = "cursor-acp";
const DEFAULT_BASE_URL = "http://127.0.0.1:32124/v1";

function printHelp() {
  console.log(`opencode-cursor

Usage:
  opencode-cursor install [--config <path>] [--plugin-dir <path>] [--base-url <url>] [--copy] [--skip-models] [--no-backup]
  opencode-cursor sync-models [--config <path>] [--no-backup]
  opencode-cursor uninstall [--config <path>] [--plugin-dir <path>] [--no-backup]
  opencode-cursor status [--config <path>] [--plugin-dir <path>]
  opencode-cursor help
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
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return { command, options };
}

function normalizeCommand(value: string | undefined): Command {
  switch ((value || "install").toLowerCase()) {
    case "install":
    case "sync-models":
    case "uninstall":
    case "status":
    case "help":
      return value ? (value.toLowerCase() as Command) : "install";
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

function commandStatus(options: Options) {
  const { configPath, pluginPath } = resolvePaths(options);
  const pluginExists = existsSync(pluginPath);
  const pluginType = pluginExists ? (lstatSync(pluginPath).isSymbolicLink() ? "symlink" : "file") : "missing";

  let providerExists = false;
  let pluginEnabled = false;
  if (existsSync(configPath)) {
    const config = readConfig(configPath);
    providerExists = Boolean(config.provider?.[PROVIDER_ID]);
    pluginEnabled = Array.isArray(config.plugin) && config.plugin.includes(PROVIDER_ID);
  }

  console.log(`Plugin file: ${pluginPath} (${pluginType})`);
  console.log(`Provider in config: ${providerExists ? "yes" : "no"}`);
  console.log(`Plugin enabled in config: ${pluginEnabled ? "yes" : "no"}`);
  console.log(`Config path: ${configPath}`);
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
