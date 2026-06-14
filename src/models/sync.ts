/**
 * Non-blocking model auto-refresh for plugin startup.
 *
 * Discovers currently available models via the SDK runner and merges them
 * into the opencode.json config. Only adds new models — never removes
 * user-configured ones. Safe to call fire-and-forget; all errors are
 * caught and logged silently.
 */
import {
  existsSync as nodeExistsSync,
  readFileSync as nodeReadFileSync,
  writeFileSync as nodeWriteFileSync,
} from "node:fs";
import { listModelsViaRunner } from "../client/sdk-child.js";
import { resolveSdkApiKey } from "../auth.js";
import { resolveOpenCodeConfigPath } from "../plugin-toggle.js";
import { createLogger, type Logger } from "../utils/logger.js";
import { mergeCursorModelEntries } from "./variants.js";

const log = createLogger("model-sync");
const PROVIDER_ID = "cursor-acp";

type AutoRefreshMode = "disabled" | "direct" | "compact";
type ModelConfigEntry = { name: string };
type ProviderConfig = { models?: Record<string, unknown> } & Record<string, unknown>;
type OpenCodeConfig = {
  provider?: Record<string, ProviderConfig | undefined>;
} & Record<string, unknown>;

export type DiscoveredModel = {
  id: string;
  name: string;
};

type AutoRefreshModelsDeps = {
  defer: () => Promise<void>;
  discoverModels: () => Promise<DiscoveredModel[]>;
  env: NodeJS.ProcessEnv;
  existsSync: (path: string) => boolean;
  log: Logger;
  readFileSync: (path: string, encoding: BufferEncoding) => string;
  writeFileSync: (path: string, data: string, encoding: BufferEncoding) => void;
};

const defaultDeps: AutoRefreshModelsDeps = {
  defer: () => Promise.resolve(),
  discoverModels: async () => {
    const apiKey = resolveSdkApiKey({ env: process.env });
    if (!apiKey) {
      throw new Error("CURSOR_API_KEY not set");
    }
    const models = await listModelsViaRunner(apiKey);
    return models.map((m) => ({ id: m.id, name: m.name }));
  },
  env: process.env,
  existsSync: nodeExistsSync,
  log,
  readFileSync: nodeReadFileSync,
  writeFileSync: nodeWriteFileSync,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseConfig(raw: string): OpenCodeConfig | null {
  try {
    const parsed = JSON.parse(raw);
    return isRecord(parsed) ? (parsed as OpenCodeConfig) : null;
  } catch {
    return null;
  }
}

function getProviderConfig(config: OpenCodeConfig): ProviderConfig | null {
  if (!isRecord(config.provider)) {
    return null;
  }

  const provider = config.provider[PROVIDER_ID];
  return isRecord(provider) ? (provider as ProviderConfig) : null;
}

function getExistingModels(provider: ProviderConfig): Record<string, unknown> {
  return isRecord(provider.models) ? { ...provider.models } : {};
}

function readCursorModel(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const cursorModel = value.cursorModel;
  return typeof cursorModel === "string" && cursorModel.trim().length > 0
    ? cursorModel.trim()
    : undefined;
}

function collectRepresentedModelIds(models: Record<string, unknown>): Set<string> {
  const represented = new Set<string>(Object.keys(models));

  for (const entry of Object.values(models)) {
    if (!isRecord(entry)) continue;
    const optionModel = readCursorModel(entry.options);
    if (optionModel) represented.add(optionModel);

    if (!isRecord(entry.variants)) continue;
    for (const variantEntry of Object.values(entry.variants)) {
      const variantModel = readCursorModel(variantEntry);
      if (variantModel) represented.add(variantModel);
    }
  }

  return represented;
}

function yieldForFireAndForget(): Promise<void> {
  return Promise.resolve();
}

function getAutoRefreshMode(env: NodeJS.ProcessEnv): AutoRefreshMode {
  const raw = env.CURSOR_ACP_MODEL_AUTO_REFRESH?.trim().toLowerCase();
  if (raw === "false") return "disabled";
  if (raw === "compact") return "compact";
  return "direct";
}

/**
 * Auto-refresh models at plugin startup.
 *
 * - Reads the current opencode.json config
 * - Queries the SDK runner for available models
 * - Merges discovered models into the provider config
 * - Writes back if new models were added or compacted
 *
 * This function never throws. All failures are logged at debug level
 * and silently ignored so plugin startup is never blocked.
 */
export async function autoRefreshModels(
  deps: Partial<AutoRefreshModelsDeps> = {},
): Promise<void> {
  const resolvedDeps: AutoRefreshModelsDeps = {
    ...defaultDeps,
    defer: yieldForFireAndForget,
    ...deps,
  };

  await resolvedDeps.defer();

  try {
    const refreshMode = getAutoRefreshMode(resolvedDeps.env);
    if (refreshMode === "disabled") {
      resolvedDeps.log.debug("Model auto-refresh disabled by CURSOR_ACP_MODEL_AUTO_REFRESH");
      return;
    }

    const configPath = resolveOpenCodeConfigPath(resolvedDeps.env);
    if (!resolvedDeps.existsSync(configPath)) {
      resolvedDeps.log.debug("Config file not found, skipping model auto-refresh", { configPath });
      return;
    }

    const raw = resolvedDeps.readFileSync(configPath, "utf8");
    const config = parseConfig(raw);
    if (!config) {
      resolvedDeps.log.debug("Config file is not valid JSON, skipping model auto-refresh");
      return;
    }

    const provider = getProviderConfig(config);
    if (!provider) {
      resolvedDeps.log.debug("Provider section not found in config, skipping model auto-refresh");
      return;
    }

    const existingModels = getExistingModels(provider);
    let discovered: DiscoveredModel[];
    try {
      discovered = await resolvedDeps.discoverModels();
    } catch (err) {
      resolvedDeps.log.debug("Model discovery failed, skipping auto-refresh", {
        error: String(err),
      });
      return;
    }

    if (refreshMode === "compact") {
      const representedModelIds = collectRepresentedModelIds(existingModels);
      const missingModels = discovered.filter(model => !representedModelIds.has(model.id));
      const result = mergeCursorModelEntries(existingModels, discovered, {
        variants: true,
        compact: true,
      });

      if (missingModels.length === 0 && result.removedCount === 0) {
        resolvedDeps.log.debug("Model auto-refresh: no new models found", {
          existing: Object.keys(existingModels).length,
          discovered: discovered.length,
        });
        return;
      }

      provider.models = result.models;
      resolvedDeps.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
      resolvedDeps.log.info("Model auto-refresh: synced models", {
        mode: refreshMode,
        synced: result.syncedCount,
        grouped: result.groupedCount,
        removed: result.removedCount,
        total: Object.keys(result.models).length,
      });
      return;
    }

    let addedCount = 0;
    for (const model of discovered) {
      if (Object.prototype.hasOwnProperty.call(existingModels, model.id)) continue;
      existingModels[model.id] = { name: model.name } satisfies ModelConfigEntry;
      addedCount++;
    }

    if (addedCount === 0) {
      resolvedDeps.log.debug("Model auto-refresh: no new models found", {
        existing: Object.keys(existingModels).length,
        discovered: discovered.length,
      });
      return;
    }

    provider.models = existingModels;
    resolvedDeps.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    resolvedDeps.log.info("Model auto-refresh: added new models", {
      added: addedCount,
      total: Object.keys(existingModels).length,
    });
  } catch (err) {
    resolvedDeps.log.debug("Model auto-refresh failed", { error: String(err) });
  }
}
