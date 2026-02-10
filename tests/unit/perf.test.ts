import { describe, expect, it } from "bun:test";

import { RequestPerf } from "../../src/utils/perf.js";

describe("RequestPerf", () => {
  it("records request:start on construction", () => {
    const perf = new RequestPerf("test-1");
    const markers = perf.getMarkers();
    expect(markers.length).toBe(1);
    expect(markers[0].name).toBe("request:start");
    expect(markers[0].ts).toBeGreaterThan(0);
  });

  it("records additional markers", () => {
    const perf = new RequestPerf("test-2");
    perf.mark("spawn");
    perf.mark("first-token");
    perf.mark("request:done");
    const markers = perf.getMarkers();
    expect(markers.length).toBe(4);
    expect(markers.map((m) => m.name)).toEqual([
      "request:start",
      "spawn",
      "first-token",
      "request:done",
    ]);
  });

  it("tracks elapsed time", async () => {
    const perf = new RequestPerf("test-3");
    await new Promise((r) => setTimeout(r, 10));
    expect(perf.elapsed()).toBeGreaterThanOrEqual(5);
  });

  it("summarize does not throw with fewer than 2 markers", () => {
    const perf = new RequestPerf("test-4");
    // Only request:start — should not throw
    expect(() => perf.summarize()).not.toThrow();
  });

  it("summarize does not throw with multiple markers", async () => {
    const perf = new RequestPerf("test-5");
    perf.mark("spawn");
    await new Promise((r) => setTimeout(r, 5));
    perf.mark("first-token");
    perf.mark("request:done");
    expect(() => perf.summarize()).not.toThrow();
  });

  it("markers have monotonically increasing timestamps", () => {
    const perf = new RequestPerf("test-6");
    perf.mark("a");
    perf.mark("b");
    perf.mark("c");
    const markers = perf.getMarkers();
    for (let i = 1; i < markers.length; i++) {
      expect(markers[i].ts).toBeGreaterThanOrEqual(markers[i - 1].ts);
    }
  });
});
