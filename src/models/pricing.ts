export type OpenCodeModelCost = {
  input: number;
  output: number;
  cache_read?: number;
  cache_write?: number;
  context_over_200k?: OpenCodeModelCost;
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
  "Auto",
  "Composer 2",
  "Composer 1.5",
  "Claude 4.6",
  "Claude 4.6 Sonnet",
  "Claude Opus 4.7",
  "Claude Opus 4.8",
  "Claude Fable 5",
  "Gemini 3.1 Pro",
  "Gemini 3 Flash",
  "GPT-5.3 Codex",
  "GPT-5.4",
  "GPT-5.5",
  "Grok 4.20",
  "Kimi K2.5",
];

// Official Cursor prices per 1M tokens from https://cursor.com/docs/models-and-pricing.
const AUTO_COST = cost(1.25, 6, 0.25, 1.25);
const COMPOSER_2_COST = cost(0.5, 2.5, 0.2, 0.5);
const COMPOSER_2_FAST_COST = cost(1.5, 7.5, 0.35, 1.5);
const COMPOSER_1_5_COST = cost(3.5, 17.5, 0.35, 3.5);

const CLAUDE_SONNET_COST = cost(3, 15, 0.3, 3.75);
const CLAUDE_SONNET_LONG_CONTEXT_COST = cost(6, 22.5, 0.6, 7.5);
const CLAUDE_SONNET_WITH_LONG_CONTEXT_COST = withLongContext(
  CLAUDE_SONNET_COST,
  CLAUDE_SONNET_LONG_CONTEXT_COST,
);
const CLAUDE_OPUS_COST = cost(5, 25, 0.5, 6.25);
const CLAUDE_OPUS_FAST_COST = cost(30, 150, 3, 37.5);

// Claude Fable 5: Anthropic Mythos-class frontier model (high cost tier per cursor.com/docs/models/claude-fable-5).
// Priced at the Opus rate until Cursor publishes official per-token pricing.
const CLAUDE_FABLE_5_COST = CLAUDE_OPUS_COST;

const GEMINI_3_PRO_COST = withLongContext(cost(2, 12, 0.2, 2), cost(4, 18, 0.4, 4));
const GEMINI_3_FLASH_COST = cost(0.5, 3, 0.05, 0.5);

const GPT_5_1_COST = cost(1.25, 10, 0.125, 1.25);
const GPT_5_2_COST = cost(1.75, 14, 0.175, 1.75);
const GPT_5_3_CODEX_COST = cost(1.75, 14, 0.175, 1.75);
const GPT_5_4_COST = withLongContext(cost(2.5, 15, 0.25, 2.5), cost(5, 22.5, 0.5, 5));
const GPT_5_4_FAST_COST = cost(5, 30, 0.5, 5);
const GPT_5_4_MINI_COST = cost(0.75, 4.5, 0.075, 0.75);
const GPT_5_4_NANO_COST = cost(0.2, 1.25, 0.02, 0.2);
const GPT_5_5_COST = withLongContext(cost(5, 30, 0.5, 5), cost(10, 45, 1, 10));
const GPT_5_MINI_COST = cost(0.25, 2, 0.025, 0.25);

const GROK_4_20_COST = withLongContext(cost(2, 6, 0.2, 2), cost(4, 12, 0.4, 4));
const KIMI_K2_5_COST = cost(0.6, 3, 0.1, 0.6);

export function getCursorModelCost(modelId: string): OpenCodeModelCost | undefined {
  if (modelId === "auto") return AUTO_COST;
  if (modelId === "composer-2-fast") return COMPOSER_2_FAST_COST;
  if (modelId === "composer-2") return COMPOSER_2_COST;
  if (modelId === "composer-1.5") return COMPOSER_1_5_COST;

  if (modelId.startsWith("claude-opus-4-8")) return CLAUDE_OPUS_COST;
  if (modelId.startsWith("claude-opus-4-7")) return CLAUDE_OPUS_COST;
  if (modelId.startsWith("claude-4.6-opus")) {
    return modelId.endsWith("-fast") ? CLAUDE_OPUS_FAST_COST : CLAUDE_OPUS_COST;
  }
  if (modelId.startsWith("claude-4.5-opus")) return CLAUDE_OPUS_COST;
  if (modelId.startsWith("claude-4.6-sonnet")) return CLAUDE_SONNET_WITH_LONG_CONTEXT_COST;
  if (modelId.startsWith("claude-4.5-sonnet")) return CLAUDE_SONNET_WITH_LONG_CONTEXT_COST;
  if (modelId.startsWith("claude-4-sonnet")) return CLAUDE_SONNET_COST;

  if (modelId === "gemini-3.1-pro") return GEMINI_3_PRO_COST;
  if (modelId === "gemini-3-flash") return GEMINI_3_FLASH_COST;

  if (modelId.startsWith("gpt-5.5")) return GPT_5_5_COST;
  if (modelId.startsWith("gpt-5.4-mini")) return GPT_5_4_MINI_COST;
  if (modelId.startsWith("gpt-5.4-nano")) return GPT_5_4_NANO_COST;
  if (modelId.startsWith("gpt-5.4")) {
    return modelId.endsWith("-fast") ? GPT_5_4_FAST_COST : GPT_5_4_COST;
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
  if (modelId.startsWith("claude-fable-5")) return CLAUDE_FABLE_5_COST;

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
