import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getCursorAgentAuthFilePaths,
  syncOAuthToCursorAgentAuth,
} from "../../../src/kilo/cursor-cli-config.js";

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_XDG = process.env.XDG_CONFIG_HOME;
const ORIGINAL_KILO_HOME = process.env.CURSOR_KILO_HOME_DIR;

describe("syncOAuthToCursorAgentAuth", () => {
  let testHome = "";

  beforeEach(() => {
    testHome = mkdtempSync(join(tmpdir(), "cursor-auth-sync-"));
    process.env.HOME = testHome;
    process.env.XDG_CONFIG_HOME = join(testHome, ".config");
    process.env.CURSOR_KILO_HOME_DIR = testHome;
  });

  afterEach(() => {
    if (ORIGINAL_HOME === undefined) delete process.env.HOME;
    else process.env.HOME = ORIGINAL_HOME;
    if (ORIGINAL_XDG === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = ORIGINAL_XDG;
    if (ORIGINAL_KILO_HOME === undefined) delete process.env.CURSOR_KILO_HOME_DIR;
    else process.env.CURSOR_KILO_HOME_DIR = ORIGINAL_KILO_HOME;
    rmSync(testHome, { recursive: true, force: true });
  });

  it("targets auth.json, not cli-config.json", () => {
    const paths = getCursorAgentAuthFilePaths();
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.every((path) => path.endsWith("auth.json"))).toBe(true);
    expect(paths.some((path) => path.includes("cli-config.json"))).toBe(false);
  });

  it("writes tokens to ~/.config/cursor/auth.json and preserves apiKey", async () => {
    const authPath = join(testHome, ".config", "cursor", "auth.json");
    mkdirSync(join(testHome, ".config", "cursor"), { recursive: true });
    writeFileSync(authPath, JSON.stringify({ apiKey: "key_keep" }));

    await syncOAuthToCursorAgentAuth("access-token", "refresh-token");

    expect(existsSync(authPath)).toBe(true);
    const written = JSON.parse(readFileSync(authPath, "utf8")) as Record<string, unknown>;
    expect(written.accessToken).toBe("access-token");
    expect(written.refreshToken).toBe("refresh-token");
    expect(written.apiKey).toBe("key_keep");
    expect(existsSync(join(testHome, ".config", "cursor", "cli-config.json"))).toBe(false);
  });
});
