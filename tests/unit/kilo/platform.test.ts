import { describe, expect, it } from "bun:test";
import { parseConfigJson, stripJsoncComments, stripJsoncTrailingCommas } from "../../../src/kilo/platform.js";

describe("kilo/platform parseConfigJson", () => {
  it("preserves https:// URLs when stripping line comments", () => {
    const raw = `{
  "$schema": "https://app.kilo.ai/config.json",
  "agent": {
    "code": {
      // "top_p": 0.8,
      "min_p": 0.15
    }
  }
}`;

    const parsed = parseConfigJson(raw);
    expect(parsed?.$schema).toBe("https://app.kilo.ai/config.json");
    expect((parsed?.agent as any)?.code?.min_p).toBe(0.15);
    expect(stripJsoncComments(raw)).toContain("https://app.kilo.ai/config.json");
  });

  it("strips block comments outside strings", () => {
    const raw = `{
  /* block */
  "enabled": true
}`;
    expect(parseConfigJson(raw)?.enabled).toBe(true);
  });

  it("allows trailing commas in arrays and objects", () => {
    const raw = `{
  "plugin": [
    "./plugin/kilo-with-cursor-plugin",
  ],
  "provider": {
    "cursor": {
      "models": {},
    },
  },
}`;
    const parsed = parseConfigJson(raw);
    expect(parsed?.plugin).toEqual(["./plugin/kilo-with-cursor-plugin"]);
    expect(stripJsoncTrailingCommas(raw)).not.toContain(",\n  ]");
  });
});
