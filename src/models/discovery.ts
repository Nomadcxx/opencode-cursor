import type { ModelInfo, DiscoveryConfig } from "./types.js";
import { listModelsViaRunner } from "../client/sdk-child.js";
import { discoverModelsFromCursorAgentAsync, fallbackModels } from "../cli/model-discovery.js";
import { appendIdeEnabledModels } from "./ide-catalog.js";
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
    return appendIdeEnabledModels(await discoverModelsFromCursorAgentAsync()).map((model) => ({
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
    return fallbackModels();
  }

  invalidateCache(): void {
    this.cache = null;
  }
}
