import type { ModelInfo } from "./types.js";

interface OpenCodeModelConfig {
  name: string;
  tools?: boolean;
  reasoning?: boolean;
  description?: string;
  [key: string]: any;
}

interface OpenCodeProviderConfig {
  npm?: string;
  name?: string;
  options?: Record<string, any>;
  models: Record<string, OpenCodeModelConfig>;
}

export class ConfigUpdater {
  formatModels(models: ModelInfo[]): Record<string, OpenCodeModelConfig> {
    const formatted: Record<string, OpenCodeModelConfig> = {};

    for (const model of models) {
      // Normalize ID for JSON key (replace dots/dashes)
      const key = model.id.replace(/[.-]/g, "");

      formatted[key] = {
        name: model.name,
        tools: true,
        reasoning: true,
        description: model.description
      };
    }

    return formatted;
  }

  mergeModels(
    existing: Record<string, OpenCodeModelConfig>,
    discovered: ModelInfo[]
  ): Record<string, OpenCodeModelConfig> {
    const formatted = this.formatModels(discovered);

    // Merge, preserving existing custom fields
    return {
      ...formatted,
      ...existing // Existing takes precedence for conflicts
    };
  }

  generateProviderConfig(
    models: ModelInfo[],
    baseURL: string
  ): OpenCodeProviderConfig {
    return {
      npm: "@ai-sdk/openai-compatible",
      name: "Cursor Agent Provider",
      options: {
        baseURL,
        apiKey: "cursor-agent"
      },
      models: this.formatModels(models)
    };
  }
}
