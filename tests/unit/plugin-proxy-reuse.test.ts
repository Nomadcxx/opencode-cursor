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

});
