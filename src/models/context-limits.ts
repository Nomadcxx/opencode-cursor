import type { DiscoveredModel } from "../cli/model-discovery.js";

/** Default max output tokens when Cursor does not expose an output limit. */
export const DEFAULT_MODEL_OUTPUT_LIMIT = 65536;

/** Build a Kilo-valid limit object from a known context window. */
export function buildModelLimit(context: number): { context: number; output: number } {
  return {
    context,
    output: inferDefaultOutputLimit(context),
  };
}

/** Heuristic output cap — keeps small-context models reasonable. */
export function inferDefaultOutputLimit(context: number): number {
  if (context >= 1_000_000) return DEFAULT_MODEL_OUTPUT_LIMIT;
  if (context >= 200_000) return DEFAULT_MODEL_OUTPUT_LIMIT;
  return Math.min(DEFAULT_MODEL_OUTPUT_LIMIT, Math.max(8192, Math.floor(context / 4)));
}

/** Parse context hints like "1M" or "200K" from cursor-agent display names. */
export function parseContextFromDisplayName(name: string): number | undefined {
  const match = name.match(/\b(\d+(?:\.\d+)?)\s*([MmKk])\b/);
  if (!match) return undefined;

  const value = Number(match[1]);
  const unit = match[2]!.toUpperCase();
  if (!Number.isFinite(value) || value <= 0) return undefined;

  if (unit === "M") return Math.round(value * 1_000_000);
  if (unit === "K") return Math.round(value * 1_000);
  return undefined;
}

function readPositiveInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.round(value);
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return Math.round(parsed);
  }
  return undefined;
}

type RawVariant = {
  displayName?: string;
  display_name?: string;
  isMaxMode?: boolean;
  is_max_mode?: boolean;
  parameterValues?: Array<{ id?: string; value?: unknown }>;
  parameter_values?: Array<{ id?: string; value?: unknown }>;
};

type RawModel = {
  name?: string;
  clientDisplayName?: string;
  client_display_name?: string;
  contextTokenLimit?: unknown;
  context_token_limit?: unknown;
  contextTokenLimitForMaxMode?: unknown;
  context_token_limit_for_max_mode?: unknown;
  variants?: RawVariant[];
};

function readModelContextLimit(entry: RawModel, useMaxMode = false): number | undefined {
  const standard = readPositiveInt(entry.contextTokenLimit ?? entry.context_token_limit);
  const maxMode = readPositiveInt(
    entry.contextTokenLimitForMaxMode ?? entry.context_token_limit_for_max_mode,
  );
  if (useMaxMode) return maxMode ?? standard;
  return standard ?? maxMode;
}

function variantUsesMaxMode(variant: RawVariant): boolean {
  return variant.isMaxMode === true || variant.is_max_mode === true;
}

function variantParams(variant: RawVariant): Array<{ id: string; value: string }> {
  const raw = variant.parameterValues ?? variant.parameter_values ?? [];
  return raw
    .map((param) => ({ id: String(param.id ?? ""), value: String(param.value ?? "") }))
    .filter((param) => param.id.length > 0);
}

function flattenWireIds(entry: RawModel): Array<{ id: string; useMaxMode: boolean }> {
  const baseId = entry.name?.trim();
  if (!baseId) return [];

  const out: Array<{ id: string; useMaxMode: boolean }> = [{ id: baseId, useMaxMode: false }];
  const variants = entry.variants ?? [];

  for (const variant of variants) {
    const params = variantParams(variant);
    const effort = params.find((p) => p.id === "effort" || p.id === "reasoning")?.value;
    const isFast = params.find((p) => p.id === "fast")?.value === "true";
    let id = baseId;
    if (effort) id += `-${effort}`;
    if (isFast) id += "-fast";
    out.push({ id, useMaxMode: variantUsesMaxMode(variant) });
  }

  return out;
}

/** Build wire model id → context token limit from AvailableModels JSON. */
export function buildContextLimitIndex(raw: Record<string, unknown>): Map<string, number> {
  const limits = new Map<string, number>();
  const entries = Array.isArray(raw.models) ? raw.models as RawModel[] : [];

  for (const entry of entries) {
    const standardLimit = readModelContextLimit(entry, false);
    const maxModeLimit = readModelContextLimit(entry, true);

    for (const { id, useMaxMode } of flattenWireIds(entry)) {
      const limit = useMaxMode
        ? (maxModeLimit ?? standardLimit)
        : (standardLimit ?? maxModeLimit);
      if (limit !== undefined) {
        limits.set(id, limit);
      }
    }
  }

  return limits;
}

function lookupContextLimit(modelId: string, limits: Map<string, number>): number | undefined {
  const normalized = modelId.replace(/^cursor-/, "");
  return limits.get(modelId)
    ?? limits.get(normalized)
    ?? limits.get(`cursor-${normalized}`);
}

/** Attach contextLimit to discovered models using API index and display-name fallback. */
export function enrichModelsWithContextLimits(
  models: DiscoveredModel[],
  limits: Map<string, number> = new Map(),
): DiscoveredModel[] {
  return models.map((model) => {
    if (model.contextLimit !== undefined) return model;

    const fromApi = lookupContextLimit(model.id, limits);
    const fromName = fromApi ?? parseContextFromDisplayName(model.name);
    if (fromName === undefined) return model;

    return { ...model, contextLimit: fromName };
  });
}

export function maxContextLimitForWireIds(
  wireIds: Iterable<string>,
  discoveredById: Map<string, DiscoveredModel>,
): number | undefined {
  let max: number | undefined;

  for (const wireId of wireIds) {
    const normalized = wireId.replace(/^cursor-/, "");
    const found = discoveredById.get(wireId)
      ?? discoveredById.get(normalized)
      ?? discoveredById.get(`cursor-${normalized}`);
    const ctx = found?.contextLimit;
    if (ctx !== undefined && (max === undefined || ctx > max)) {
      max = ctx;
    }
  }

  return max;
}
