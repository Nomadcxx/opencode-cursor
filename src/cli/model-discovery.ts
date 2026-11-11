import spawn from "cross-spawn";
import { stripAnsi } from "../utils/errors.js";
import { resolveCursorAgentBinary } from "../utils/binary.js";
import { buildCursorAgentSpawnCommand } from "../utils/cursor-agent-command.mjs";
import { runCursorAgent, type CursorAgentRunDeps } from "../utils/cursor-agent-run.js";

const MODEL_DISCOVERY_TIMEOUT_MS = 5000;
// Cursor pads some names (Grok 4.7 "Fast") with zero-width spaces; trim() keeps them.
const INVISIBLE_CHARS = /[\u200B-\u200D\u2060\uFEFF]/g;

export type DiscoveredModel = {
  id: string;
  name: string;
  /** Real context window when Cursor's picker catalog knows it. */
  contextWindow?: number;
};

export function parseCursorModelsOutput(output: string): DiscoveredModel[] {
  const clean = stripAnsi(output);
  const models: DiscoveredModel[] = [];
  const seen = new Set<string>();

  for (const line of clean.split("\n")) {
    const trimmed = line.replace(INVISIBLE_CHARS, "").trim();
    if (!trimmed) continue;
    const match = trimmed.match(
      /^([a-zA-Z0-9._-]+)\s+-\s+(.+?)(?:\s+\((?:current|default)\))*\s*$/,
    );
    if (!match) continue;

    const id = match[1];
    if (seen.has(id)) continue;
    seen.add(id);
    models.push({ id, name: match[2].replace(/\s+/g, " ").trim() });
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
  return modelsFromExit(result.status, String(result.stdout), String(result.stderr));
}

/**
 * Non-blocking `cursor-agent models`. OpenCode 2 runs plugins inside its server
 * process, so the sync variant (~2s) freezes the server and can push a cold
 * start past the host's 5s plugin-activation limit. CLI commands keep the sync one.
 */
export async function discoverModelsFromCursorAgentAsync(deps: CursorAgentRunDeps = {}): Promise<DiscoveredModel[]> {
  const result = await runCursorAgent(["models"], { timeoutMs: MODEL_DISCOVERY_TIMEOUT_MS, ...deps });
  return modelsFromExit(result.status, result.stdout, result.stderr);
}

function modelsFromExit(status: number | null, stdout: string, stderr: string): DiscoveredModel[] {
  if (status !== 0) {
    throw new Error(`cursor-agent models failed (${status}): ${stderr}`);
  }
  const models = parseCursorModelsOutput(stdout);
  if (models.length === 0) {
    throw new Error("No models parsed from cursor-agent output");
  }
  return models;
}

/**
 * Used only when `cursor-agent models` fails. Lists Cursor's own models, the
 * set every paid plan includes: Plus has no Auto and no third-party models.
 */
export function fallbackModels(): DiscoveredModel[] {
  return [
    { id: "composer-2.5", name: "Composer 2.5" },
    { id: "composer-2.5-fast", name: "Composer 2.5 Fast" },
    { id: "grok-4.7-medium", name: "Grok 4.7 Medium" },
    { id: "grok-4.7-high", name: "Grok 4.7 High" },
    { id: "cursor-grok-4.6-high", name: "Grok 4.6" },
    { id: "cursor-grok-4.5-high", name: "Grok 4.5" },
  ];
}
