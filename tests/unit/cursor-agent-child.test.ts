import { afterEach, describe, expect, it } from "bun:test";
import {
  _resetCursorAgentPoolForTests,
  buildAgentPoolKey,
  isAgentPoolEnabled,
  resolveCursorAgentRunnerPath,
} from "../../src/client/cursor-agent-child.js";

describe("cursor-agent-child", () => {
  afterEach(() => {
    _resetCursorAgentPoolForTests();
    delete process.env.CURSOR_KILO_AGENT_POOL;
    delete process.env.CURSOR_KILO_CURSOR_AGENT_RUNNER_PATH;
  });

  it("is disabled by default", () => {
    expect(isAgentPoolEnabled()).toBe(false);
  });

  it.each([
    ["1", true],
    ["true", true],
    ["on", true],
    ["yes", true],
    ["0", false],
    ["false", false],
  ])("isAgentPoolEnabled(%p) === %p", (value, expected) => {
    process.env.CURSOR_KILO_AGENT_POOL = value;
    expect(isAgentPoolEnabled()).toBe(expected);
  });

  it("buildAgentPoolKey combines workspace and model", () => {
    const keyA = buildAgentPoolKey("/ws", "auto");
    const keyB = buildAgentPoolKey("/ws", "gpt-5");
    const keyC = buildAgentPoolKey("/other", "auto");
    expect(keyA).not.toBe(keyB);
    expect(keyA).not.toBe(keyC);
    expect(keyA).toBe("/ws\0auto");
  });

  it("resolveCursorAgentRunnerPath finds scripts/cursor-agent-runner.mjs", () => {
    const path = resolveCursorAgentRunnerPath(
      "/home/nomadx/opencode-cursor/src/client/cursor-agent-child.ts",
      (candidate) => candidate.endsWith("scripts/cursor-agent-runner.mjs"),
    );
    expect(path).toContain("scripts/cursor-agent-runner.mjs");
  });

  it("resolveCursorAgentRunnerPath honors env override", () => {
    process.env.CURSOR_KILO_CURSOR_AGENT_RUNNER_PATH = "/custom/runner.mjs";
    const path = resolveCursorAgentRunnerPath(
      "/pkg/src/client/cursor-agent-child.ts",
      (candidate) => candidate === "/custom/runner.mjs",
    );
    expect(path).toBe("/custom/runner.mjs");
  });
});
