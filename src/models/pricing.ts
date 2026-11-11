export type OpenCodeModelCost = {
  input: number;
  output: number;
  cache_read?: number;
  cache_write?: number;
  context_over_200k?: OpenCodeModelCost;
};

/** OpenCode 2.0 `Model.Info.cost` tier array. */
export type OpenCode2ModelCost = {
  tier?: { type: "context"; size: number };
  input: number;
  output: number;
  cache: { read: number; write: number };
};

export type CursorPricingCoverage = {
  priced: string[];
  missing: string[];
};

export type OpenCodeModelCostValidation = {
  valid: boolean;
  errors: string[];
};

export const CURSOR_PRICING_DOC_URL = "https://cursor.com/docs/models-and-pricing";

export const CURSOR_PRICING_DOC_MARKERS = [
  "Composer 2.5",
  "Grok 4.7",
  "Grok 4.6",
  "Grok 4.5",
  "Claude 4.6 Opus",
  "Claude Opus 5",
  "Claude Sonnet 5",
  "Claude Fable 5",
  "Gemini 4 Argon",
  "GPT-5.5",
  "GLM 5.2",
  "Kimi K3",
];

// Official Cursor prices per 1M tokens from https://cursor.com/docs/models-and-pricing.
// Where the docs show no cache-write price, writes bill at the input rate.
const AUTO_COST = cost(1.25, 6, 0.25, 1.25);
const COMPOSER_2_5_COST = cost(0.5, 2.5, 0.2, 0.5);
const COMPOSER_2_5_FAST_COST = cost(3, 15, 0.5, 3);
const COMPOSER_2_COST = cost(0.5, 2.5, 0.2, 0.5);
const COMPOSER_2_FAST_COST = cost(1.5, 7.5, 0.35, 1.5);
const COMPOSER_1_5_COST = cost(3.5, 17.5, 0.35, 3.5);

// Grok's long-context rate starts at 256k, which the 200k tier cannot express.
const GROK_COST = cost(2, 6, 0.5, 2);
const GROK_FAST_COST = cost(4, 12, 1, 4);
const GROK_4_5_FAST_COST = cost(4, 18, 1, 4);

const CLAUDE_SONNET_COST = cost(3, 15, 0.3, 3.75);
const CLAUDE_SONNET_LONG_CONTEXT_COST = cost(6, 22.5, 0.6, 7.5);
const CLAUDE_SONNET_WITH_LONG_CONTEXT_COST = withLongContext(
  CLAUDE_SONNET_COST,
  CLAUDE_SONNET_LONG_CONTEXT_COST,
);
const CLAUDE_OPUS_COST = cost(5, 25, 0.5, 6.25);
const CLAUDE_OPUS_FAST_COST = cost(30, 150, 3, 37.5);
// "3x lower per-token pricing than Opus 4.7 fast mode".
const CLAUDE_OPUS_4_8_FAST_COST = cost(10, 50, 1, 12.5);
const CLAUDE_OPUS_5_5_COST = cost(4, 20, 0.2, 5);
const CLAUDE_SONNET_5_COST = cost(2, 10, 0.2, 2.5);
const CLAUDE_SONNET_5_5_COST = cost(2, 10, 0.1, 2.5);
// Haiku bills 5x above 100k input, which the 200k tier cannot express.
const CLAUDE_HAIKU_5_5_COST = cost(0.1, 0.5, 0.01, 0.125);
const CLAUDE_FABLE_5_COST = cost(10, 50, 1, 12.5);
const CLAUDE_FABLE_5_1_COST = cost(10, 50, 0.25, 12.5);
const CLAUDE_FABLE_5_2_COST = cost(8, 40, 0.2, 10);

const GEMINI_3_PRO_COST = withLongContext(cost(2, 12, 0.2, 2), cost(4, 18, 0.4, 4));
const GEMINI_3_FLASH_COST = cost(0.5, 3, 0.05, 0.5);
const GEMINI_3_5_FLASH_COST = cost(1.5, 9, 0.15, 1.5);
const GEMINI_3_8_FLASH_COST = cost(0.75, 3.75, 0.075, 0.75);
// Gemini 4 Carbon is on introductory pricing through November 30, 2026.
const GEMINI_4_COST = cost(2, 10, 0.1, 2);

const GPT_5_1_COST = cost(1.25, 10, 0.125, 1.25);
const GPT_5_2_COST = cost(1.75, 14, 0.175, 1.75);
const GPT_5_3_CODEX_COST = cost(1.75, 14, 0.175, 1.75);
const GPT_5_4_COST = withLongContext(cost(2.5, 15, 0.25, 2.5), cost(5, 22.5, 0.5, 5));
const GPT_5_4_FAST_COST = cost(5, 30, 0.5, 5);
const GPT_5_4_MINI_COST = cost(0.75, 4.5, 0.075, 0.75);
const GPT_5_4_NANO_COST = cost(0.2, 1.25, 0.02, 0.2);
const GPT_5_5_COST = withLongContext(cost(5, 30, 0.5, 5), cost(10, 45, 1, 10));
const GPT_5_6_LUNA_COST = cost(0.2, 1.2, 0.02, 0.25);
const GPT_5_6_SOL_COST = cost(4, 20, 0.4, 5);
const GPT_5_6_TERRA_COST = cost(2, 12, 0.2, 2.5);
const GPT_5_MINI_COST = cost(0.25, 2, 0.025, 0.25);

const GROK_4_20_COST = withLongContext(cost(2, 6, 0.2, 2), cost(4, 12, 0.4, 4));
const KIMI_K2_5_COST = cost(0.6, 3, 0.1, 0.6);
const KIMI_K2_7_CODE_COST = cost(0.95, 4, 0.19, 0.95);
const KIMI_K3_COST = cost(3, 15, 0.3, 3);
const GLM_5_COST = cost(1.4, 4.4, 0.26, 1.4);
const DEEPSEEK_V4_1_FLASH_COST = cost(0.3, 1.2, 0.006, 0.3);
const MUSE_SPARK_1_3_COST = cost(1.25, 4.25, 0.15, 1.25);
const MUSE_WONDER_COST = cost(4, 20, 0.2, 4);

export function getCursorModelCost(modelId: string): OpenCodeModelCost | undefined {
  // Fast mode bills above the base rate. Ids whose fast rate Cursor does not
  // publish stay unpriced rather than show the cheaper base rate.
  const fast = modelId.endsWith("-fast");

  if (modelId === "auto") return AUTO_COST;
  if (modelId === "composer-2.5-fast") return COMPOSER_2_5_FAST_COST;
  if (modelId === "composer-2.5") return COMPOSER_2_5_COST;
  if (modelId === "composer-2-fast") return COMPOSER_2_FAST_COST;
  if (modelId === "composer-2") return COMPOSER_2_COST;
  if (modelId === "composer-1.5") return COMPOSER_1_5_COST;

  if (modelId.startsWith("grok-4.7-") || modelId.startsWith("cursor-grok-4.6-")) {
    return fast ? GROK_FAST_COST : GROK_COST;
  }
  if (modelId.startsWith("cursor-grok-4.5-")) return fast ? GROK_4_5_FAST_COST : GROK_COST;

  if (modelId.startsWith("claude-opus-5-5")) return fast ? undefined : CLAUDE_OPUS_5_5_COST;
  if (modelId.startsWith("claude-opus-5")) return fast ? undefined : CLAUDE_OPUS_COST;
  if (modelId.startsWith("claude-opus-4-8")) return fast ? CLAUDE_OPUS_4_8_FAST_COST : CLAUDE_OPUS_COST;
  if (modelId.startsWith("claude-opus-4-7")) return fast ? CLAUDE_OPUS_FAST_COST : CLAUDE_OPUS_COST;
  if (modelId.startsWith("claude-sonnet-5-5")) return CLAUDE_SONNET_5_5_COST;
  if (modelId.startsWith("claude-sonnet-5")) return CLAUDE_SONNET_5_COST;
  if (modelId.startsWith("claude-haiku-5-5")) return CLAUDE_HAIKU_5_5_COST;
  if (modelId.startsWith("claude-fable-5-2")) return fast ? undefined : CLAUDE_FABLE_5_2_COST;
  if (modelId.startsWith("claude-fable-5-1")) return CLAUDE_FABLE_5_1_COST;
  if (modelId.startsWith("claude-fable-5")) return CLAUDE_FABLE_5_COST;
  if (modelId.startsWith("claude-4.6-opus")) {
    return fast ? CLAUDE_OPUS_FAST_COST : CLAUDE_OPUS_COST;
  }
  if (modelId.startsWith("claude-4.5-opus")) return CLAUDE_OPUS_COST;
  if (modelId.startsWith("claude-4.6-sonnet")) return CLAUDE_SONNET_COST;
  if (modelId.startsWith("claude-4.5-sonnet")) return CLAUDE_SONNET_WITH_LONG_CONTEXT_COST;
  if (modelId.startsWith("claude-4-sonnet")) return CLAUDE_SONNET_COST;

  if (modelId === "gemini-3.1-pro") return GEMINI_3_PRO_COST;
  if (modelId === "gemini-3-flash") return GEMINI_3_FLASH_COST;
  if (modelId === "gemini-3.5-flash") return GEMINI_3_5_FLASH_COST;
  if (modelId.startsWith("gemini-3.8-flash")) return GEMINI_3_8_FLASH_COST;
  if (modelId.startsWith("gemini-4-argon") || modelId.startsWith("gemini-4-carbon")) return GEMINI_4_COST;

  if (modelId.startsWith("gpt-5.6-luna")) return fast ? undefined : GPT_5_6_LUNA_COST;
  if (modelId.startsWith("gpt-5.6-sol")) return fast ? undefined : GPT_5_6_SOL_COST;
  if (modelId.startsWith("gpt-5.6-terra")) return fast ? undefined : GPT_5_6_TERRA_COST;
  if (modelId.startsWith("gpt-5.5")) return GPT_5_5_COST;
  if (modelId.startsWith("gpt-5.4-mini")) return GPT_5_4_MINI_COST;
  if (modelId.startsWith("gpt-5.4-nano")) return GPT_5_4_NANO_COST;
  if (modelId.startsWith("gpt-5.4")) {
    return fast ? GPT_5_4_FAST_COST : GPT_5_4_COST;
  }
  if (modelId.startsWith("gpt-5.3-codex")) return GPT_5_3_CODEX_COST;
  if (modelId.startsWith("gpt-5.2-codex")) return GPT_5_2_COST;
  if (modelId.startsWith("gpt-5.2")) return GPT_5_2_COST;
  if (modelId.startsWith("gpt-5.1-codex-mini")) return GPT_5_MINI_COST;
  if (modelId.startsWith("gpt-5.1-codex-max")) return GPT_5_1_COST;
  if (modelId.startsWith("gpt-5.1")) return GPT_5_1_COST;
  if (modelId === "gpt-5-mini") return GPT_5_MINI_COST;

  if (modelId.startsWith("grok-4-20")) return GROK_4_20_COST;
  if (modelId === "kimi-k2.5") return KIMI_K2_5_COST;
  if (modelId === "kimi-k2.7-code") return KIMI_K2_7_CODE_COST;
  if (modelId.startsWith("kimi-k3")) return KIMI_K3_COST;
  if (modelId.startsWith("glm-5.2") || modelId.startsWith("glm-5.3")) return GLM_5_COST;
  if (modelId.startsWith("deepseek-v41-flash-1017")) return DEEPSEEK_V4_1_FLASH_COST;
  if (modelId.startsWith("muse-spark-1.3")) return MUSE_SPARK_1_3_COST;
  if (modelId.startsWith("muse-wonder-1.0")) return MUSE_WONDER_COST;

  return undefined;
}

export function applyCursorModelCost<T extends Record<string, unknown>>(
  modelId: string,
  entry: T,
): T & { cost?: OpenCodeModelCost } {
  const modelCost = getCursorModelCost(modelId);
  if (!modelCost) return entry;
  return { ...entry, cost: modelCost };
}

/** Convert classic cost → OpenCode 2.0 `Model.Info.cost` array. */
export function toOpenCode2Costs(cost: OpenCodeModelCost | undefined): OpenCode2ModelCost[] {
  if (!cost) return [];
  const out: OpenCode2ModelCost[] = [
    {
      input: cost.input,
      output: cost.output,
      cache: {
        read: cost.cache_read ?? 0,
        write: cost.cache_write ?? 0,
      },
    },
  ];
  if (cost.context_over_200k) {
    out.push({
      tier: { type: "context", size: 200_000 },
      input: cost.context_over_200k.input,
      output: cost.context_over_200k.output,
      cache: {
        read: cost.context_over_200k.cache_read ?? 0,
        write: cost.context_over_200k.cache_write ?? 0,
      },
    });
  }
  return out;
}

export function checkCursorPricingCoverage(modelIds: string[]): CursorPricingCoverage {
  const priced: string[] = [];
  const missing: string[] = [];

  for (const modelId of modelIds) {
    if (getCursorModelCost(modelId)) {
      priced.push(modelId);
    } else {
      missing.push(modelId);
    }
  }

  return { priced, missing };
}

export function validateOpenCodeModelCost(
  value: unknown,
  path = "cost",
): OpenCodeModelCostValidation {
  const errors: string[] = [];
  collectCostValidationErrors(value, path, errors);
  return { valid: errors.length === 0, errors };
}

export function isOpenCodeModelCost(value: unknown): value is OpenCodeModelCost {
  return validateOpenCodeModelCost(value).valid;
}

function cost(input: number, output: number, cacheRead: number, cacheWrite: number): OpenCodeModelCost {
  return {
    input,
    output,
    cache_read: cacheRead,
    cache_write: cacheWrite,
  };
}

function withLongContext(
  base: OpenCodeModelCost,
  longContext: OpenCodeModelCost,
): OpenCodeModelCost {
  return {
    ...base,
    context_over_200k: longContext,
  };
}

function collectCostValidationErrors(value: unknown, path: string, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return;
  }

  validateRequiredPrice(value.input, `${path}.input`, errors);
  validateRequiredPrice(value.output, `${path}.output`, errors);
  validateOptionalPrice(value.cache_read, `${path}.cache_read`, errors);
  validateOptionalPrice(value.cache_write, `${path}.cache_write`, errors);

  if (value.context_over_200k !== undefined) {
    collectCostValidationErrors(value.context_over_200k, `${path}.context_over_200k`, errors);
  }
}

function validateRequiredPrice(value: unknown, path: string, errors: string[]): void {
  if (!isNonNegativeFiniteNumber(value)) {
    errors.push(`${path} must be a non-negative finite number`);
  }
}

function validateOptionalPrice(value: unknown, path: string, errors: string[]): void {
  if (value !== undefined && !isNonNegativeFiniteNumber(value)) {
    errors.push(`${path} must be a non-negative finite number`);
  }
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
