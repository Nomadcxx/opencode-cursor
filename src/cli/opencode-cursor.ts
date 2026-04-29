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
import { groupCursorModels, mergeCursorModelEntries } from "../models/variants.js";
import type { DiscoveredModel } from "./model-discovery.js";

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
  installMethod: "symlink" | "npm-direct" | "none";
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

type ModelExplanation = {
  modelCount: number;
  groupedCount: number;
  directCount: number;
  groups: Array<{
    id: string;
    name: string;
    defaultCursorModel: string;
    memberCount: number;
    variants: Record<string, string>;
  }>;
  direct: string[];
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
    execFileSync("cursor-agent", ["models"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 3000,
    });
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

function isNpmDirectInstalled(config: unknown): boolean {
  if (!config || typeof config !== "object") return false;
  const plugins = (config as Record<string, unknown>).plugin;
  if (!Array.isArray(plugins)) return false;
  return plugins.some((p) => typeof p === "string" && p.startsWith(NPM_PACKAGE_PREFIX));
}

function checkPluginFile(pluginPath: string, config: unknown): CheckResult {
  try {
    if (!existsSync(pluginPath)) {
      if (isNpmDirectInstalled(config)) {
        return {
          name: "Plugin file",
          passed: true,
          message: "Installed via npm package (no symlink needed)",
        };
      }
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
  let config: unknown;
  try {
    config = readConfig(configPath);
  } catch {
    config = undefined;
  }
  return [
    checkBun(),
    checkCursorAgent(),
    checkCursorAgentLogin(),
    checkOpenCode(),
    checkPluginFile(pluginPath, config),
    checkProviderConfig(configPath),
    checkAiSdk(opencodeDir),
  ];
}

type Command = "install" | "sync-models" | "models" | "uninstall" | "status" | "doctor" | "help";

type Options = {
  config?: string;
  pluginDir?: string;
  baseUrl?: string;
  copy?: boolean;
  skipModels?: boolean;
  noBackup?: boolean;
  variants?: boolean;
  compact?: boolean;
  dryRun?: boolean;
  deep?: boolean;
  explain?: boolean;
  json?: boolean;
};

type SyncSummary = {
  added: number;
  updated: number;
  removed: number;
  priced: number;
  skipped: number;
};

type SyncModelsResult = {
  syncedCount: number;
  groupedCount: number;
  removedCount: number;
  summary: SyncSummary;
};

type SyncModelsJsonResult = SyncModelsResult & {
  configPath: string;
  dryRun: boolean;
  variants: boolean;
  compact: boolean;
};

const PROVIDER_ID = "cursor-acp";
const NPM_PACKAGE_PREFIX = "@rama_nigg/open-cursor";
const DEFAULT_BASE_URL = "http://127.0.0.1:32124/v1";

function printHelp() {
  const binName = basename(process.argv[1] || "open-cursor");
  console.log(getBrandingHeader());
  console.log(`${binName}

Commands:
  install     Configure OpenCode for Cursor (idempotent, safe to re-run)
  sync-models Refresh model list from cursor-agent
  models      Explain discovered Cursor model groups and variants
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
  --variants            Generate compact OpenCode model variants from Cursor models
  --compact             With --variants, remove raw grouped Cursor model entries
  --dry-run             Preview sync/install config changes without writing files
  --deep                Run extra doctor checks for models and variant config
  --explain             Show model grouping explanation (models command)
  --no-backup           Don't create config backup
  --json                Output in JSON format where supported
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
    } else if (arg === "--variants") {
      options.variants = true;
    } else if (arg === "--compact") {
      options.compact = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--deep") {
      options.deep = true;
    } else if (arg === "--explain") {
      options.explain = true;
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
    case "models":
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

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}

function readConfig(configPath: string): any {
  if (!existsSync(configPath)) {
    return { plugin: [], provider: {} };
  }
  let raw: string;
  try {
    raw = readFileSync(configPath, "utf8");
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      return { plugin: [], provider: {} };
    }
    throw error;
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON in config: ${configPath} (${String(error)})`);
  }
}

function writeConfig(configPath: string, config: any, noBackup: boolean, silent = false) {
  mkdirSync(dirname(configPath), { recursive: true });
  if (!noBackup && existsSync(configPath)) {
    const backupPath = `${configPath}.bak.${new Date().toISOString().replace(/[:]/g, "-")}`;
    copyFileSync(configPath, backupPath);
    if (!silent) {
      console.log(`Backup written: ${backupPath}`);
    }
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

function syncModelsIntoProvider(config: any, options: Options): SyncModelsResult {
  if (options.compact && !options.variants) {
    throw new Error("--compact requires --variants");
  }

  const discoveredModels = discoverModelsSafe();
  const provider = config.provider[PROVIDER_ID];
  const existingModels = provider.models && typeof provider.models === "object"
    ? provider.models
    : {};
  const beforeModels = snapshotModels(existingModels);
  const result = mergeCursorModelEntries(existingModels, discoveredModels, {
    variants: options.variants === true,
    compact: options.compact === true,
  });

  provider.models = result.models;
  return {
    syncedCount: result.syncedCount,
    groupedCount: result.groupedCount,
    removedCount: result.removedCount,
    summary: summarizeModelSync(beforeModels, result.models),
  };
}

export function explainCursorModels(models: DiscoveredModel[]): ModelExplanation {
  const grouped = groupCursorModels(models);
  const groupedCount = grouped.groups.reduce((total, group) => total + group.members.length, 0);

  return {
    modelCount: models.length,
    groupedCount,
    directCount: grouped.direct.length,
    groups: grouped.groups.map(group => ({
      id: group.baseId,
      name: group.name,
      defaultCursorModel: group.defaultCursorModelId,
      memberCount: group.members.length,
      variants: group.variants,
    })),
    direct: grouped.direct.map(model => model.id),
  };
}

function createSyncJsonResult(
  result: SyncModelsResult,
  options: Options,
  configPath: string,
): SyncModelsJsonResult {
  return {
    ...result,
    configPath,
    dryRun: options.dryRun === true,
    variants: options.variants === true,
    compact: options.compact === true,
  };
}

function snapshotModels(models: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(models));
}

export function summarizeModelSync(
  beforeModels: Record<string, unknown>,
  afterModels: Record<string, unknown>,
): SyncSummary {
  let added = 0;
  let updated = 0;
  let removed = 0;
  let skipped = 0;

  for (const [modelId, afterEntry] of Object.entries(afterModels)) {
    if (!Object.prototype.hasOwnProperty.call(beforeModels, modelId)) {
      added++;
      continue;
    }

    if (JSON.stringify(beforeModels[modelId]) === JSON.stringify(afterEntry)) {
      skipped++;
    } else {
      updated++;
    }
  }

  for (const modelId of Object.keys(beforeModels)) {
    if (!Object.prototype.hasOwnProperty.call(afterModels, modelId)) {
      removed++;
    }
  }

  return {
    added,
    updated,
    removed,
    priced: countPricedModelEntries(afterModels),
    skipped,
  };
}

function countPricedModelEntries(models: Record<string, unknown>): number {
  let priced = 0;

  for (const entry of Object.values(models)) {
    if (!isRecord(entry)) continue;
    if (isRecord(entry.cost)) priced++;

    if (!isRecord(entry.variants)) continue;
    for (const variantEntry of Object.values(entry.variants)) {
      if (isRecord(variantEntry) && isRecord(variantEntry.cost)) {
        priced++;
      }
    }
  }

  return priced;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

  if (!options.dryRun) {
    mkdirSync(opencodeDir, { recursive: true });
    ensurePluginLink(pluginSource, pluginPath, copyMode);
  }
  const config = readConfig(configPath);
  ensureProvider(config, baseUrl);

  if (!options.skipModels) {
    const result = syncModelsIntoProvider(config, options);
    printSyncResult(result, options);
  }

  if (options.dryRun) {
    console.log("Dry run: no files changed.");
  } else {
    writeConfig(configPath, config, options.noBackup === true);
    installAiSdk(opencodeDir);
  }

  console.log(`${options.dryRun ? "Would install" : "Installed"} ${PROVIDER_ID}`);
  console.log(`Plugin path: ${pluginPath}${copyMode ? " (copy)" : " (symlink)"}`);
  console.log(`Config path: ${configPath}`);
}

function commandSyncModels(options: Options) {
  const { configPath } = resolvePaths(options);
  const config = readConfig(configPath);
  ensureProvider(config, options.baseUrl || DEFAULT_BASE_URL);

  const result = syncModelsIntoProvider(config, options);

  if (!options.dryRun) {
    writeConfig(configPath, config, options.noBackup === true, options.json === true);
  }

  if (options.json) {
    console.log(JSON.stringify(createSyncJsonResult(result, options, configPath), null, 2));
    return;
  }

  printSyncResult(result, options);
  if (options.dryRun) {
    console.log("Dry run: no changes written.");
  }
  console.log(`Config path: ${configPath}`);
}

function commandModels(options: Options) {
  const models = discoverModelsSafe();
  const explanation = explainCursorModels(models);

  if (options.json) {
    console.log(JSON.stringify(explanation, null, 2));
    return;
  }

  console.log(`Cursor models discovered: ${explanation.modelCount}`);
  console.log(`Grouped Cursor models: ${explanation.groupedCount}`);
  console.log(`Direct models: ${explanation.directCount}`);

  if (!options.explain) {
    return;
  }

  console.log("");
  console.log("Model groups:");
  for (const group of explanation.groups) {
    console.log(`  ${group.id}`);
    console.log(`    Default: ${group.defaultCursorModel}`);
    const variants = Object.entries(group.variants);
    if (variants.length === 0) {
      console.log("    Variants: none");
      continue;
    }
    console.log("    Variants:");
    for (const [variant, cursorModel] of variants) {
      console.log(`      ${variant}: ${cursorModel}`);
    }
  }

  console.log("");
  console.log("Direct models:");
  for (const modelId of explanation.direct) {
    console.log(`  ${modelId}`);
  }
}

function printSyncResult(result: SyncModelsResult, options: Options) {
  console.log(`Models synced: ${result.syncedCount}`);
  if (options.variants) {
    console.log(`Grouped Cursor models: ${result.groupedCount}`);
  }
  if (result.removedCount > 0) {
    console.log(`Raw grouped models removed: ${result.removedCount}`);
  }

  console.log("Sync summary:");
  console.log(`  Added: ${result.summary.added}`);
  console.log(`  Updated: ${result.summary.updated}`);
  console.log(`  Removed: ${result.summary.removed}`);
  console.log(`  Priced: ${result.summary.priced}`);
  console.log(`  Skipped: ${result.summary.skipped}`);
}

const NPM_PACKAGE = "@rama_nigg/open-cursor";

function commandUninstall(options: Options) {
  const { configPath, pluginPath } = resolvePaths(options);
  rmSync(pluginPath, { force: true });

  if (existsSync(configPath)) {
    const config = readConfig(configPath);
    if (Array.isArray(config.plugin)) {
      // Remove both cursor-acp (symlink) and @rama_nigg/open-cursor (npm-direct) entries
      config.plugin = config.plugin.filter((name: string) => {
        if (name === PROVIDER_ID) return false;
        if (typeof name === "string" && name.startsWith(NPM_PACKAGE)) return false;
        return true;
      });
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
    try {
      const stat = lstatSync(pluginPath);
      pluginType = stat.isSymbolicLink() ? "symlink" : "file";
      if (pluginType === "symlink") {
        try {
          pluginTarget = readFileSync(pluginPath, "utf8");
        } catch {
          pluginTarget = undefined;
        }
      }
    } catch (error) {
      if (!isErrnoException(error) || error.code !== "ENOENT") {
        throw error;
      }
      pluginType = "missing";
      pluginTarget = undefined;
    }
  }

  // Provider
  let config: any;
  let providerEnabled = false;
  let baseUrl = "http://127.0.0.1:32124/v1";
  let modelCount = 0;
  if (existsSync(configPath)) {
    config = readConfig(configPath);
    const provider = config.provider?.["cursor-acp"];
    providerEnabled = !!provider;
    if (provider?.options?.baseURL) {
      baseUrl = provider.options.baseURL;
    }
    modelCount = Object.keys(provider?.models || {}).length;
  } else {
    config = undefined;
  }

  // AI SDK
  const opencodeDir = dirname(configPath);
  const sdkPath = join(opencodeDir, "node_modules", "@ai-sdk", "openai-compatible");
  const aiSdkInstalled = existsSync(sdkPath);

  let installMethod: "symlink" | "npm-direct" | "none" = "none";
  if (pluginType !== "missing") {
    installMethod = "symlink";
  } else if (isNpmDirectInstalled(config)) {
    installMethod = "npm-direct";
  }

  return {
    installMethod,
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

export function runDeepDoctorChecks(configPath: string): CheckResult[] {
  const checks: CheckResult[] = [];
  let config: any;

  try {
    config = readConfig(configPath);
  } catch (error) {
    return [{
      name: "Deep config read",
      passed: false,
      message: error instanceof Error ? error.message : String(error),
    }];
  }

  const provider = config.provider?.[PROVIDER_ID];
  const models = isRecord(provider?.models) ? provider.models : {};
  const baseUrl = typeof provider?.options?.baseURL === "string" ? provider.options.baseURL : "";

  checks.push({
    name: "Provider base URL",
    passed: baseUrl.startsWith("http://") || baseUrl.startsWith("https://"),
    message: baseUrl || "missing - run: open-cursor install",
  });

  checks.push({
    name: "Provider models",
    passed: Object.keys(models).length > 0,
    message: `${Object.keys(models).length} configured model(s)`,
  });

  const variantEntryCount = countVariantModelEntries(models);
  checks.push({
    name: "Compact variants",
    passed: variantEntryCount > 0,
    warning: variantEntryCount === 0,
    message: variantEntryCount > 0
      ? `${variantEntryCount} model entr${variantEntryCount === 1 ? "y" : "ies"} with variants`
      : "no compact variants found - run: open-cursor sync-models --variants --compact",
  });

  let discoveredModels: DiscoveredModel[];
  try {
    discoveredModels = discoverModelsFromCursorAgent();
    checks.push({
      name: "Cursor model discovery",
      passed: true,
      message: `${discoveredModels.length} model(s) from cursor-agent`,
    });
  } catch (error) {
    checks.push({
      name: "Cursor model discovery",
      passed: false,
      message: error instanceof Error ? error.message : String(error),
      warning: true,
    });
    return checks;
  }

  const knownModelIds = new Set(discoveredModels.map(model => model.id));
  const unknownTargets = collectConfiguredCursorModels(models)
    .filter(modelId => !knownModelIds.has(modelId));
  checks.push({
    name: "Configured Cursor model targets",
    passed: unknownTargets.length === 0,
    warning: unknownTargets.length > 0,
    message: unknownTargets.length === 0
      ? "all configured targets exist in cursor-agent models"
      : `${unknownTargets.length} target(s) not found: ${unknownTargets.slice(0, 5).join(", ")}`,
  });

  return checks;
}

function countVariantModelEntries(models: Record<string, unknown>): number {
  return Object.values(models).filter(entry => {
    return isRecord(entry) && isRecord(entry.variants) && Object.keys(entry.variants).length > 0;
  }).length;
}

function collectConfiguredCursorModels(models: Record<string, unknown>): string[] {
  const targets: string[] = [];

  for (const [modelId, entry] of Object.entries(models)) {
    if (!isRecord(entry)) {
      targets.push(modelId);
      continue;
    }

    const optionTarget = readCursorModel(entry.options);
    targets.push(optionTarget || modelId);

    if (!isRecord(entry.variants)) continue;
    for (const variantEntry of Object.values(entry.variants)) {
      const variantTarget = readCursorModel(variantEntry);
      if (variantTarget) targets.push(variantTarget);
    }
  }

  return [...new Set(targets)];
}

function readCursorModel(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const cursorModel = value.cursorModel;
  return typeof cursorModel === "string" && cursorModel.trim().length > 0
    ? cursorModel.trim()
    : undefined;
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
  console.log(`  Install method: ${result.installMethod}`);

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
  const checks = [
    ...runDoctorChecks(configPath, pluginPath),
    ...(options.deep ? runDeepDoctorChecks(configPath) : []),
  ];

  if (options.json) {
    const failed = checks.filter(c => !c.passed && !c.warning);
    console.log(JSON.stringify({ deep: options.deep === true, checks, failed: failed.length }, null, 2));
    return;
  }

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
      case "models":
        commandModels(parsed.options);
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

if (process.env.NODE_ENV !== "test" && fileURLToPath(import.meta.url) === resolve(process.argv[1] || "")) {
  main();
}
