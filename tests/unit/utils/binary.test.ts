// tests/unit/utils/binary.test.ts
import { describe, test, expect } from "bun:test";
import { resolveCursorAgentBinary } from "../../../src/utils/binary.js";

const neverExists = () => false;

describe("resolveCursorAgentBinary", () => {
  test("env override takes priority and skips filesystem checks", () => {
    const result = resolveCursorAgentBinary({
      env: { CURSOR_AGENT_EXECUTABLE: "/custom/cursor-agent" },
      existsSync: neverExists,
    });
    expect(result).toBe("/custom/cursor-agent");
  });

  test("empty env override falls through to platform logic", () => {
    const result = resolveCursorAgentBinary({
      platform: "linux",
      env: { CURSOR_AGENT_EXECUTABLE: "" },
      existsSync: neverExists,
      homedir: () => "/home/user",
    });
    expect(result).toBe("cursor-agent");
  });

  test("win32: known path exists -> returns full .cmd path", () => {
    const result = resolveCursorAgentBinary({
      platform: "win32",
      env: { LOCALAPPDATA: "C:\\Users\\user\\AppData\\Local" },
      existsSync: (p) => p.endsWith("cursor-agent.cmd"),
      homedir: () => "C:\\Users\\user",
    });
    expect(result).toBe("C:\\Users\\user\\AppData\\Local\\cursor-agent\\cursor-agent.cmd");
  });

  test("win32: known path missing -> falls back to bare cursor-agent.cmd", () => {
    const result = resolveCursorAgentBinary({
      platform: "win32",
      env: { LOCALAPPDATA: "C:\\Users\\user\\AppData\\Local" },
      existsSync: neverExists,
      homedir: () => "C:\\Users\\user",
    });
    expect(result).toBe("cursor-agent.cmd");
  });

  test("win32: LOCALAPPDATA missing -> constructs from homedir, falls back to bare", () => {
    const result = resolveCursorAgentBinary({
      platform: "win32",
      env: {},
      existsSync: neverExists,
      homedir: () => "C:\\Users\\user",
    });
    expect(result).toBe("cursor-agent.cmd");
  });

  test("linux: first known path exists -> returns ~/.cursor-agent path", () => {
    const result = resolveCursorAgentBinary({
      platform: "linux",
      env: {},
      existsSync: (p) => p.includes(".cursor-agent"),
      homedir: () => "/home/user",
    });
    expect(result).toBe("/home/user/.cursor-agent/cursor-agent");
  });

  test("linux: first missing, second exists -> returns /usr/local/bin path", () => {
    const result = resolveCursorAgentBinary({
      platform: "linux",
      env: {},
      existsSync: (p) => p === "/usr/local/bin/cursor-agent",
      homedir: () => "/home/user",
    });
    expect(result).toBe("/usr/local/bin/cursor-agent");
  });

  test("linux: neither path exists -> falls back to bare cursor-agent", () => {
    const result = resolveCursorAgentBinary({
      platform: "linux",
      env: {},
      existsSync: neverExists,
      homedir: () => "/home/user",
    });
    expect(result).toBe("cursor-agent");
  });

  test("darwin: neither path exists -> falls back to cursor-agent (not .cmd)", () => {
    const result = resolveCursorAgentBinary({
      platform: "darwin",
      env: {},
      existsSync: neverExists,
      homedir: () => "/Users/user",
    });
    expect(result).toBe("cursor-agent");
  });
});
