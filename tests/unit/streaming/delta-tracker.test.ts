import { describe, expect, it } from "bun:test";

import { DeltaTracker, MixedDeltaTracker } from "../../../src/streaming/delta-tracker.js";

describe("DeltaTracker", () => {
  it("returns full text for first event", () => {
    const tracker = new DeltaTracker();

    expect(tracker.nextText("Hello")).toBe("Hello");
  });

  it("returns delta for appended text", () => {
    const tracker = new DeltaTracker();

    expect(tracker.nextText("Hello")).toBe("Hello");
    expect(tracker.nextText("Hello world")).toBe(" world");
  });

  it("returns only new suffix when prefix drifts", () => {
    const tracker = new DeltaTracker();

    expect(tracker.nextText("Hello")).toBe("Hello");
    // "Hello" vs "Hi there" share prefix "H", so delta = "i there"
    expect(tracker.nextText("Hi there")).toBe("i there");
  });

  it("returns empty string for duplicate event", () => {
    const tracker = new DeltaTracker();

    expect(tracker.nextText("Hello world")).toBe("Hello world");
    expect(tracker.nextText("Hello world")).toBe("");
  });

  it("returns empty string when current is substring of previous", () => {
    const tracker = new DeltaTracker();

    expect(tracker.nextText("Hello world")).toBe("Hello world");
    expect(tracker.nextText("Hello")).toBe("");
  });

  it("handles unicode text", () => {
    const tracker = new DeltaTracker();

    expect(tracker.nextText("Hi 😀")).toBe("Hi 😀");
    expect(tracker.nextText("Hi 😀!!")).toBe("!!");
  });

  it("handles trailing whitespace drift without duplication", () => {
    const tracker = new DeltaTracker();

    expect(tracker.nextText("Line one\n")).toBe("Line one\n");
    expect(tracker.nextText("Line one\nLine two")).toBe("Line two");
  });

  it("handles accumulated text with minor formatting change", () => {
    const tracker = new DeltaTracker();

    expect(tracker.nextText("Hello world.")).toBe("Hello world.");
    expect(tracker.nextText("Hello world. Goodbye.")).toBe(" Goodbye.");
  });

  it("does not re-emit full text on mid-stream prefix mismatch", () => {
    const tracker = new DeltaTracker();
    const base = "The quick brown fox jumps over the lazy dog.";

    expect(tracker.nextText(base)).toBe(base);
    // Simulate formatting drift: same text but with an extra space inserted mid-stream
    const drifted = "The quick brown fox  jumps over the lazy dog. And more.";
    const result = tracker.nextText(drifted);
    // Common prefix is "The quick brown fox " (20 chars), delta is " jumps over..."
    expect(result.length).toBeLessThan(drifted.length);
    expect(result).not.toBe(drifted);
  });

  it("tracks thinking separately", () => {
    const tracker = new DeltaTracker();

    expect(tracker.nextThinking("Thought 1")).toBe("Thought 1");
    expect(tracker.nextThinking("Thought 1 + more")).toBe(" + more");
    expect(tracker.nextText("Answer")).toBe("Answer");
  });

  it("resets stored state", () => {
    const tracker = new DeltaTracker();

    expect(tracker.nextText("Hello")).toBe("Hello");
    tracker.reset();
    expect(tracker.nextText("Hello")).toBe("Hello");
  });
});

describe("MixedDeltaTracker", () => {
  it("preserves raw deltas that repeat an emitted prefix", () => {
    const tracker = new MixedDeltaTracker();

    expect(tracker.nextText("**", true)).toBe("**");
    expect(tracker.nextText("Heading", true)).toBe("Heading");
    expect(tracker.nextText("**", true)).toBe("**");
    expect(tracker.nextText("**Heading**")).toBe("");
  });

  it("handles streams that mix delta and accumulated text payloads", () => {
    const tracker = new MixedDeltaTracker();

    expect(tracker.nextText("Hello")).toBe("Hello");
    expect(tracker.nextText(" world")).toBe(" world");
    expect(tracker.nextText("Hello world!")).toBe("!");
  });

  it("tracks thinking separately from assistant text", () => {
    const tracker = new MixedDeltaTracker();

    expect(tracker.nextThinking("Plan")).toBe("Plan");
    expect(tracker.nextThinking(" more")).toBe(" more");
    expect(tracker.nextText("Answer")).toBe("Answer");
    expect(tracker.nextThinking("Plan more carefully")).toBe(" carefully");
  });

  it("preserves repeated raw thinking deltas", () => {
    const tracker = new MixedDeltaTracker();

    expect(tracker.nextThinking("**", true)).toBe("**");
    expect(tracker.nextThinking("Plan", true)).toBe("Plan");
    expect(tracker.nextThinking("**", true)).toBe("**");
    expect(tracker.nextThinking("**Plan**")).toBe("");
  });
});
