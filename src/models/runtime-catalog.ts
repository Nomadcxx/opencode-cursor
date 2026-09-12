import { existsSync, readFileSync } from "node:fs";
import {
  KILO_PROVIDER_ID,
  parseConfigJson,
  resolveKiloConfigPath,
  resolveProjectKiloConfig,
} from "../kilo/platform.js";
import {
  buildKiloCatalogFromConfigModels,
  KILO_MODEL_PREFIX,
  normalizeConfigModelId,
  resolveWireModelFromRequest,
  type KiloCatalogResult,
} from "./kilo-catalog.js";

export function loadRuntimeModelCatalog(workspaceDirectory: string): KiloCatalogResult | null {
  const candidates = [
    process.env.KILO_CONFIG,
    resolveProjectKiloConfig(workspaceDirectory),
    resolveKiloConfigPath(),
  ].filter((path): path is string => typeof path === "string" && path.length > 0);

  for (const configPath of candidates) {
    if (!existsSync(configPath)) continue;
    try {
      const raw = readFileSync(configPath, "utf8");
      const config = parseConfigJson(raw);
      if (!config || typeof config !== "object") continue;

      const provider = (config as { provider?: Record<string, unknown> }).provider;
      const cursorProvider = provider?.[KILO_PROVIDER_ID];
      if (!cursorProvider || typeof cursorProvider !== "object") continue;

      const models = (cursorProvider as { models?: unknown }).models;
      if (!models || typeof models !== "object") continue;

      return buildKiloCatalogFromConfigModels(models as Record<string, unknown>);
    } catch {
      // Try next config path.
    }
  }

  return null;
}

export function resolveProxyRuntimeModel(
  catalog: KiloCatalogResult | null,
  body: Record<string, unknown>,
): string {
  return resolveWireModelFromRequest(catalog, body.model, body);
}

export type ChatParamsModelRef = {
  providerID?: string;
  modelID?: string;
  variant?: string;
};

/** Merge catalog model + per-message session model (variant lives on message.model in Kilo). */
export function resolveChatParamsModelRef(input: {
  model?: { id?: string; modelID?: string; providerID?: string; variant?: string };
  message?: { model?: { modelID?: string; providerID?: string; variant?: string } };
}): ChatParamsModelRef {
  const catalogModel = input.model ?? {};
  const sessionModel = input.message?.model ?? {};

  const modelID =
    (typeof sessionModel.modelID === "string" && sessionModel.modelID.trim())
    || (typeof catalogModel.id === "string" && catalogModel.id.trim())
    || (typeof catalogModel.modelID === "string" && catalogModel.modelID.trim())
    || "";

  const variant =
    (typeof sessionModel.variant === "string" && sessionModel.variant.trim())
    || (typeof catalogModel.variant === "string" && catalogModel.variant.trim())
    || undefined;

  const providerID =
    (typeof sessionModel.providerID === "string" && sessionModel.providerID)
    || (typeof catalogModel.providerID === "string" && catalogModel.providerID)
    || undefined;

  return { modelID, variant, providerID };
}

export function resolveChatParamsWireModel(
  catalog: KiloCatalogResult | null,
  model: ChatParamsModelRef,
  options: Record<string, unknown>,
): string | undefined {
  if (!catalog) return undefined;

  const modelId = typeof model.modelID === "string" ? model.modelID.trim() : "";
  if (!modelId) return undefined;

  const configKey = normalizeConfigModelId(modelId);

  const body: Record<string, unknown> = {
    model: configKey,
    ...options,
  };

  if (typeof model.variant === "string" && model.variant.length > 0) {
    body.variant = model.variant;
  }

  const resolved = resolveWireModelFromRequest(catalog, configKey, body);
  if (!resolved || resolved === "auto") {
    return resolved === "auto" ? "auto" : undefined;
  }

  const normalized = resolved.replace(/^cursor-kilo\//, "").replace(/^cursor\//, "");
  const family = configKey.replace(/^cursor\//, "");
  if (normalized === family) return undefined;
  return normalized;
}
