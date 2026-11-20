// src/proxy/auth.ts
//
// The local proxy binds a loopback port, so any local account and any web page
// the user visits can reach it. Every request must carry a per-user secret that
// only processes running as the owner can read.

import { randomBytes, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const PROXY_TOKEN_HEADER = "x-open-cursor-token";

const TOKEN_PATTERN = /^[0-9a-f]{64}$/;

/**
 * One location per user, independent of session variables such as
 * XDG_RUNTIME_DIR: OpenCode 1.x routes every window to the shared port from
 * opencode.json, so all of the owner's processes must agree on the token.
 */
export function resolveProxyTokenPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.CURSOR_ACP_HOME_DIR?.trim() || homedir();
  return join(home, ".opencode-cursor", "proxy-token");
}

function readValidToken(path: string): string | null {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(path);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  if (process.platform !== "win32") {
    if ((stat.mode & 0o077) !== 0) return null;
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) return null;
  }
  const token = fs.readFileSync(path, "utf8").trim();
  return TOKEN_PATTERN.test(token) ? token : null;
}

/**
 * Read the owner's proxy token, creating it (mode 0600) on first use. A file
 * that is not a regular file, is readable by others, or is malformed is
 * replaced. Creation goes through a temporary file and link() so concurrent
 * starters never observe a partially written token.
 */
export function loadOrCreateProxyToken(path: string = resolveProxyTokenPath()): string {
  const existing = readValidToken(path);
  if (existing) return existing;

  fs.mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // Drop an unusable file; link() below fails if another process has since created one.
  fs.rmSync(path, { force: true });

  const token = randomBytes(32).toString("hex");
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}`;
  fs.writeFileSync(tmp, token, { mode: 0o600, flag: "wx" });
  try {
    fs.linkSync(tmp, path);
    return token;
  } catch (err: any) {
    if (err?.code !== "EEXIST") throw err;
    // Another process won the race; use its token.
    const winner = readValidToken(path);
    if (!winner) throw new Error(`Proxy token at ${path} is not usable`);
    return winner;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

let cachedToken: { path: string; token: string } | null = null;

/** Process-wide token for the default path; read once. */
export function getProxyToken(): string {
  const path = resolveProxyTokenPath();
  if (cachedToken?.path !== path) {
    cachedToken = { path, token: loadOrCreateProxyToken(path) };
  }
  return cachedToken.token;
}

export type ProxyAuthResult = { ok: true } | { ok: false; status: number; error: string };

function headerValue(value: string | string[] | null | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value ?? undefined;
}

/**
 * Reject browser-originated requests outright, then require the token.
 * Editor processes call the proxy from a server-side fetch with no Origin.
 */
export function authorizeProxyRequest(
  headers: {
    origin?: string | string[] | null;
    token?: string | string[] | null;
  },
  expectedToken: string,
): ProxyAuthResult {
  if (headerValue(headers.origin) !== undefined) {
    return { ok: false, status: 403, error: "Browser requests are not allowed" };
  }
  const supplied = headerValue(headers.token);
  if (!supplied) {
    return { ok: false, status: 401, error: "Missing proxy token" };
  }
  const a = Buffer.from(supplied);
  const b = Buffer.from(expectedToken);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, status: 401, error: "Invalid proxy token" };
  }
  return { ok: true };
}
