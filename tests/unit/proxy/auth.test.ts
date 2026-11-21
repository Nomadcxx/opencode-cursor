import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  authorizeProxyRequest,
  loadOrCreateProxyToken,
  resolveProxyTokenPath,
} from "../../../src/proxy/auth.js";

const TOKEN = "a".repeat(64);

describe("authorizeProxyRequest", () => {
  const cases: Array<{ name: string; headers: Parameters<typeof authorizeProxyRequest>[0]; status?: number }> = [
    { name: "accepts the matching token", headers: { token: TOKEN } },
    { name: "accepts the first value of a repeated header", headers: { token: [TOKEN, "x"] } },
    { name: "rejects a missing token", headers: {}, status: 401 },
    { name: "rejects an empty token", headers: { token: "" }, status: 401 },
    { name: "rejects a wrong token", headers: { token: "b".repeat(64) }, status: 401 },
    { name: "rejects a token prefix", headers: { token: TOKEN.slice(0, 32) }, status: 401 },
    { name: "rejects a browser origin even with the token", headers: { token: TOKEN, origin: "https://evil.example" }, status: 403 },
    { name: "rejects an opaque null origin", headers: { token: TOKEN, origin: "null" }, status: 403 },
  ];

  for (const c of cases) {
    test(c.name, () => {
      const result = authorizeProxyRequest(c.headers, TOKEN);
      if (c.status === undefined) {
        expect(result.ok).toBe(true);
      } else {
        expect(result.ok).toBe(false);
        expect(result.ok === false && result.status).toBe(c.status);
      }
    });
  }
});

describe("resolveProxyTokenPath", () => {
  test("uses the plugin home directory", () => {
    expect(resolveProxyTokenPath({ CURSOR_ACP_HOME_DIR: "/home/u" })).toBe("/home/u/.opencode-cursor/proxy-token");
  });

  test("ignores session-scoped XDG_RUNTIME_DIR", () => {
    expect(resolveProxyTokenPath({ CURSOR_ACP_HOME_DIR: "/home/u", XDG_RUNTIME_DIR: "/run/user/7" }))
      .toBe("/home/u/.opencode-cursor/proxy-token");
  });
});

describe("loadOrCreateProxyToken", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "open-cursor-token-"));
    path = join(dir, "sub", "proxy-token");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("creates an owner-only token and reuses it", () => {
    const token = loadOrCreateProxyToken(path);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    if (process.platform !== "win32") {
      expect(lstatSync(path).mode & 0o777).toBe(0o600);
    }
    expect(loadOrCreateProxyToken(path)).toBe(token);
  });

  test.skipIf(process.platform === "win32")("replaces a token other accounts can read", () => {
    const first = loadOrCreateProxyToken(path);
    chmodSync(path, 0o644);
    const second = loadOrCreateProxyToken(path);
    expect(second).not.toBe(first);
    expect(lstatSync(path).mode & 0o777).toBe(0o600);
  });

  test("replaces a malformed token", () => {
    loadOrCreateProxyToken(path);
    writeFileSync(path, "short", { mode: 0o600 });
    expect(loadOrCreateProxyToken(path)).toMatch(/^[0-9a-f]{64}$/);
  });

  test.skipIf(process.platform === "win32")("does not follow a planted symlink", () => {
    const target = join(dir, "victim");
    writeFileSync(target, TOKEN, { mode: 0o600 });
    loadOrCreateProxyToken(path);
    rmSync(path);
    symlinkSync(target, path);
    const token = loadOrCreateProxyToken(path);
    expect(token).not.toBe(TOKEN);
    expect(lstatSync(path).isSymbolicLink()).toBe(false);
    expect(readFileSync(target, "utf8")).toBe(TOKEN);
  });
});
