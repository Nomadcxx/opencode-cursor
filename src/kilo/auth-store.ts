import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Auth } from "@kilocode/sdk";
import { KILO_PROVIDER_ID } from "./platform.js";

export type StoredAuth = Auth;

function kiloGlobalDataDir(): string {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  if (process.env.XDG_DATA_HOME) {
    return join(process.env.XDG_DATA_HOME, "kilo");
  }
  return join(home, ".local", "share", "kilo");
}

export function asStoredAuth(value: unknown): StoredAuth | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;

  if (record.type === "oauth" && typeof record.access === "string") {
    return value as StoredAuth;
  }

  if (record.type === "api" && typeof record.key === "string") {
    return value as StoredAuth;
  }

  return undefined;
}

/** Read provider credentials from Kilo's global auth.json (or KILO_AUTH_CONTENT in tests). */
export async function readStoredAuth(
  providerId: string = KILO_PROVIDER_ID,
): Promise<StoredAuth | undefined> {
  if (process.env.KILO_AUTH_CONTENT) {
    try {
      const data = JSON.parse(process.env.KILO_AUTH_CONTENT) as Record<string, unknown>;
      return asStoredAuth(data[providerId]);
    } catch {
      return undefined;
    }
  }

  const filePath = join(kiloGlobalDataDir(), "auth.json");
  try {
    const raw = await readFile(filePath, "utf8");
    const data = JSON.parse(raw) as Record<string, unknown>;
    return asStoredAuth(data[providerId]);
  } catch {
    return undefined;
  }
}
