import { describe, expect, it, afterEach } from "bun:test";
import { resolveCursorAgentBinary, resolveCursorAgentBinaryStrict, type BinaryDeps } from "../../src/utils/binary.js";
import { BinaryNotFoundError } from "../../src/utils/errors.js";

describe("resolveCursorAgentBinaryStrict", () => {
  const cleanup = () => {
    delete process.env.CURSOR_AGENT_EXECUTABLE;
    delete process.env.LOCALAPPDATA;
  };

  afterEach(cleanup);

  it("Scenario A: win32 + binary not found → throws BinaryNotFoundError with path", () => {
    const deps: BinaryDeps = {
      platform: "win32",
      existsSync: () => false,
      homedir: () => "C:\\Users\\test",
      env: { LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" },
    };

    expect(() => resolveCursorAgentBinaryStrict(deps)).toThrow(BinaryNotFoundError);
    
    try {
      resolveCursorAgentBinaryStrict(deps);
    } catch (err) {
      expect(err).toBeInstanceOf(BinaryNotFoundError);
      expect((err as BinaryNotFoundError).attemptedPath).toContain("cursor-agent.cmd");
      expect((err as BinaryNotFoundError).message).toContain("cursor-agent binary not found on Windows");
      expect((err as BinaryNotFoundError).message).toContain("CURSOR_AGENT_EXECUTABLE");
    }
  });

  it("Scenario B: win32 + binary found → returns knownPath (no throw)", () => {
    const deps: BinaryDeps = {
      platform: "win32",
      existsSync: (path) => path.includes("cursor-agent.cmd"),
      homedir: () => "C:\\Users\\test",
      env: { LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" },
    };

    const result = resolveCursorAgentBinaryStrict(deps);
    expect(result).toContain("cursor-agent.cmd");
    expect(result).toStartWith("C:\\Users\\test\\AppData\\Local");
  });

  it("Scenario C: win32 + env override → returns override (no throw)", () => {
    const deps: BinaryDeps = {
      platform: "win32",
      existsSync: () => false,
      homedir: () => "C:\\Users\\test",
      env: {
        LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local",
        CURSOR_AGENT_EXECUTABLE: "C:\\custom\\cursor-agent.cmd",
      },
    };

    const result = resolveCursorAgentBinaryStrict(deps);
    expect(result).toBe("C:\\custom\\cursor-agent.cmd");
  });

  it("Scenario D: linux + binary not found → returns plain resolver value (no throw)", () => {
    const deps: BinaryDeps = {
      platform: "linux",
      existsSync: () => false,
      homedir: () => "/home/test",
      env: {},
    };

    const strictResult = resolveCursorAgentBinaryStrict(deps);
    const plainResult = resolveCursorAgentBinary(deps);
    
    // Both should return the same fallback value
    expect(strictResult).toBe(plainResult);
    expect(strictResult).toBe("cursor-agent");
  });

  it("Scenario D: darwin + binary not found → returns plain resolver value (no throw)", () => {
    const deps: BinaryDeps = {
      platform: "darwin",
      existsSync: () => false,
      homedir: () => "/Users/test",
      env: {},
    };

    const strictResult = resolveCursorAgentBinaryStrict(deps);
    const plainResult = resolveCursorAgentBinary(deps);
    
    expect(strictResult).toBe(plainResult);
    expect(strictResult).toBe("cursor-agent");
  });

  it("Scenario D: linux + binary found → returns known path (no throw)", () => {
    const deps: BinaryDeps = {
      platform: "linux",
      existsSync: (path) => path === "/home/test/.cursor-agent/cursor-agent",
      homedir: () => "/home/test",
      env: {},
    };

    const result = resolveCursorAgentBinaryStrict(deps);
    expect(result).toBe("/home/test/.cursor-agent/cursor-agent");
  });

  it("env override takes precedence on all platforms", () => {
    const deps: BinaryDeps = {
      platform: "linux",
      existsSync: () => false,
      homedir: () => "/home/test",
      env: { CURSOR_AGENT_EXECUTABLE: "/custom/cursor-agent" },
    };

    const result = resolveCursorAgentBinaryStrict(deps);
    expect(result).toBe("/custom/cursor-agent");
  });
});

describe("BinaryNotFoundError", () => {
  it("has correct name and attemptedPath", () => {
    const err = new BinaryNotFoundError("C:\\path\\to\\cursor-agent.cmd");
    expect(err.name).toBe("BinaryNotFoundError");
    expect(err.attemptedPath).toBe("C:\\path\\to\\cursor-agent.cmd");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(BinaryNotFoundError);
  });

  it("message includes path and hint", () => {
    const err = new BinaryNotFoundError("/usr/local/bin/cursor-agent");
    expect(err.message).toContain("/usr/local/bin/cursor-agent");
    expect(err.message).toContain("CURSOR_AGENT_EXECUTABLE");
  });
});
