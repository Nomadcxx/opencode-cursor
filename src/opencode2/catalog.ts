import { CURSOR_PROVIDER_ID } from "../plugin.js";
import { getCursorModelCost, toOpenCode2Costs } from "../models/pricing.js";
import type { DiscoveredModel } from "../models/sync.js";
import type { ConnectionInfo, ModelInfo2, ProviderEditor } from "./types.js";

/**
 * In-memory provider registration for the OpenCode 2.0 plugin — the replacement
 * for writing Cursor models into `opencode.json` (and for the next-era
 * `ctx.catalog` path that stable OpenCode 2.0 removed).
 */

/** Integration id owning Cursor credentials. Matches the provider id. */
export const CURSOR_INTEGRATION_ID = CURSOR_PROVIDER_ID;

/**
 * OpenCode 2.0 AI SDK package for the local openai-compatible proxy.
 *
 * This project does not ship a LanguageModel factory; OpenCode talks HTTP to
 * the plugin-started proxy via `@ai-sdk/openai-compatible`, same npm target the
 * OpenCode 1.x installer writes into `opencode.json`.
 */
export const CURSOR_AISDK_PACKAGE = "aisdk:@ai-sdk/openai-compatible";

const DEFAULT_CONTEXT = 200_000;
const DEFAULT_OUTPUT = 8192;

/** Translate one discovered Cursor model into the 2.0 `Model.Info` shape. */
export function discoveredModelToInfo(model: DiscoveredModel): ModelInfo2 {
  const cost = toOpenCode2Costs(getCursorModelCost(model.id));
  return {
    id: model.id,
    modelID: model.id,
    providerID: CURSOR_PROVIDER_ID,
    name: model.name || model.id,
    capabilities: {
      tools: true,
      input: ["text"],
      output: ["text"],
    },
    limit: {
      context: DEFAULT_CONTEXT,
      output: DEFAULT_OUTPUT,
    },
    variants: [],
    status: "active",
    enabled: true,
    time: { released: 0 },
    cost,
  };
}

export function modelsToInventory(models: readonly DiscoveredModel[]): ModelInfo2[] {
  return models.map(discoveredModelToInfo);
}

/**
 * Publish discovered Cursor models into the live provider inventory.
 *
 * Skip while empty (keeps the last successful inventory through a no-op
 * transform on first register). `baseURL` is the live local proxy — OpenCode
 * routes openai-compatible traffic there via provider settings.
 */
export function applyCursorProviderInventory(
  editor: ProviderEditor,
  models: readonly DiscoveredModel[],
  baseURL: string,
  sourceConnection?: ConnectionInfo,
): void {
  if (models.length === 0 || !baseURL) return;

  editor.add({
    info: {
      id: CURSOR_PROVIDER_ID,
      name: "Cursor",
      activation: "enabled",
      package: CURSOR_AISDK_PACKAGE,
      integrationID: CURSOR_INTEGRATION_ID,
      settings: {
        baseURL,
        // Placeholder only — the proxy resolves the real key from env /
        // integration credentials via setStoredApiKey on each Cursor turn.
        apiKey: "cursor-agent",
      },
    },
    models: modelsToInventory(models),
    ...(sourceConnection ? { sourceConnection } : {}),
  });
}
