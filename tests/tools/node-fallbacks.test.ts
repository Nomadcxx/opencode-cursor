// tests/tools/node-fallbacks.test.ts
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { nodeFallbackGrep, nodeFallbackGlob } from "../../src/tools/defaults.js";

let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "fallback-test-"));

  // Create structure:
  // tmpDir/
  //   a.ts          (contains "hello world")
  //   b.ts          (contains "goodbye world")
  //   sub/
  //     c.ts        (contains "hello again")
  //     d.js        (contains "irrelevant")
  //   node_modules/
  //     pkg/
  //       e.ts      (contains "hello hidden" — should be SKIPPED)

  writeFileSync(join(tmpDir, "a.ts"), "hello world\nfoo bar\n");
  writeFileSync(join(tmpDir, "b.ts"), "goodbye world\n");
  mkdirSync(join(tmpDir, "sub"));
  writeFileSync(join(tmpDir, "sub", "c.ts"), "hello again\n");
  writeFileSync(join(tmpDir, "sub", "d.js"), "irrelevant\n");
  mkdirSync(join(tmpDir, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(tmpDir, "node_modules", "pkg", "e.ts"), "hello hidden\n");
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// --- nodeFallbackGrep ---

describe("nodeFallbackGrep", () => {
  test("finds match in a single file", async () => {
    const result = await nodeFallbackGrep("hello", join(tmpDir, "a.ts"));
    expect(result).toContain("hello world");
    expect(result).toContain("a.ts:1:");
  });

  test("finds matches across directory tree", async () => {
    const result = await nodeFallbackGrep("hello", tmpDir);
    expect(result).toContain("a.ts");
    expect(result).toContain("sub");
    // Both a.ts and sub/c.ts contain "hello"
    const lines = result.split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(2);
  });

  test("returns No matches found when pattern does not match", async () => {
    const result = await nodeFallbackGrep("zzznomatch", tmpDir);
    expect(result).toBe("No matches found");
  });

  test("returns Invalid regex pattern for bad regex", async () => {
    const result = await nodeFallbackGrep("[unclosed", tmpDir);
    expect(result).toBe("Invalid regex pattern");
  });

  test("include filter restricts to matching filenames", async () => {
    const result = await nodeFallbackGrep("hello", tmpDir, "*.ts");
    // Should match a.ts and sub/c.ts but NOT sub/d.js
    expect(result).not.toContain("d.js");
    expect(result).toContain(".ts");
  });

  test("skips node_modules directory", async () => {
    const result = await nodeFallbackGrep("hello", tmpDir);
    // e.ts inside node_modules should NOT appear
    expect(result).not.toContain("node_modules");
  });

  test("returns Path not found for non-existent path", async () => {
    const result = await nodeFallbackGrep("hello", join(tmpDir, "nonexistent"));
    expect(result).toBe("Path not found");
  });
});

// --- nodeFallbackGlob ---

describe("nodeFallbackGlob", () => {
  test("*.ts pattern matches only .ts files in root", async () => {
    const result = await nodeFallbackGlob("*.ts", tmpDir);
    const files = result.split("\n").filter(Boolean);
    expect(files.some(f => f.endsWith("a.ts"))).toBe(true);
    expect(files.some(f => f.endsWith("b.ts"))).toBe(true);
    // d.js should NOT appear
    expect(files.some(f => f.endsWith("d.js"))).toBe(false);
  });

  test("**/*.ts pattern matches .ts files in subdirectories", async () => {
    const result = await nodeFallbackGlob("**/*.ts", tmpDir);
    const files = result.split("\n").filter(Boolean);
    expect(files.some(f => f.includes("sub") && f.endsWith("c.ts"))).toBe(true);
  });

  test("returns No files found when pattern does not match", async () => {
    const result = await nodeFallbackGlob("*.xyz", tmpDir);
    expect(result).toBe("No files found");
  });

  test("skips node_modules directory", async () => {
    const result = await nodeFallbackGlob("**/*.ts", tmpDir);
    expect(result).not.toContain("node_modules");
  });

  test("returns No files found for non-existent search path", async () => {
    const result = await nodeFallbackGlob("*.ts", join(tmpDir, "nonexistent"));
    expect(result).toBe("No files found");
  });
});
