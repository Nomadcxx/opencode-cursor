import type { DiscoveredModel } from "../cli/model-discovery.js";
import { discoverModelsFromCursorAgent, fallbackModels } from "../cli/model-discovery.js";
import { resolveSdkApiKey } from "../auth.js";
import { listModelsViaRunner } from "../client/sdk-child.js";
import { readStoredAuth } from "../kilo/auth-store.js";
import {
  classifyStoredAuth,
  sdkApiKeyFromCredential,
  type CursorCredential,
} from "../kilo/credential.js";
import { syncOAuthToCursorCliConfig } from "../kilo/cursor-cli-config.js";
import { fetchAvailableModelsFlat, fetchContextLimitIndex } from "./cursor-api-discovery.js";
import { enrichModelsWithContextLimits } from "./context-limits.js";

export type DiscoverModelsResult = {
  models: DiscoveredModel[];
  source: "cursor-agent" | "cursor-api" | "sdk" | "fallback";
  warnings: string[];
};

async function tryCursorAgent(
  credential: CursorCredential | undefined,
  warnings: string[],
): Promise<DiscoveredModel[] | undefined> {
  const accessToken = credential?.kind === "oauth-jwt" ? credential.accessToken : undefined;
  const apiKey = credential?.kind === "sdk-api-key" ? credential.token : undefined;

  if (accessToken) {
    await syncOAuthToCursorCliConfig(accessToken, credential?.kind === "oauth-jwt" ? credential.refreshToken : undefined);
  }

  try {
    const models = discoverModelsFromCursorAgent({ accessToken, apiKey });
    if (models.length > 0) return models;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnings.push(`cursor-agent models failed (${message})`);
  }
  return undefined;
}

async function tryCursorApi(accessToken: string, warnings: string[]): Promise<DiscoveredModel[] | undefined> {
  try {
    const models = await fetchAvailableModelsFlat(accessToken);
    if (models.length > 0) return models;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnings.push(`Cursor AvailableModels API failed (${message})`);
  }
  return undefined;
}

async function trySdk(apiKey: string, warnings: string[]): Promise<DiscoveredModel[] | undefined> {
  try {
    const models = await listModelsViaRunner(apiKey);
    if (models.length > 0) {
      return models.map((model) => ({ id: model.id, name: model.name }));
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnings.push(`SDK model list failed (${message})`);
  }
  return undefined;
}

async function enrichDiscoveredContextLimits(
  models: DiscoveredModel[],
  credential: CursorCredential | undefined,
  warnings: string[],
): Promise<DiscoveredModel[]> {
  const oauthToken = credential?.kind === "oauth-jwt" ? credential.accessToken : undefined;
  let limits = new Map<string, number>();

  if (oauthToken) {
    try {
      limits = await fetchContextLimitIndex(oauthToken);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(`Cursor context limits unavailable (${message})`);
    }
  }

  return enrichModelsWithContextLimits(models, limits);
}

/** Discover models using Kilo auth store, cursor-agent, Cursor API, or SDK. */
export async function discoverModelsAuthenticated(): Promise<DiscoverModelsResult> {
  const warnings: string[] = [];
  const auth = await readStoredAuth();
  const credential = classifyStoredAuth(auth);
  const sdkKey = sdkApiKeyFromCredential(credential) ?? resolveSdkApiKey({ env: process.env });

  const fromAgent = await tryCursorAgent(credential, warnings);
  if (fromAgent) {
    const models = await enrichDiscoveredContextLimits(fromAgent, credential, warnings);
    return { models, source: "cursor-agent", warnings };
  }

  const oauthToken = credential?.kind === "oauth-jwt" ? credential.accessToken : undefined;
  if (oauthToken) {
    const fromApi = await tryCursorApi(oauthToken, warnings);
    if (fromApi) {
      return { models: fromApi, source: "cursor-api", warnings };
    }
  }

  if (sdkKey && looksLikeSdkKey(sdkKey)) {
    const fromSdk = await trySdk(sdkKey, warnings);
    if (fromSdk) {
      const models = enrichModelsWithContextLimits(fromSdk);
      return { models, source: "sdk", warnings };
    }
  }

  if (sdkKey && oauthToken && !looksLikeSdkKey(sdkKey)) {
    // Stored JWT mistaken for SDK key — already tried API above.
  }

  warnings.push("using static fallback model list");
  return { models: fallbackModels(), source: "fallback", warnings };
}

function looksLikeSdkKey(value: string): boolean {
  return /^(sk-|key_)/i.test(value.trim());
}

/** Rename legacy `cursor/foo` config keys to `foo`. */
export function migrateLegacyModelKeys(models: Record<string, unknown>): number {
  let migrated = 0;
  for (const key of Object.keys(models)) {
    if (!key.startsWith("cursor/")) continue;
    const nextKey = key.slice("cursor/".length);
    if (!nextKey || models[nextKey] !== undefined) {
      delete models[key];
      migrated++;
      continue;
    }
    models[nextKey] = models[key];
    delete models[key];
    migrated++;
  }
  return migrated;
}
