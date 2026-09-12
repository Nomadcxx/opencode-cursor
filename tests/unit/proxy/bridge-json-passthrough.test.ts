import { describe, expect, it } from "bun:test";
import { BridgeJsonStreamDetector } from "../../../src/proxy/bridge-json.js";

describe("proxy/bridge-json passthrough dedupe", () => {
  it("returns passthrough text deltas and avoids empty passthrough loops", () => {
    const detector = new BridgeJsonStreamDetector(new Set(["read"]));

    const first = detector.push({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "Hello" }] },
    } as any);
    expect(first.action).toBe("passthrough");
    expect(first.text).toBe("Hello");

    const second = detector.push({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "Hello world" }] },
    } as any);
    expect(second.action).toBe("passthrough");
    expect(second.text).toBe(" world");
  });
});
