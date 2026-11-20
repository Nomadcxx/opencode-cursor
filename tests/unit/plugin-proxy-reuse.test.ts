import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fetchProxyHealthWithTimeout,
  isReusableProxyHealthPayload,
  normalizeWorkspaceForCompare,
  probeReusableProxy,
} from "../../src/plugin.js";
import { getProxyToken, newProxyChallenge, proxyHealthProof } from "../../src/proxy/auth.js";

const homeDir = mkdtempSync(join(tmpdir(), "open-cursor-reuse-"));
const previousHomeDir = process.env.CURSOR_ACP_HOME_DIR;
process.env.CURSOR_ACP_HOME_DIR = homeDir;

afterAll(() => {
  if (previousHomeDir === undefined) delete process.env.CURSOR_ACP_HOME_DIR;
  else process.env.CURSOR_ACP_HOME_DIR = previousHomeDir;
  rmSync(homeDir, { recursive: true, force: true });
});

function proofFor(challenge: string, workspace: string, backend = "auto"): string {
  return proxyHealthProof(getProxyToken(), challenge, normalizeWorkspaceForCompare(workspace), backend);
}

describe("proxy health reuse guard", () => {
  const workspace = "/tmp/project";

  test("rejects payloads without ok=true", () => {
    const challenge = newProxyChallenge();
    expect(isReusableProxyHealthPayload(null, workspace, challenge)).toBe(false);
    expect(isReusableProxyHealthPayload({ ok: false }, workspace, challenge)).toBe(false);
  });

  test("rejects proxies that predate token auth", () => {
    const challenge = newProxyChallenge();
    expect(isReusableProxyHealthPayload({ ok: true, workspaceDirectory: workspace, backendPreference: "auto" }, workspace, challenge)).toBe(false);
  });

  test("accepts a proof of the owner's token for this workspace and backend", () => {
    const challenge = newProxyChallenge();
    expect(isReusableProxyHealthPayload({ ok: true, tokenAuth: true, proof: proofFor(challenge, workspace) }, workspace, challenge)).toBe(true);
  });

  test("rejects a proof for another challenge, workspace or backend", () => {
    const challenge = newProxyChallenge();
    const payload = (proof: string) => ({ ok: true, tokenAuth: true, proof });
    expect(isReusableProxyHealthPayload(payload(proofFor(newProxyChallenge(), workspace)), workspace, challenge)).toBe(false);
    expect(isReusableProxyHealthPayload(payload(proofFor(challenge, "/tmp/other-project")), workspace, challenge)).toBe(false);
    expect(isReusableProxyHealthPayload(payload(proofFor(challenge, workspace, "sdk")), workspace, challenge)).toBe(false);
    expect(isReusableProxyHealthPayload({ ok: true, tokenAuth: true }, workspace, challenge)).toBe(false);
  });

  test("normalizeWorkspaceForCompare produces consistent results for the same input", () => {
    const a = normalizeWorkspaceForCompare(process.cwd());
    expect(normalizeWorkspaceForCompare(process.cwd())).toBe(a);
    expect(a.length).toBeGreaterThan(0);
  });

  test("a process squatting the shared port never receives the token", async () => {
    const seen: Array<Record<string, string | string[] | undefined>> = [];
    const squatter = createServer((req, res) => {
      seen.push(req.headers);
      res.setHeader("content-type", "application/json");
      // Echo whatever a legacy proxy would say, plus a guessed proof.
      res.end(JSON.stringify({ ok: true, tokenAuth: true, workspaceDirectory: workspace, backendPreference: "auto", proof: "0".repeat(64) }));
    });
    await new Promise<void>((resolve) => squatter.listen(0, "127.0.0.1", resolve));
    const { port } = squatter.address() as { port: number };
    try {
      expect(await probeReusableProxy(`http://127.0.0.1:${port}/health`, workspace)).toBe(false);
      expect(seen.length).toBe(1);
      const token = getProxyToken();
      for (const value of Object.values(seen[0])) {
        expect(String(value)).not.toContain(token);
      }
      expect(seen[0]["x-open-cursor-token"]).toBeUndefined();
      expect(seen[0]["x-open-cursor-challenge"]).toMatch(/^[0-9a-f]{32}$/);
    } finally {
      squatter.close();
    }
  });

  test("aborts hanging proxy health checks", async () => {
    const originalFetch = globalThis.fetch;
    let aborted = false;

    globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("http://127.0.0.1:32124/health");
      const signal = init?.signal;
      expect(signal).toBeDefined();

      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new DOMException("Aborted", "AbortError"));
        });
      });
    }) as typeof fetch;

    try {
      const result = await fetchProxyHealthWithTimeout("http://127.0.0.1:32124/health", 5);

      expect(result).toBeNull();
      expect(aborted).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
