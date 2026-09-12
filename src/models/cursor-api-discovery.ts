import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import type { DiscoveredModel } from "../cli/model-discovery.js";
import {
  buildContextLimitIndex,
  enrichModelsWithContextLimits,
  parseContextFromDisplayName,
} from "./context-limits.js";

const API_HOST = process.env.CURSOR_API_HOST ?? "api2.cursor.sh";
const API_BASE = process.env.CURSOR_API_BASE_URL ?? `https://${API_HOST}`;
const CONNECT_PROTOCOL_VERSION = "1";

function obfuscate(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes);
  let a = 165;
  for (let i = 0; i < out.length; i++) {
    out[i] = ((out[i]! ^ a) + i) & 0xff;
    a = out[i]!;
  }
  return out;
}

function createCursorChecksumHeader(machineId: string, macMachineId?: string): string {
  const n = Math.floor(Date.now() / 1_000_000);
  const ts = new Uint8Array([
    (n >> 40) & 0xff,
    (n >> 32) & 0xff,
    (n >> 24) & 0xff,
    (n >> 16) & 0xff,
    (n >> 8) & 0xff,
    n & 0xff,
  ]);
  const prefix = Buffer.from(obfuscate(ts)).toString("base64").replace(/=+$/, "");
  return macMachineId ? `${prefix}${machineId}/${macMachineId}` : `${prefix}${machineId}`;
}

function stableMachineId(): string {
  for (const path of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
    try {
      const value = readFileSync(path, "utf8").trim();
      if (value) return createHash("sha256").update(value, "utf8").digest("hex");
    } catch {
      // continue
    }
  }
  return createHash("sha256").update(hostname(), "utf8").digest("hex");
}

function resolveClientVersion(): string {
  const env = process.env.CURSOR_CLIENT_VERSION?.trim();
  if (env && /^cli-/i.test(env)) return env;
  return "cli-2025.08.20-abc";
}

type RawVariant = {
  displayName?: string;
  display_name?: string;
  isMaxMode?: boolean;
  is_max_mode?: boolean;
  parameterValues?: Array<{ id?: string; value?: unknown }>;
  parameter_values?: Array<{ id?: string; value?: unknown }>;
};

type RawModel = {
  name?: string;
  clientDisplayName?: string;
  client_display_name?: string;
  contextTokenLimit?: unknown;
  context_token_limit?: unknown;
  contextTokenLimitForMaxMode?: unknown;
  context_token_limit_for_max_mode?: unknown;
  variants?: RawVariant[];
};

function variantParams(variant: RawVariant): Array<{ id: string; value: string }> {
  const raw = variant.parameterValues ?? variant.parameter_values ?? [];
  return raw
    .map((param) => ({ id: String(param.id ?? ""), value: String(param.value ?? "") }))
    .filter((param) => param.id.length > 0);
}

function flattenModel(entry: RawModel): DiscoveredModel[] {
  const baseId = entry.name?.trim();
  if (!baseId) return [];

  const baseName = entry.clientDisplayName ?? entry.client_display_name ?? baseId;
  const baseContext = readEntryContextLimit(entry, false);
  const variants = entry.variants ?? [];
  if (variants.length === 0) {
    return [{
      id: baseId,
      name: String(baseName),
      ...(baseContext !== undefined ? { contextLimit: baseContext } : {}),
    }];
  }

  const out: DiscoveredModel[] = [];
  const seen = new Set<string>();

  const push = (id: string, name: string, contextLimit?: number) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    out.push(contextLimit !== undefined ? { id, name, contextLimit } : { id, name });
  };

  push(baseId, String(baseName), baseContext);

  for (const variant of variants) {
    const params = variantParams(variant);
    const effort = params.find((p) => p.id === "effort" || p.id === "reasoning")?.value;
    const isFast = params.find((p) => p.id === "fast")?.value === "true";
    let id = baseId;
    if (effort) id += `-${effort}`;
    if (isFast) id += "-fast";
    const name = variant.displayName ?? variant.display_name ?? id;
    const useMaxMode = variant.isMaxMode === true || variant.is_max_mode === true;
    const contextLimit = readEntryContextLimit(entry, useMaxMode)
      ?? parseContextFromDisplayName(String(name));
    push(id, String(name), contextLimit);
  }

  return out;
}

function readPositiveInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.round(value);
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return Math.round(parsed);
  }
  return undefined;
}

function readEntryContextLimit(entry: RawModel, useMaxMode: boolean): number | undefined {
  const standard = readPositiveInt(entry.contextTokenLimit ?? entry.context_token_limit);
  const maxMode = readPositiveInt(
    entry.contextTokenLimitForMaxMode ?? entry.context_token_limit_for_max_mode,
  );
  if (useMaxMode) return maxMode ?? standard;
  return standard ?? maxMode;
}

export async function fetchAvailableModelsRaw(accessToken: string): Promise<Record<string, unknown>> {
  const machineId = stableMachineId();
  const url = `${API_BASE.replace(/\/$/, "")}/aiserver.v1.AiService/AvailableModels`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "connect-protocol-version": CONNECT_PROTOCOL_VERSION,
      "content-type": "application/json",
      accept: "application/json",
      "x-cursor-client-type": "cli",
      "x-cursor-client-version": resolveClientVersion(),
      "x-cursor-checksum": createCursorChecksumHeader(machineId),
      "x-ghost-mode": "true",
      "x-request-id": randomUUID(),
    },
    body: JSON.stringify({
      includeLongContextModels: true,
      useModelParameters: true,
      useCloudAgentEffortModes: true,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`AvailableModels failed: ${res.status} ${res.statusText}${text ? ` - ${text.slice(0, 200)}` : ""}`);
  }

  return (await res.json()) as Record<string, unknown>;
}

export async function fetchContextLimitIndex(accessToken: string): Promise<Map<string, number>> {
  const raw = await fetchAvailableModelsRaw(accessToken);
  return buildContextLimitIndex(raw);
}

export async function fetchAvailableModelsFlat(accessToken: string): Promise<DiscoveredModel[]> {
  const raw = await fetchAvailableModelsRaw(accessToken);
  const entries = Array.isArray(raw.models) ? raw.models as RawModel[] : [];
  const models: DiscoveredModel[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    for (const model of flattenModel(entry)) {
      if (seen.has(model.id)) continue;
      seen.add(model.id);
      models.push(model);
    }
  }

  if (models.length === 0) {
    throw new Error("AvailableModels returned no models");
  }

  return enrichModelsWithContextLimits(models, buildContextLimitIndex(raw));
}
