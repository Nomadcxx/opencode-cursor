import { describe, expect, it } from "bun:test";
import { asStoredAuth, readStoredAuth } from "../../../src/kilo/auth-store.js";

describe("kilo auth-store", () => {
  it("parses oauth and api entries", () => {
    expect(
      asStoredAuth({
        type: "oauth",
        access: "eyJ.test",
        refresh: "refresh",
        expires: 123,
      }),
    ).toBeDefined();

    expect(asStoredAuth({ type: "api", key: "sk-test" })).toBeDefined();
    expect(asStoredAuth({ type: "wellknown", key: "x" })).toBeUndefined();
  });

  it("reads provider credentials from KILO_AUTH_CONTENT", async () => {
    process.env.KILO_AUTH_CONTENT = JSON.stringify({
      cursor: { type: "api", key: "sk-from-store" },
    });

    const auth = await readStoredAuth("cursor");
    expect(auth?.type).toBe("api");
    if (auth?.type === "api") {
      expect(auth.key).toBe("sk-from-store");
    }

    delete process.env.KILO_AUTH_CONTENT;
  });
});
