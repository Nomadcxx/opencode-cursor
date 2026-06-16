import { describe, it, expect, beforeEach } from "bun:test";
import { readSubagentNames, _resetSubagentCache } from "../../src/mcp/config.js";

describe("readSubagentNames", () => {
  beforeEach(() => {
    _resetSubagentCache();
  });
  it("returns only mode:subagent agents when some exist", () => {
    const config = JSON.stringify({
      agent: {
        build: { mode: "primary", model: "openai/gpt-5" },
        codemachine: { mode: "subagent", model: "kimi/kimi-k2" },
        review: { mode: "subagent", model: "google/gemini" },
      },
    });
    expect(readSubagentNames({ configJson: config })).toEqual(["codemachine", "review"]);
  });

  it("returns all agents when none have mode:subagent", () => {
    const config = JSON.stringify({
      agent: {
        build: { mode: "primary", model: "openai/gpt-5" },
        plan: { mode: "primary", model: "zai/glm" },
      },
    });
    expect(readSubagentNames({ configJson: config })).toEqual(["build", "plan"]);
  });

  it("returns general-purpose when agent section is empty object", () => {
    const config = JSON.stringify({ agent: {} });
    expect(readSubagentNames({ configJson: config })).toEqual(["general-purpose"]);
  });

  it("returns general-purpose when agent section is absent", () => {
    const config = JSON.stringify({ mcp: {} });
    expect(readSubagentNames({ configJson: config })).toEqual(["general-purpose"]);
  });

  it("returns general-purpose when config file is unreadable", () => {
    expect(readSubagentNames({ configJson: undefined, existsSync: () => false })).toEqual(["general-purpose"]);
  });

  it("returns general-purpose when config is malformed JSON", () => {
    expect(readSubagentNames({ configJson: "{ bad json" })).toEqual(["general-purpose"]);
  });

  it("caches filesystem results across calls", () => {
    let readCount = 0;
    const deps = {
      existsSync: () => true,
      readFileSync: () => {
        readCount++;
        return JSON.stringify({ agent: { bot: { mode: "subagent" } } });
      },
      env: { OPENCODE_CONFIG: "/tmp/test.json" } as NodeJS.ProcessEnv,
    };

    const first = readSubagentNames(deps);
    const second = readSubagentNames(deps);
    expect(first).toEqual(["bot"]);
    expect(second).toEqual(["bot"]);
    expect(readCount).toBe(1);
  });

  it("bypasses cache when configJson is provided", () => {
    const config1 = JSON.stringify({ agent: { a: { mode: "subagent" } } });
    const config2 = JSON.stringify({ agent: { b: { mode: "subagent" } } });

    expect(readSubagentNames({ configJson: config1 })).toEqual(["a"]);
    expect(readSubagentNames({ configJson: config2 })).toEqual(["b"]);
  });

  it("returns fresh data after cache reset", () => {
    let callNum = 0;
    const deps = {
      existsSync: () => true,
      readFileSync: () => {
        callNum++;
        const name = callNum === 1 ? "first" : "second";
        return JSON.stringify({ agent: { [name]: { mode: "subagent" } } });
      },
      env: { OPENCODE_CONFIG: "/tmp/test.json" } as NodeJS.ProcessEnv,
    };

    expect(readSubagentNames(deps)).toEqual(["first"]);
    _resetSubagentCache();
    expect(readSubagentNames(deps)).toEqual(["second"]);
  });
});
