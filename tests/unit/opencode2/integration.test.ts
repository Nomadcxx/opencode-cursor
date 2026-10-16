import { describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { applyCursorIntegration, resolveLoginScriptPath } from "../../../src/opencode2/integration.js";

const LOGIN_SCRIPT = resolve(import.meta.dir, "../../../scripts/cursor-agent-login.mjs");

describe("OpenCode 2.0 Cursor integration", () => {
  it("resolves the login script from source and bundled layouts", () => {
    const has = (path: string) => path === LOGIN_SCRIPT;
    expect(resolveLoginScriptPath(resolve(import.meta.dir, "../../../src/opencode2/integration.ts"), has)).toBe(LOGIN_SCRIPT);
    expect(resolveLoginScriptPath(resolve(import.meta.dir, "../../../dist/plugin-entry.js"), has)).toBe(LOGIN_SCRIPT);
    expect(resolveLoginScriptPath("/nowhere/src/opencode2/integration.ts", () => false)).toBeUndefined();
  });

  it("offers cursor-agent login before the API key and env methods", () => {
    const methods: any[] = [];
    applyCursorIntegration({ update: () => {}, method: { update: (input) => methods.push(input.method) } });

    expect(methods.map((method) => method.type)).toEqual(["command", "key", "env"]);
    const [login] = methods;
    expect(login.id).toBe("cursor-agent-login");
    expect(login.command[1]).toBe(LOGIN_SCRIPT);
    expect(existsSync(login.command[1])).toBe(true);
  });

  it("keeps key and env methods when the host rejects command methods", () => {
    const methods: any[] = [];
    applyCursorIntegration({
      update: () => {},
      method: {
        update: (input) => {
          if (input.method.type === "command") throw new Error("unknown method type");
          methods.push(input.method);
        },
      },
    });
    expect(methods.map((method) => method.type)).toEqual(["key", "env"]);
  });
});

describe("cursor-agent-login.mjs", () => {
  function runWithFakeAgent(body: string) {
    const dir = mkdtempSync(join(tmpdir(), "open-cursor-login-"));
    const agent = join(dir, "cursor-agent");
    writeFileSync(agent, `#!/usr/bin/env node\n${body}\n`, "utf8");
    chmodSync(agent, 0o755);
    try {
      return spawnSync(process.env.CURSOR_ACP_NODE_BIN || "node", [LOGIN_SCRIPT, agent], { encoding: "utf8" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it.skipIf(process.platform === "win32")("sends login output to stderr and prints only the placeholder credential", () => {
    const result = runWithFakeAgent(
      `if (process.argv[2] !== "login") process.exit(9);\nconsole.log("Open a browser and navigate to this link: https://cursor.com/login");`,
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("cursor-agent\n");
    expect(result.stderr).toContain("https://cursor.com/login");
  });

  it.skipIf(process.platform === "win32")("fails without a credential when cursor-agent login fails", () => {
    const result = runWithFakeAgent(`console.log("Login cancelled"); process.exit(3);`);
    expect(result.status).toBe(3);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Login cancelled");
  });

  it.skipIf(process.platform === "win32")("stops cursor-agent login when the login is cancelled", async () => {
    const dir = mkdtempSync(join(tmpdir(), "open-cursor-login-cancel-"));
    const agent = join(dir, "cursor-agent");
    const marker = join(dir, "agent-exited");
    writeFileSync(
      agent,
      `#!/usr/bin/env node\nconst fs = require("node:fs");\n` +
        `process.on("SIGTERM", () => { fs.writeFileSync(${JSON.stringify(marker)}, "term"); process.exit(0); });\n` +
        `console.log("waiting for browser");\nsetInterval(() => {}, 1000);\n`,
      "utf8",
    );
    chmodSync(agent, 0o755);
    try {
      const login = spawn(process.env.CURSOR_ACP_NODE_BIN || "node", [LOGIN_SCRIPT, agent], { stdio: ["ignore", "pipe", "pipe"] });
      await new Promise<void>((done) => login.stderr.on("data", (chunk) => {
        if (String(chunk).includes("waiting for browser")) done();
      }));
      const exited = new Promise<number | null>((done) => login.on("close", done));
      login.kill("SIGTERM");
      expect(await exited).not.toBe(0);
      for (let i = 0; i < 50 && !existsSync(marker); i++) await new Promise((r) => setTimeout(r, 20));
      expect(existsSync(marker)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 10_000);
});
