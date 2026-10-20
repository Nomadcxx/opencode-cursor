import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import type { DiscoveredModel } from "../cli/model-discovery.js";

/**
 * Cursor Settings → Models can enable agent models that `cursor-agent models`
 * does not list. GLM 5.3 is the reported case: the picker id is `glm-5p3`
 * (the dot is encoded as `p`), and `cursor-agent --model glm-5p3` accepts it
 * even though `cursor-agent models` only prints `glm-5.2-*`.
 *
 * The IDE catalog lives in Cursor's state DB. Reading it fails open: a missing
 * database, a locked file, or an unreadable row leaves the CLI list unchanged.
 */

const APPLICATION_USER_KEY =
  "src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser";

const require = createRequire(import.meta.url);

export type IdeCatalogVariant = {
  legacySlug?: string;
  displayName?: string;
  parameterValues?: Array<{ id?: string; value?: string }>;
};

export type IdeCatalogModel = {
  name?: string;
  clientDisplayName?: string;
  serverModelName?: string;
  supportsAgent?: boolean;
  defaultOn?: boolean;
  legacySlugs?: string[];
  variants?: IdeCatalogVariant[];
};

export type IdeCatalog = {
  availableDefaultModels2?: IdeCatalogModel[];
  aiSettings?: {
    modelOverrideEnabled?: string[];
    modelOverrideDisabled?: string[];
  };
};

function joinFor(platform: NodeJS.Platform, ...parts: string[]): string {
  return (platform === "win32" ? path.win32 : path.posix).join(...parts);
}

export function cursorStateDbPath(
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (platform === "darwin") {
    return joinFor(platform, home, "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb");
  }
  if (platform === "win32") {
    const appData = env.APPDATA || joinFor(platform, home, "AppData", "Roaming");
    return joinFor(platform, appData, "Cursor", "User", "globalStorage", "state.vscdb");
  }
  const configHome = env.XDG_CONFIG_HOME || joinFor(platform, home, ".config");
  return joinFor(platform, configHome, "Cursor", "User", "globalStorage", "state.vscdb");
}

export function stripHtml(value: string): string {
  return value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function titleCase(value: string): string {
  if (!value) return value;
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function displayNameForSlug(model: IdeCatalogModel, slug: string): string {
  const base = stripHtml(model.clientDisplayName || model.name || slug);
  if (slug === model.name || slug === model.serverModelName) return base;

  const variant = model.variants?.find((entry) => entry.legacySlug === slug);
  const fromVariant = variant?.displayName ? stripHtml(variant.displayName) : "";
  if (fromVariant) return fromVariant;

  const reasoning = variant?.parameterValues?.find((parameter) => parameter.id === "reasoning")?.value;
  return reasoning ? `${base} ${titleCase(reasoning)}` : base;
}

function selectableIds(model: IdeCatalogModel): string[] {
  const ids = new Set<string>();
  for (const slug of model.legacySlugs ?? []) {
    if (slug) ids.add(slug);
  }
  for (const variant of model.variants ?? []) {
    if (variant.legacySlug) ids.add(variant.legacySlug);
  }
  if (ids.size === 0 && model.serverModelName) ids.add(model.serverModelName);
  if (ids.size === 0 && model.name) ids.add(model.name);
  return [...ids];
}

function isEnabled(model: IdeCatalogModel, catalog: IdeCatalog): boolean {
  const name = model.name;
  if (!name) return false;
  const disabled = new Set(catalog.aiSettings?.modelOverrideDisabled ?? []);
  if (disabled.has(name)) return false;
  const enabled = new Set(catalog.aiSettings?.modelOverrideEnabled ?? []);
  return enabled.has(name) || model.defaultOn === true;
}

/**
 * Add agent models the user enabled in the Cursor picker when none of their
 * selectable ids are already in the CLI catalog.
 */
export function mergeIdeEnabledModels(
  cliModels: readonly DiscoveredModel[],
  catalog: IdeCatalog | null | undefined,
): DiscoveredModel[] {
  if (!catalog?.availableDefaultModels2?.length) return [...cliModels];

  const seen = new Set(cliModels.map((model) => model.id));
  const extras: DiscoveredModel[] = [];

  for (const model of catalog.availableDefaultModels2) {
    if (model.supportsAgent === false) continue;
    if (!isEnabled(model, catalog)) continue;

    const ids = selectableIds(model);
    if (ids.length === 0) continue;
    if (ids.some((id) => seen.has(id)) || (model.name && seen.has(model.name))) continue;

    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      extras.push({ id, name: displayNameForSlug(model, id) });
    }
  }

  return extras.length === 0 ? [...cliModels] : [...cliModels, ...extras];
}

export function extractIdeCatalog(storage: unknown): IdeCatalog | null {
  if (!storage || typeof storage !== "object") return null;
  const record = storage as Record<string, unknown>;
  const models = record.availableDefaultModels2;
  const settings = record.aiSettings;
  if (!Array.isArray(models) && !settings) return null;

  const aiSettings = settings && typeof settings === "object"
    ? settings as IdeCatalog["aiSettings"]
    : undefined;

  return {
    availableDefaultModels2: Array.isArray(models) ? models as IdeCatalogModel[] : [],
    aiSettings: aiSettings
      ? {
          modelOverrideEnabled: aiSettings.modelOverrideEnabled,
          modelOverrideDisabled: aiSettings.modelOverrideDisabled,
        }
      : undefined,
  };
}

type SqliteDatabase = {
  prepare: (sql: string) => { get: (...params: string[]) => { value?: string } | undefined };
  close: () => void;
};

function readViaNodeSqlite(dbPath: string): string | null {
  try {
    const sqlite = require("node:sqlite") as { DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => SqliteDatabase };
    const db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
    try {
      const row = db.prepare("SELECT value FROM ItemTable WHERE key = ?").get(APPLICATION_USER_KEY);
      return typeof row?.value === "string" ? row.value : null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

function readViaSqliteCli(dbPath: string): string | null {
  const candidates = [
    "sqlite3",
    "/usr/bin/sqlite3",
    "/opt/homebrew/bin/sqlite3",
  ];
  const sql = `SELECT value FROM ItemTable WHERE key = '${APPLICATION_USER_KEY}'`;
  for (const command of candidates) {
    const result = spawnSync(command, [dbPath, sql], {
      encoding: "utf8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.error || result.status !== 0) continue;
    const value = String(result.stdout ?? "").trim();
    if (value.startsWith("{")) return value;
  }
  return null;
}

export type ReadIdeCatalogDeps = {
  dbPath?: string;
  existsSync?: (path: string) => boolean;
  readApplicationUser?: (dbPath: string) => string | null;
};

export function readCursorIdeCatalog(deps: ReadIdeCatalogDeps = {}): IdeCatalog | null {
  const dbPath = deps.dbPath ?? cursorStateDbPath();
  const exists = deps.existsSync ?? existsSync;
  if (!exists(dbPath)) return null;

  const raw = deps.readApplicationUser
    ? deps.readApplicationUser(dbPath)
    : readViaNodeSqlite(dbPath) ?? readViaSqliteCli(dbPath);
  if (!raw) return null;

  try {
    return extractIdeCatalog(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function appendIdeEnabledModels(
  models: readonly DiscoveredModel[],
  readCatalog: () => IdeCatalog | null = readCursorIdeCatalog,
): DiscoveredModel[] {
  try {
    return mergeIdeEnabledModels(models, readCatalog());
  } catch {
    return [...models];
  }
}
