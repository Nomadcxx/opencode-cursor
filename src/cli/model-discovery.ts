import spawn from "cross-spawn";
import { stripAnsi } from "../utils/errors.js";
import { resolveCursorAgentBinary } from "../utils/binary.js";
import { buildCursorAgentSpawnCommand } from "../utils/cursor-agent-command.mjs";

const MODEL_DISCOVERY_TIMEOUT_MS = 5000;

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

export type DiscoverDeps = {
  platform?: NodeJS.Platform;
  spawnSync?: typeof spawn.sync;
  resolveBinary?: () => string;
};

export function discoverModelsFromCursorAgent(deps: DiscoverDeps = {}): DiscoveredModel[] {
  const platform = deps.platform ?? process.platform;
  const exec = deps.spawnSync ?? spawn.sync;
  const resolveBinary = deps.resolveBinary ?? resolveCursorAgentBinary;

  const [command, args] = buildCursorAgentSpawnCommand(resolveBinary(), ["models"], { platform });
  const result = exec(command, args, {
    encoding: "utf8",
    ...(platform !== "win32" && { killSignal: "SIGTERM" as const }),
    stdio: ["ignore", "pipe", "pipe"],
    timeout: MODEL_DISCOVERY_TIMEOUT_MS,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`cursor-agent models failed (${result.status}): ${result.stderr}`);
  }
  const models = parseCursorModelsOutput(String(result.stdout));
  if (models.length === 0) {
    throw new Error("No models parsed from cursor-agent output");
  }
  return models;
}

export function fallbackModels(): DiscoveredModel[] {
  return [
    { id: "auto", name: "Auto" },
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
