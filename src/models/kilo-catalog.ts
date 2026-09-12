/**
 * Build Kilo-native model catalog entries from flat cursor-agent model IDs.
 *
 * Output format matches Kilo provider config (see kilo.jsonc example):
 *   "cursor/gpt-5.6-luna": {
 *     "name": "GPT-5.6 Luna",
 *     "reasoning": true,
 *     "variants": { "low": { "reasoning": { "effort": "low" } }, ... },
 *     "options": { "cursorModel": "gpt-5.6-luna-medium" }  // wire id for default
 *   }
 */
import { getCursorModelCost, type OpenCodeModelCost } from "./pricing.js";
import type { DiscoveredCursorModel } from "../cli/model-discovery.js";
import { maxContextLimitForWireIds, buildModelLimit } from "./context-limits.js";

export const KILO_MODEL_PREFIX = "";

const EFFORT_VARIANTS = new Set([
  "none", "low", "medium", "high", "max", "xhigh",
  "low-fast", "medium-fast", "high-fast", "xhigh-fast",
  "extra-high", "fast",
]);

type ParsedModel = {
  wireId: string;
  displayName: string;
  family: string;
  thinking: boolean;
  variant: string | null;
};

export type KiloModelEntry = {
  name: string;
  tool_call?: boolean;
  reasoning?: boolean;
  temperature?: boolean;
  modalities?: { input: string[]; output: string[] };
  limit?: { context: number; output: number };
  cost?: OpenCodeModelCost;
  variants?: Record<string, { reasoning?: { effort: string }; options?: { cursorModel: string } }>;
  options?: { cursorModel: string };
};

export type KiloCatalogResult = {
  models: Record<string, KiloModelEntry>;
  wireIdByConfigKey: Map<string, string>;
  /** configKey + variant → wire model id */
  resolveWireModel: (configModelId: string, variantKey?: string) => string | undefined;
};

function formatDisplayName(family: string, thinking: boolean, fastTier = false): string {
  const base = family
    .split("-")
    .map((p) => {
      if (p === "gpt") return "GPT";
      if (p === "xhigh") return "XHigh";
      return p.charAt(0).toUpperCase() + p.slice(1);
    })
    .join(" ");
  const withThinking = thinking ? `${base} (Thinking)` : base;
  return fastTier ? `${withThinking} Fast` : withThinking;
}

function isFastVariant(variant: string | null): boolean {
  if (variant === null) return false;
  return variant === "fast" || variant.endsWith("-fast");
}

/** Map fast-tier wire variants to standard effort keys (high-fast → high). */
function normalizeVariantForTier(variant: string | null, fastTier: boolean): string | null {
  if (variant === null) return null;
  if (!fastTier) return variant;
  if (variant === "fast") return null;
  if (variant.endsWith("-fast")) return variant.slice(0, -"-fast".length);
  return variant;
}

function configKey(family: string, thinking: boolean, fastTier = false): string {
  let slug = thinking ? `${family}-thinking` : family;
  if (fastTier) slug = `${slug}-fast`;
  return slug;
}

/** Cursor-branded Grok models keep the `cursor-` prefix in cursor-agent wire IDs. */
export function normalizeCursorAgentWireId(wireId: string): string {
  if (wireId.startsWith("cursor-")) return wireId;
  if (/^grok-\d/.test(wireId)) return `cursor-${wireId}`;
  return wireId;
}

function parseModel(model: DiscoveredCursorModel): ParsedModel | null {
  const wireId = model.id;
  let id = model.id.replace(/^cursor-/, "");

  // thinking-* variants: claude-fable-5-thinking-high
  const thinkingMatch = id.match(/^(.+)-thinking-([a-z0-9-]+)$/i);
  if (thinkingMatch) {
    const variant = thinkingMatch[2]!;
    if (EFFORT_VARIANTS.has(variant) || variant.includes("fast")) {
      return {
        wireId,
        displayName: model.name,
        family: thinkingMatch[1]!,
        thinking: true,
        variant,
      };
    }
  }

  // *-thinking suffix without effort: model-thinking
  if (id.endsWith("-thinking")) {
    return {
      wireId,
      displayName: model.name,
      family: id.slice(0, -"-thinking".length),
      thinking: true,
      variant: null,
    };
  }

  // effort suffix: model-high, model-low-fast
  for (const effort of [...EFFORT_VARIANTS].sort((a, b) => b.length - a.length)) {
    if (id === effort) continue;
    const suffix = `-${effort}`;
    if (id.endsWith(suffix)) {
      return {
        wireId,
        displayName: model.name,
        family: id.slice(0, -suffix.length),
        thinking: false,
        variant: effort,
      };
    }
  }

  // bare model id
  if (id.length > 0) {
    return {
      wireId,
      displayName: model.name,
      family: id,
      thinking: false,
      variant: null,
    };
  }
  return null;
}

function inferCapabilities(family: string, thinking: boolean): Partial<KiloModelEntry> {
  const entry: Partial<KiloModelEntry> = {
    tool_call: true,
    temperature: true,
  };
  if (thinking || family.includes("thinking") || /gpt|claude|grok|kimi|glm|composer/.test(family)) {
    entry.reasoning = thinking || undefined;
  }
  if (/gpt|claude|grok|composer|glm/.test(family)) {
    entry.modalities = { input: ["text", "image"], output: ["text"] };
  } else {
    entry.modalities = { input: ["text"], output: ["text"] };
  }
  return entry;
}

export function buildKiloModelCatalog(discovered: DiscoveredCursorModel[]): KiloCatalogResult {
  const groups = new Map<string, { thinking: boolean; fastTier: boolean; members: ParsedModel[] }>();
  const discoveredById = new Map(discovered.map((model) => [model.id, model]));

  for (const model of discovered) {
    if (model.id === "auto") {
      continue; // handled separately
    }
    const parsed = parseModel(model);
    if (!parsed) continue;
    const fastTier = isFastVariant(parsed.variant);
    const key = `${parsed.family}\0${parsed.thinking}\0${fastTier ? "fast" : "standard"}`;
    const group = groups.get(key) ?? { thinking: parsed.thinking, fastTier, members: [] };
    group.members.push(parsed);
    groups.set(key, group);
  }

  const models: Record<string, KiloModelEntry> = {};
  const wireResolver = new Map<string, string>();

  const registerWire = (configKey: string, variant: string | null, wireId: string) => {
    wireResolver.set(variant ? `${configKey}\0${variant}` : `${configKey}\0`, wireId);
  };

  for (const [, group] of groups) {
    if (group.members.length === 0) continue;
    const family = group.members[0]!.family;
    const ck = configKey(family, group.thinking, group.fastTier);

    const normalizedMembers = group.members.map((member) => ({
      ...member,
      variant: normalizeVariantForTier(member.variant, group.fastTier),
    }));

    const variantMembers = normalizedMembers.filter((m) => m.variant !== null);
    const defaultMember =
      normalizedMembers.find((m) => m.variant === null)
      ?? normalizedMembers.find((m) => m.variant === "medium")
      ?? normalizedMembers[0]!;

    const entry: KiloModelEntry = {
      name: formatDisplayName(family, group.thinking, group.fastTier),
      ...inferCapabilities(family, group.thinking),
    };
    if (group.thinking || variantMembers.length > 0) {
      entry.reasoning = true;
    }

    const defaultCost = getCursorModelCost(defaultMember.wireId);
    if (defaultCost) entry.cost = defaultCost;

    const contextLimit = maxContextLimitForWireIds(
      group.members.map((member) => member.wireId),
      discoveredById,
    );
    if (contextLimit !== undefined) {
      entry.limit = buildModelLimit(contextLimit);
    }

    entry.options = { cursorModel: defaultMember.wireId };
    registerWire(ck, null, defaultMember.wireId);

    if (variantMembers.length > 0) {
      entry.variants = {};
      for (const member of variantMembers) {
        const variantKey = member.variant!;
        entry.variants[variantKey] = {
          reasoning: { effort: variantKey },
          options: { cursorModel: member.wireId },
        };
        registerWire(ck, variantKey, member.wireId);
        const variantCost = getCursorModelCost(member.wireId);
        if (variantCost && entry.variants[variantKey]) {
          (entry.variants[variantKey] as { cost?: OpenCodeModelCost }).cost = variantCost;
        }
      }
    }

    models[ck] = entry;
  }

  // auto
  const autoModel = discovered.find((m) => m.id === "auto");
  if (autoModel) {
    models[`${KILO_MODEL_PREFIX}auto`] = {
      name: "Auto (Cursor routing)",
      options: { cursorModel: "auto" },
    };
    registerWire(`${KILO_MODEL_PREFIX}auto`, null, "auto");
  }

  const resolveWireModel = (configModelId: string, variantKey?: string): string | undefined => {
    const direct = wireResolver.get(`${configModelId}\0${variantKey ?? ""}`);
    if (direct) return direct;
    const entry = models[configModelId];
    if (!entry) return undefined;
    if (variantKey && entry.variants?.[variantKey]?.options?.cursorModel) {
      return entry.variants[variantKey].options!.cursorModel;
    }
    return entry.options?.cursorModel;
  };

  return {
    models,
    wireIdByConfigKey: wireResolver,
    resolveWireModel,
  };
}

/** Build a runtime resolver from synced provider.models config entries. */
export function buildKiloCatalogFromConfigModels(
  models: Record<string, unknown>,
): KiloCatalogResult {
  const catalogModels: Record<string, KiloModelEntry> = {};
  const wireResolver = new Map<string, string>();

  const registerWire = (configKey: string, variant: string | null, wireId: string) => {
    wireResolver.set(variant ? `${configKey}\0${variant}` : `${configKey}\0`, wireId);
  };

  for (const [key, raw] of Object.entries(models)) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as KiloModelEntry;
    catalogModels[key] = entry;

    if (entry.options?.cursorModel) {
      registerWire(
        key,
        null,
        sanitizeConfiguredWireId(entry.options.cursorModel, key, null),
      );
    }

    if (entry.variants) {
      for (const [variantKey, variant] of Object.entries(entry.variants)) {
        const wire = variant.options?.cursorModel;
        if (wire) {
          registerWire(
            key,
            variantKey,
            sanitizeConfiguredWireId(wire, key, variantKey),
          );
        }
        const effort = variant.reasoning?.effort;
        if (effort && wire) {
          registerWire(key, effort, sanitizeConfiguredWireId(wire, key, effort));
        }
      }
    }
  }

  const resolveWireModel = (configModelId: string, variantKey?: string): string | undefined => {
    const direct = wireResolver.get(`${configModelId}\0${variantKey ?? ""}`);
    if (direct) return direct;

    const entry = catalogModels[configModelId];
    if (!entry) return undefined;

    if (variantKey && entry.variants?.[variantKey]?.options?.cursorModel) {
      return entry.variants[variantKey].options!.cursorModel;
    }

    return entry.options?.cursorModel;
  };

  return {
    models: catalogModels,
    wireIdByConfigKey: wireResolver,
    resolveWireModel,
  };
}

export function mergeKiloModelCatalog(
  existing: Record<string, unknown>,
  discovered: DiscoveredCursorModel[],
  compact: boolean,
): { models: Record<string, unknown>; syncedCount: number; removedCount: number } {
  const { models: generated } = buildKiloModelCatalog(discovered);
  const merged = { ...existing };
  let removedCount = 0;

  if (compact) {
    const groupedWireIds = new Set<string>();
    const generatedKeys = new Set(Object.keys(generated));
    for (const entry of Object.values(generated)) {
      const e = entry as KiloModelEntry;
      if (e.options?.cursorModel) groupedWireIds.add(e.options.cursorModel);
      if (e.variants) {
        for (const v of Object.values(e.variants)) {
          if (v.options?.cursorModel) groupedWireIds.add(v.options.cursorModel);
        }
      }
    }
    for (const key of Object.keys(merged)) {
      if (generatedKeys.has(key) || key.startsWith("cursor/")) continue;
      if (groupedWireIds.has(key) || discovered.some((d) => d.id === key)) {
        delete merged[key];
        removedCount++;
      }
    }
  }

  for (const [key, entry] of Object.entries(generated)) {
    merged[key] = mergePreservingUserFields(merged[key], entry);
  }

  return { models: merged, syncedCount: Object.keys(generated).length, removedCount };
}

function mergePreservingUserFields(existing: unknown, generated: KiloModelEntry): KiloModelEntry {
  if (!existing || typeof existing !== "object") return generated;
  const e = existing as Record<string, unknown>;
  const merged: KiloModelEntry = { ...generated };
  if (e.name !== undefined) merged.name = String(e.name);
  if (e.cost !== undefined) {
    merged.cost = e.cost as OpenCodeModelCost;
  }
  if (generated.limit?.context !== undefined) {
    const existingLimit = e.limit && typeof e.limit === "object" && !Array.isArray(e.limit)
      ? e.limit as Record<string, unknown>
      : {};
    merged.limit = {
      context: readLimitNumber(existingLimit.context) ?? generated.limit.context,
      output: readLimitNumber(existingLimit.output) ?? generated.limit.output,
    };
  }
  merged.variants = mergeVariantEntries(generated.variants, e.variants);
  return merged;
}

function mergeVariantEntries(
  generated?: KiloModelEntry["variants"],
  existing?: unknown,
): KiloModelEntry["variants"] {
  if (!generated) return undefined;
  if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
    return generated;
  }

  const mergedVariants: NonNullable<KiloModelEntry["variants"]> = { ...generated };
  for (const [variantKey, existingVariant] of Object.entries(existing as Record<string, unknown>)) {
    const generatedVariant = generated[variantKey];
    if (!generatedVariant) continue;
    if (!existingVariant || typeof existingVariant !== "object" || Array.isArray(existingVariant)) {
      continue;
    }
    const existingRecord = existingVariant as Record<string, unknown>;
    const variantMerged = { ...generatedVariant, ...existingRecord } as NonNullable<
      KiloModelEntry["variants"]
    >[string];
    if (existingRecord.cost !== undefined) {
      variantMerged.cost = existingRecord.cost as OpenCodeModelCost;
    } else if (generatedVariant.cost !== undefined) {
      variantMerged.cost = generatedVariant.cost;
    }
    mergedVariants[variantKey] = variantMerged;
  }
  return mergedVariants;
}

function readLimitNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.round(value);
  }
  return undefined;
}

/** Normalize Kilo model ids that may include duplicate provider prefixes. */
export function normalizeConfigModelId(raw: string): string {
  let id = raw.trim().replace(/^cursor-kilo\//, "").replace(/^cursor\//, "");
  while (id.startsWith("cursor/")) {
    id = id.slice("cursor/".length);
  }
  return id;
}

function finalizeCursorAgentWireId(wireId: string): string {
  const stripped = wireId.replace(/^cursor\//, "").replace(/^cursor-kilo\//, "");
  return normalizeCursorAgentWireId(stripped);
}

/** Grok wire ids are always tiered (e.g. cursor-grok-4.6-medium); bare cursor-grok-4.6 is invalid. */
const BARE_GROK_FAMILY_WIRE_ID = /^cursor-grok-\d+(?:\.\d+)?$/;

function isBareGrokFamilyWireId(wireId: string): boolean {
  return BARE_GROK_FAMILY_WIRE_ID.test(wireId);
}

function sanitizeConfiguredWireId(
  wireId: string,
  configKey: string,
  variantKey: string | null,
): string {
  const finalized = finalizeCursorAgentWireId(wireId);
  if (!isBareGrokFamilyWireId(finalized)) return finalized;

  const family = finalized.replace(/^cursor-/, "");
  if (variantKey) {
    return finalizeCursorAgentWireId(`${family}-${variantKey}`);
  }
  return finalizeCursorAgentWireId(`${family}-medium`);
}

/** Resolve runtime cursor wire model from Kilo request body */
export function resolveWireModelFromRequest(
  catalog: KiloCatalogResult | null,
  model: unknown,
  body: Record<string, unknown>,
): string {
  const raw = typeof model === "string" ? model.trim() : "";
  const variant = extractVariantEffort(body);
  const configKey = raw ? normalizeConfigModelId(raw) : "";

  if (catalog && configKey) {
    const resolved = catalog.resolveWireModel(configKey, variant ?? undefined);
    if (resolved) {
      return sanitizeConfiguredWireId(resolved, configKey, variant);
    }

    if (variant) {
      const family = configKey.replace(/^cursor\//, "");
      const suffixWire = `${family}-${variant}`;
      if (suffixWire !== family) {
        return sanitizeConfiguredWireId(suffixWire, configKey, variant);
      }
    }
  }

  const cursorModel = typeof body.cursorModel === "string" ? body.cursorModel.trim() : "";
  if (cursorModel) {
    return sanitizeConfiguredWireId(cursorModel, configKey, variant);
  }

  const normalized = normalizeConfigModelId(raw);
  return normalized ? sanitizeConfiguredWireId(normalized, configKey, variant) : "auto";
}

function extractVariantEffort(body: Record<string, unknown>): string | null {
  for (const source of collectReasoningSources(body)) {
    const effort = readReasoningEffort(source);
    if (effort) return effort;
  }

  const directEffort = body.reasoning_effort ?? body.reasoningEffort;
  if (typeof directEffort === "string" && directEffort.length > 0) {
    return directEffort;
  }

  const variant = body.variant;
  if (typeof variant === "string" && variant.length > 0) return variant;

  return null;
}

function collectReasoningSources(body: Record<string, unknown>): unknown[] {
  const sources: unknown[] = [body.reasoning, body.options, body.providerOptions];
  const providerOptions = body.providerOptions;
  if (providerOptions && typeof providerOptions === "object" && !Array.isArray(providerOptions)) {
    const cursor = (providerOptions as Record<string, unknown>).cursor;
    sources.push(cursor);
    if (cursor && typeof cursor === "object" && !Array.isArray(cursor)) {
      sources.push((cursor as Record<string, unknown>).reasoning);
      sources.push((cursor as Record<string, unknown>).options);
    }
  }
  return sources;
}

function readReasoningEffort(source: unknown): string | null {
  if (!source || typeof source !== "object" || Array.isArray(source)) return null;
  const effort = (source as Record<string, unknown>).effort;
  return typeof effort === "string" && effort.length > 0 ? effort : null;
}
