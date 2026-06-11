import type { ModelInfo, DiscoveryConfig } from "./types.js";
import { listModelsViaRunner } from "../client/sdk-child.js";
import { discoverModelsFromCursorAgent } from "../cli/model-discovery.js";
import { resolveSdkApiKey } from "../auth.js";
import { parseCursorBackendPreference } from "../provider/backend.js";

interface CacheEntry {
  models: ModelInfo[];
  timestamp: number;
}

export class ModelDiscoveryService {
  private cache: CacheEntry | null = null;
  private cacheTTL: number;
  private fallbackModels: ModelInfo[];

  constructor(config: DiscoveryConfig = {}) {
    this.cacheTTL = config.cacheTTL || 5 * 60 * 1000; // 5 minutes
    this.fallbackModels = config.fallbackModels || this.getDefaultModels();
  }

  async discover(apiKey?: string): Promise<ModelInfo[]> {
    // Check cache
    if (this.cache && Date.now() - this.cache.timestamp < this.cacheTTL) {
      return this.cache.models;
    }

    const backendPreference = parseCursorBackendPreference(process.env.CURSOR_ACP_BACKEND).preference;
    const queryOrder = backendPreference === "sdk"
      ? ["sdk"]
      : backendPreference === "cursor-agent"
        ? ["cursor-agent"]
        : ["cursor-agent", "sdk"];

    for (const backend of queryOrder) {
      try {
        const models = backend === "cursor-agent"
          ? await this.queryCursorAgent()
          : await this.queryViaSdk(apiKey);
        this.cache = { models, timestamp: Date.now() };
        return models;
      } catch {
        // Try the next backend before falling back to static defaults.
      }
    }

    this.cache = { models: this.fallbackModels, timestamp: Date.now() };
    return this.fallbackModels;
  }

  async queryCursorAgent(apiKey?: string): Promise<ModelInfo[]> {
    void apiKey;
    return discoverModelsFromCursorAgent().map((model) => ({
      id: model.id,
      name: model.name,
      description: `Cursor ${model.name} model`,
    }));
  }

  private async queryViaSdk(apiKey?: string): Promise<ModelInfo[]> {
    // Use the SDK runner to list models
    const key = resolveSdkApiKey({ env: process.env, storedApiKey: apiKey });
    if (!key) {
      throw new Error("No Cursor API key available");
    }

    const sdkModels = await listModelsViaRunner(key);
    
    // Map SDK model format to ModelInfo
    return sdkModels.map((m) => ({
      id: m.id,
      name: m.name,
      description: `Cursor ${m.name} model`,
    }));
  }

  private getDefaultModels(): ModelInfo[] {
    return [
      { id: "auto", name: "Auto", description: "Auto-select best model" },
      { id: "composer-1.5", name: "Composer 1.5" },
      { id: "composer-1", name: "Composer 1" },
      { id: "opus-4.6-thinking", name: "Claude 4.6 Opus (Thinking)" },
      { id: "opus-4.6", name: "Claude 4.6 Opus" },
      { id: "sonnet-4.6", name: "Claude 4.6 Sonnet" },
      { id: "sonnet-4.6-thinking", name: "Claude 4.6 Sonnet (Thinking)" },
      { id: "opus-4.5", name: "Claude 4.5 Opus" },
      { id: "opus-4.5-thinking", name: "Claude 4.5 Opus (Thinking)" },
      { id: "sonnet-4.5", name: "Claude 4.5 Sonnet" },
      { id: "sonnet-4.5-thinking", name: "Claude 4.5 Sonnet (Thinking)" },
      { id: "gpt-5.4-high", name: "GPT-5.4 High" },
      { id: "gpt-5.4-medium", name: "GPT-5.4" },
      { id: "gpt-5.3-codex", name: "GPT-5.3 Codex" },
      { id: "gpt-5.2", name: "GPT-5.2" },
      { id: "gemini-3.1-pro", name: "Gemini 3.1 Pro" },
      { id: "gemini-3-pro", name: "Gemini 3 Pro" },
      { id: "gemini-3-flash", name: "Gemini 3 Flash" },
      { id: "grok", name: "Grok" },
      { id: "kimi-k2.5", name: "Kimi K2.5" },
    ];
  }

  invalidateCache(): void {
    this.cache = null;
  }
}
