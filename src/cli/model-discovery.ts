import { execFileSync } from "child_process";
import { stripAnsi } from "../utils/errors.js";

export type DiscoveredModel = {
  id: string;
  name: string;
};

export function parseCursorModelsOutput(output: string): DiscoveredModel[] {
  const clean = stripAnsi(output);
  const models: DiscoveredModel[] = [];
  const seen = new Set<string>();

  for (const line of clean.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(
      /^([a-zA-Z0-9._-]+)\s+-\s+(.+?)(?:\s+\((?:current|default)\))*\s*$/,
    );
    if (!match) continue;

    const id = match[1];
    if (seen.has(id)) continue;
    seen.add(id);
    models.push({ id, name: match[2].trim() });
  }

  return models;
}

export function discoverModelsFromCursorAgent(): DiscoveredModel[] {
  const raw = execFileSync("cursor-agent", ["models"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const models = parseCursorModelsOutput(raw);
  if (models.length === 0) {
    throw new Error("No models parsed from cursor-agent output");
  }
  return models;
}

export function fallbackModels(): DiscoveredModel[] {
  return [
    { id: "auto", name: "Auto" },
    { id: "sonnet-4.5", name: "Claude 4.5 Sonnet" },
    { id: "opus-4.6", name: "Claude 4.6 Opus" },
    { id: "gpt-5.2", name: "GPT-5.2" },
  ];
}
