export type DiscoveredCursorModel = {
  id: string;
  name: string;
};

export type CursorModelVariant = {
  baseId: string;
  variant: string | null;
  cursorModelId: string;
  name: string;
};

export type CursorModelGroup = {
  baseId: string;
  name: string;
  defaultCursorModelId: string;
  variants: Record<string, string>;
  members: CursorModelVariant[];
};

export type CursorModelGroups = {
  groups: CursorModelGroup[];
  direct: DiscoveredCursorModel[];
};

export type OpenCodeCursorModelEntry = {
  name: string;
  options?: {
    cursorModel: string;
  };
  variants?: Record<string, { cursorModel: string }>;
};

export type CursorModelMergeOptions = {
  variants: boolean;
  compact: boolean;
};

export type CursorModelMergeResult = {
  models: Record<string, unknown>;
  syncedCount: number;
  groupedCount: number;
  removedCount: number;
};

const DIRECT_MODEL_IDS = new Set([
  "auto",
  "composer-1.5",
  "kimi-k2.5",
  "gemini-3.1-pro",
  "gemini-3-flash",
  "gpt-5-mini",
]);

const VARIANT_SUFFIXES = [
  "max-thinking-fast",
  "high-thinking-fast",
  "thinking-high-fast",
  "medium-thinking",
  "high-thinking",
  "max-thinking",
  "low-fast",
  "medium-fast",
  "high-fast",
  "xhigh-fast",
  "thinking-low",
  "thinking-medium",
  "thinking-high",
  "thinking-xhigh",
  "thinking-max",
  "extra-high",
  "thinking",
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "fast",
];

const QUALIFIED_VARIANT_PREFIXES = [
  "spark-preview",
];

const DEFAULT_VARIANT_ORDER = [
  null,
  "medium",
  "high",
  "low",
  "none",
  "xhigh",
  "max",
];

const VARIANT_DISPLAY_ORDER = [
  "none",
  "low",
  "low-fast",
  "fast",
  "medium",
  "medium-fast",
  "medium-thinking",
  "high",
  "high-fast",
  "high-thinking",
  "high-thinking-fast",
  "xhigh",
  "xhigh-fast",
  "max",
  "max-thinking",
  "max-thinking-fast",
  "thinking",
  "thinking-low",
  "thinking-medium",
  "thinking-high",
  "thinking-high-fast",
  "thinking-xhigh",
  "thinking-max",
  "extra-high",
  "spark-preview",
  "spark-preview-low",
  "spark-preview-medium",
  "spark-preview-high",
  "spark-preview-xhigh",
];

function parseVariant(
  modelId: string,
  knownModelIds: Set<string>,
): { baseId: string; variant: string } | null {
  const qualifiedVariant = parseQualifiedVariant(modelId, knownModelIds);
  if (qualifiedVariant) return qualifiedVariant;

  for (const variant of VARIANT_SUFFIXES) {
    const suffix = `-${variant}`;
    if (!modelId.endsWith(suffix)) continue;

    const baseId = modelId.slice(0, -suffix.length);
    if (isSafeBaseId(baseId)) {
      return resolveQualifiedBaseVariant(baseId, variant, knownModelIds);
    }
  }

  return null;
}

function parseQualifiedVariant(
  modelId: string,
  knownModelIds: Set<string>,
): { baseId: string; variant: string } | null {
  for (const qualifier of QUALIFIED_VARIANT_PREFIXES) {
    const suffix = `-${qualifier}`;
    if (!modelId.endsWith(suffix)) continue;

    const baseId = modelId.slice(0, -suffix.length);
    if (knownModelIds.has(baseId) && isSafeBaseId(baseId)) {
      return { baseId, variant: qualifier };
    }
  }

  return null;
}

function resolveQualifiedBaseVariant(
  baseId: string,
  variant: string,
  knownModelIds: Set<string>,
): { baseId: string; variant: string } {
  for (const qualifier of QUALIFIED_VARIANT_PREFIXES) {
    const suffix = `-${qualifier}`;
    if (!baseId.endsWith(suffix)) continue;

    const parentBaseId = baseId.slice(0, -suffix.length);
    if (knownModelIds.has(parentBaseId) && isSafeBaseId(parentBaseId)) {
      return {
        baseId: parentBaseId,
        variant: `${qualifier}-${variant}`,
      };
    }
  }

  return { baseId, variant };
}

function isSafeBaseId(baseId: string): boolean {
  const parts = baseId.split("-").filter(Boolean);
  if (parts.length < 2) return false;
  if (baseId === "gpt-5") return false;
  return true;
}

function getDefaultMember(members: CursorModelVariant[]): CursorModelVariant {
  for (const variant of DEFAULT_VARIANT_ORDER) {
    const member = members.find(candidate => candidate.variant === variant);
    if (member) return member;
  }

  return members[0];
}

function formatModelName(modelId: string): string {
  return modelId
    .split("-")
    .map(part => {
      if (part === "gpt") return "GPT";
      if (part === "xhigh") return "XHigh";
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(" ");
}

function compareVariants(a: CursorModelVariant, b: CursorModelVariant): number {
  if (a.variant === null) return -1;
  if (b.variant === null) return 1;

  const aIndex = VARIANT_DISPLAY_ORDER.indexOf(a.variant);
  const bIndex = VARIANT_DISPLAY_ORDER.indexOf(b.variant);

  if (aIndex !== -1 && bIndex !== -1) return aIndex - bIndex;
  if (aIndex !== -1) return -1;
  if (bIndex !== -1) return 1;
  return a.variant.localeCompare(b.variant);
}

function createGroup(baseId: string, members: CursorModelVariant[]): CursorModelGroup {
  const defaultMember = getDefaultMember(members);
  const variants: Record<string, string> = {};

  for (const member of [...members].sort(compareVariants)) {
    if (member.variant) {
      variants[member.variant] = member.cursorModelId;
    }
  }

  return {
    baseId,
    name: defaultMember.variant === null ? defaultMember.name : formatModelName(baseId),
    defaultCursorModelId: defaultMember.cursorModelId,
    variants,
    members,
  };
}

export function groupCursorModels(models: DiscoveredCursorModel[]): CursorModelGroups {
  const byId = new Map(models.map(model => [model.id, model]));
  const knownModelIds = new Set(byId.keys());
  const candidates = new Map<string, CursorModelVariant[]>();
  const direct: DiscoveredCursorModel[] = [];

  for (const model of models) {
    if (DIRECT_MODEL_IDS.has(model.id)) {
      direct.push(model);
      continue;
    }

    const parsed = parseVariant(model.id, knownModelIds);
    if (!parsed) {
      continue;
    }

    const members = candidates.get(parsed.baseId) || [];
    members.push({
      baseId: parsed.baseId,
      variant: parsed.variant,
      cursorModelId: model.id,
      name: model.name,
    });
    candidates.set(parsed.baseId, members);
  }

  for (const model of models) {
    if (DIRECT_MODEL_IDS.has(model.id)) continue;
    if (!candidates.has(model.id)) continue;

    candidates.get(model.id)?.push({
      baseId: model.id,
      variant: null,
      cursorModelId: model.id,
      name: model.name,
    });
  }

  const groupedIds = new Set<string>();
  const groups: CursorModelGroup[] = [];

  for (const [baseId, members] of candidates) {
    if (members.length < 2 && !byId.has(baseId)) continue;

    groups.push(createGroup(baseId, members));
    for (const member of members) {
      groupedIds.add(member.cursorModelId);
    }
  }

  for (const model of models) {
    if (groupedIds.has(model.id)) continue;
    if (direct.some(candidate => candidate.id === model.id)) continue;
    direct.push(model);
  }

  return { groups, direct };
}

export function createVariantModelEntries(models: DiscoveredCursorModel[]): {
  entries: Record<string, OpenCodeCursorModelEntry>;
  groupedModelIds: Set<string>;
} {
  const { groups, direct } = groupCursorModels(models);
  const entries: Record<string, OpenCodeCursorModelEntry> = {};
  const groupedModelIds = new Set<string>();

  for (const group of groups) {
    const variants: Record<string, { cursorModel: string }> = {};
    for (const [variant, cursorModel] of Object.entries(group.variants)) {
      variants[variant] = { cursorModel };
    }

    entries[group.baseId] = {
      name: group.name,
      options: {
        cursorModel: group.defaultCursorModelId,
      },
      variants,
    };

    for (const member of group.members) {
      groupedModelIds.add(member.cursorModelId);
    }
  }

  for (const model of direct) {
    entries[model.id] = { name: model.name };
  }

  return { entries, groupedModelIds };
}

export function mergeCursorModelEntries(
  existingModels: Record<string, unknown>,
  discoveredModels: DiscoveredCursorModel[],
  options: CursorModelMergeOptions,
): CursorModelMergeResult {
  if (!options.variants) {
    return mergeDirectModelEntries(existingModels, discoveredModels);
  }

  const { entries, groupedModelIds } = createVariantModelEntries(discoveredModels);
  const models = { ...existingModels };
  let removedCount = 0;

  if (options.compact) {
    for (const modelId of groupedModelIds) {
      if (!Object.prototype.hasOwnProperty.call(models, modelId)) continue;
      if (Object.prototype.hasOwnProperty.call(entries, modelId)) continue;
      delete models[modelId];
      removedCount++;
    }
  }

  for (const [modelId, entry] of Object.entries(entries)) {
    models[modelId] = entry;
  }

  return {
    models,
    syncedCount: Object.keys(entries).length,
    groupedCount: groupedModelIds.size,
    removedCount,
  };
}

function mergeDirectModelEntries(
  existingModels: Record<string, unknown>,
  discoveredModels: DiscoveredCursorModel[],
): CursorModelMergeResult {
  const models = { ...existingModels };

  for (const model of discoveredModels) {
    models[model.id] = { name: model.name };
  }

  return {
    models,
    syncedCount: discoveredModels.length,
    groupedCount: 0,
    removedCount: 0,
  };
}
