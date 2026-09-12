import { describe, expect, it } from "bun:test";
import {
  execFirstStdoutLines,
  resolveGlobMaxLines,
  resolveToolExecMaxBuffer,
} from "../../../src/tools/exec-utils.js";

describe("tools/exec-utils", () => {
  it("defaults exec maxBuffer to 16MB", () => {
    expect(resolveToolExecMaxBuffer({})).toBe(16 * 1024 * 1024);
    expect(resolveToolExecMaxBuffer({ CURSOR_KILO_TOOL_EXEC_MAX_BUFFER: "4096" })).toBe(4096);
  });

  it("collects only the first N stdout lines", async () => {
    const output = await execFirstStdoutLines(
      "node",
      ["-e", "for (let i = 0; i < 100; i++) console.log('line-' + i)"],
      5,
    );
    expect(output.split("\n")).toEqual(["line-0", "line-1", "line-2", "line-3", "line-4"]);
  });

  it("respects glob max lines env override", () => {
    expect(resolveGlobMaxLines({ CURSOR_KILO_GLOB_MAX_LINES: "25" })).toBe(25);
  });
});
