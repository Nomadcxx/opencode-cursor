import { createHash } from "node:crypto";
import { parseStreamJsonLine } from "../streaming/parser.js";
import { extractText, isAssistantText } from "../streaming/types.js";
import type { OpenAiToolCall } from "./tool-loop.js";

export const BRIDGE_JSON_ENV = "CURSOR_ACP_BRIDGE_JSON";

export const BRIDGE_JSON_CONTEXT = `SYSTEM: opencode bridge mode is active.
For file changes through opencode-cursor, read any needed files first, then respond with exactly one JSON object and no prose:
{"name":"write","arguments":{"path":"relative/path","content":"complete file contents"}}
Use this only for a single complete-file write. Otherwise answer normally or use the available tool format.`;

type BridgePromptOptions = {
  allowedToolNames: Set<string>;
  env?: Record<string, string | undefined>;
};

export function isBridgeJsonEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const raw = env[BRIDGE_JSON_ENV];
  if (raw === undefined) {
    return true;
  }

  return !["0", "false", "off", "no", "disabled"].includes(raw.trim().toLowerCase());
}

export function applyBridgeJsonPrompt(prompt: string, options: BridgePromptOptions): string {
  if (!isBridgeJsonEnabled(options.env) || !options.allowedToolNames.has("write")) {
    return prompt;
  }
  if (prompt.includes("opencode bridge mode is active")) {
    return prompt;
  }
  return prompt ? `${BRIDGE_JSON_CONTEXT}\n\n${prompt}` : BRIDGE_JSON_CONTEXT;
}

export function extractBridgeToolCallFromText(
  text: string,
  allowedToolNames: Set<string>,
): OpenAiToolCall | null {
  if (!allowedToolNames.has("write")) {
    return null;
  }

  const jsonText = extractStrictJsonText(text);
  if (!jsonText) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }

  if (!isRecord(parsed) || parsed.name !== "write" || !isRecord(parsed.arguments)) {
    return null;
  }

  const { path, content } = parsed.arguments;
  if (typeof path !== "string" || path.trim().length === 0 || typeof content !== "string") {
    return null;
  }

  return {
    id: `call_bridge_${shortHash(jsonText)}`,
    type: "function",
    function: {
      name: "write",
      arguments: JSON.stringify({ path, content }),
    },
  };
}

export function extractBridgeToolCallFromStreamOutput(
  output: string,
  allowedToolNames: Set<string>,
): OpenAiToolCall | null {
  if (!output || !allowedToolNames.has("write")) {
    return null;
  }

  for (const line of output.split("\n")) {
    const event = parseStreamJsonLine(line);
    if (!event || !isAssistantText(event)) {
      continue;
    }
    const text = extractText(event);
    const toolCall = extractBridgeToolCallFromText(text, allowedToolNames)
      ?? extractBridgeToolCallFromTrailingLine(text, allowedToolNames);
    if (toolCall) {
      return toolCall;
    }
  }

  return null;
}

function extractBridgeToolCallFromTrailingLine(
  text: string,
  allowedToolNames: Set<string>,
): OpenAiToolCall | null {
  const lines = text.trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const lastLine = lines.at(-1);
  if (!lastLine || !lastLine.startsWith("{") || !lastLine.endsWith("}")) {
    return null;
  }

  return extractBridgeToolCallFromText(lastLine, allowedToolNames);
}

function extractStrictJsonText(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }

  const fenced = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i);
  return fenced ? fenced[1].trim() : null;
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
