#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import {
  discoverModelsFromCursorAgent,
  fallbackModels,
} from "./model-discovery.js";

async function main() {
  console.log("Discovering Cursor models...");
  let models = fallbackModels();
  try {
    models = discoverModelsFromCursorAgent();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Warning: cursor-agent model discovery failed, using fallback list (${message})`);
  }

  console.log(`Found ${models.length} models:`);
  for (const model of models) {
    console.log(`  - ${model.id}: ${model.name}`);
  }

  // Update config
  const configPath = join(homedir(), ".config/opencode/opencode.json");

  if (!existsSync(configPath)) {
    console.error(`Config not found: ${configPath}`);
    process.exit(1);
  }

  const existingConfig = JSON.parse(readFileSync(configPath, "utf-8"));

  // Update cursor-acp provider models
  if (existingConfig.provider?.["cursor-acp"]) {
    const formatted = Object.fromEntries(models.map((model) => [model.id, { name: model.name }]));
    existingConfig.provider["cursor-acp"].models = {
      ...existingConfig.provider["cursor-acp"].models,
      ...formatted
    };

    writeFileSync(configPath, JSON.stringify(existingConfig, null, 2));
    console.log(`Updated ${configPath}`);
  } else {
    console.error("cursor-acp provider not found in config");
    process.exit(1);
  }

  console.log("Done!");
}

main().catch(console.error);
