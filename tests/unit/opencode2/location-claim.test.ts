import { describe, expect, it } from "bun:test";
import { claimLocation } from "../../../src/opencode2/location-claim.js";

describe("opencode2/location-claim", () => {
  it("lets the first copy set up a location and turns a second copy away", () => {
    const first = claimLocation("/work/a", "file:///npm/open-cursor/plugin-entry.js");
    expect(first.claimed).toBe(true);

    const second = claimLocation("/work/a", "file:///global/open-cursor/plugin-entry.js");
    expect(second).toEqual({ claimed: false, owner: "file:///npm/open-cursor/plugin-entry.js" });

    if (first.claimed) first.release();
  });

  it("lets the same copy set a location up again and other locations stay independent", () => {
    const first = claimLocation("/work/b", "file:///npm/plugin-entry.js");
    expect(claimLocation("/work/b", "file:///npm/plugin-entry.js").claimed).toBe(true);
    const other = claimLocation("/work/c", "file:///global/plugin-entry.js");
    expect(other.claimed).toBe(true);

    if (first.claimed) first.release();
    if (other.claimed) other.release();
  });

  it("frees the location when the owner cleans up", () => {
    const first = claimLocation("/work/d", "file:///npm/plugin-entry.js");
    if (first.claimed) first.release();

    const next = claimLocation("/work/d", "file:///global/plugin-entry.js");
    expect(next.claimed).toBe(true);
    if (next.claimed) next.release();
  });
});
