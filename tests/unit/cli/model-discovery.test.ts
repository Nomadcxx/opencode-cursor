import { describe, expect, it } from "bun:test";
import { parseCursorModelsOutput } from "../../../src/cli/model-discovery.js";

describe("cli/model-discovery", () => {
  it("parses model ids and names from cursor-agent output", () => {
    const output = `
auto - Auto (current) (default)
sonnet-4.5 - Claude 4.5 Sonnet
gpt-5.2 - GPT-5.2
`;

    const models = parseCursorModelsOutput(output);
    expect(models).toEqual([
      { id: "auto", name: "Auto" },
      { id: "sonnet-4.5", name: "Claude 4.5 Sonnet" },
      { id: "gpt-5.2", name: "GPT-5.2" },
    ]);
  });

  it("ignores noise and de-duplicates ids", () => {
    const output = `
\u001b[32mauto - Auto (current)\u001b[0m
Tip: run cursor-agent login
auto - Auto
`;

    const models = parseCursorModelsOutput(output);
    expect(models).toEqual([{ id: "auto", name: "Auto" }]);
  });
});
