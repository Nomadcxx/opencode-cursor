import { describe, expect, test } from "bun:test";
import { isReusableProxyHealthPayload, normalizeWorkspaceForCompare } from "../../src/plugin.js";

describe("proxy health reuse guard", () => {
  test("rejects payloads without ok=true", () => {
    expect(isReusableProxyHealthPayload(null, "/tmp/project")).toBe(false);
    expect(isReusableProxyHealthPayload({ ok: false }, "/tmp/project")).toBe(false);
  });

  test("rejects payloads without workspace identity", () => {
    expect(isReusableProxyHealthPayload({ ok: true }, "/tmp/project")).toBe(false);
    expect(isReusableProxyHealthPayload({ ok: true, workspaceDirectory: "" }, "/tmp/project")).toBe(false);
  });

  test("accepts matching workspace identity", () => {
    const workspace = "/tmp/project";
    expect(isReusableProxyHealthPayload({ ok: true, workspaceDirectory: workspace }, workspace)).toBe(true);
  });

  test("rejects mismatched workspace identity", () => {
    expect(
      isReusableProxyHealthPayload(
        { ok: true, workspaceDirectory: "/tmp/other-project" },
        "/tmp/project",
      ),
    ).toBe(false);
  });

  test("normalizes paths deterministically for comparisons", () => {
    const normalized = normalizeWorkspaceForCompare("./tests/../tests");
    expect(typeof normalized).toBe("string");
    expect(normalized.length).toBeGreaterThan(0);
  });

  test("normalizeWorkspaceForCompare produces consistent results for the same input", () => {
    // The win32 toLowerCase() branch cannot be exercised from Linux CI (process.platform !== "win32").
    // This test validates the cross-platform contract: same path → same normalized form.
    const workspace = process.cwd();
    const a = normalizeWorkspaceForCompare(workspace);
    const b = normalizeWorkspaceForCompare(workspace);
    expect(a).toBe(b);
    expect(typeof a).toBe("string");
    expect(a.length).toBeGreaterThan(0);
  });

  test("rejects workspace mismatch after normalisation", () => {
    expect(
      isReusableProxyHealthPayload(
        { ok: true, workspaceDirectory: "/tmp/project-a" },
        "/tmp/project-b",
      ),
    ).toBe(false);
  });

});
