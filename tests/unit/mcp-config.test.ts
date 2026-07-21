import { describe, it, expect, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  it("includes agents from agents/ directory", () => {
    const deps = {
      configDir: "/tmp/opencode",
      existsSync: (p: string) => p === "/tmp/opencode/agents",
      readdirSync: () => ["reviewer.md"],
      readFileSync: (p: string) => {
        if (p === "/tmp/opencode/agents/reviewer.md") {
          return "---\nmode: subagent\ndescription: Reviews code\n---\nYou review code.";
        }
        return "{}";
      },
    };

    expect(readSubagentNames(deps)).toEqual(["reviewer"]);
  });

  it("merges json agents with agents/ directory, directory wins on name clash", () => {
    const deps = {
      configJson: JSON.stringify({ agent: { build: { mode: "primary" }, review: { mode: "subagent" } } }),
      configDir: "/tmp/opencode",
      existsSync: (p: string) => p === "/tmp/opencode/agents",
      readdirSync: () => ["review.md"],
      readFileSync: (p: string) => {
        if (p === "/tmp/opencode/agents/review.md") {
          return "---\nmode: subagent\n---\nReview agent.";
        }
        return "{}";
      },
    };

    expect(readSubagentNames(deps)).toEqual(["review"]);
  });

  it("skips disabled markdown agents", () => {
    const deps = {
      configDir: "/tmp/opencode",
      existsSync: (p: string) => p === "/tmp/opencode/agents",
      readdirSync: () => ["hidden.md", "active.md"],
      readFileSync: (p: string) => {
        if (p.endsWith("hidden.md")) return "---\ndisable: true\nmode: subagent\n---\n";
        if (p.endsWith("active.md")) return "---\nmode: subagent\n---\n";
        return "{}";
      },
    };

    expect(readSubagentNames(deps)).toEqual(["active"]);
  });

  it("skips disabled JSON-defined agents", () => {
    const deps = {
      configJson: JSON.stringify({
        agent: {
          build: { mode: "subagent" },
          legacy: { mode: "subagent", disable: true },
        },
      }),
    };

    expect(readSubagentNames(deps)).toEqual(["build"]);
  });

  it("includes agents from the singular agent/ directory", () => {
    const deps = {
      configDir: "/tmp/opencode",
      existsSync: (p: string) => p === "/tmp/opencode/agent",
      readdirSync: () => ["helper.md"],
      readFileSync: () => "---\nmode: subagent\n---\n",
    };

    expect(readSubagentNames(deps)).toEqual(["helper"]);
  });

  it("scans agent directories recursively", () => {
    let recursiveOption: unknown;
    const deps = {
      configDir: "/tmp/opencode",
      existsSync: (p: string) => p === "/tmp/opencode/agents",
      readdirSync: (_p: string, options?: { recursive?: boolean }) => {
        recursiveOption = options;
        return ["team/reviewer.md"];
      },
      readFileSync: () => "---\nmode: subagent\n---\n",
    };

    expect(readSubagentNames(deps)).toEqual(["team/reviewer"]);
    expect(recursiveOption).toEqual({ recursive: true });
  });

  it("recognizes quoted mode values", () => {
    const deps = {
      configDir: "/tmp/opencode",
      existsSync: (p: string) => p === "/tmp/opencode/agents",
      readdirSync: () => ["reviewer.md", "builder.md"],
      readFileSync: (p: string) =>
        p.endsWith("reviewer.md") ? '---\nmode: "subagent"\n---\n' : "---\nmode: primary\n---\n",
    };

    expect(readSubagentNames(deps)).toEqual(["reviewer"]);
  });

  it("disables agents with quoted or yes disable values", () => {
    const deps = {
      configDir: "/tmp/opencode",
      existsSync: (p: string) => p === "/tmp/opencode/agents",
      readdirSync: () => ["hidden.md", "off.md", "active.md"],
      readFileSync: (p: string) => {
        if (p.endsWith("hidden.md")) return '---\ndisable: "true"\nmode: subagent\n---\n';
        if (p.endsWith("off.md")) return "---\ndisable: yes\nmode: subagent\n---\n";
        return "---\nmode: subagent\n---\n";
      },
    };

    expect(readSubagentNames(deps)).toEqual(["active"]);
  });

  it("reads real agent markdown from disk across agent/ and agents/, including nested", () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-agents-"));
    try {
      mkdirSync(join(dir, "agent"), { recursive: true });
      mkdirSync(join(dir, "agents", "team"), { recursive: true });
      writeFileSync(join(dir, "agent", "reviewer.md"), "---\nmode: subagent\n---\nReview.");
      writeFileSync(join(dir, "agents", "team", "builder.md"), '---\nmode: "subagent"\n---\nBuild.');

      // configJson "{}" isolates the JSON side; the directory side uses the real fs.
      const names = readSubagentNames({ configJson: "{}", configDir: dir }).sort();
      expect(names).toEqual(["reviewer", "team/builder"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
