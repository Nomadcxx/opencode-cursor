import { describe, expect, it } from "bun:test";
import {
  classifyStoredAuth,
  looksLikeJwt,
  looksLikeUserApiKey,
  oauthRequiresCursorAgent,
  sdkApiKeyFromCredential,
} from "../../../src/kilo/credential.js";

describe("kilo credential", () => {
  it("detects user API keys vs JWTs", () => {
    expect(looksLikeUserApiKey("sk-test")).toBe(true);
    expect(looksLikeUserApiKey("key_test")).toBe(true);
    expect(looksLikeJwt("eyJ.a.b")).toBe(true);
    expect(looksLikeUserApiKey("eyJ.a.b")).toBe(false);
  });

  it("classifies oauth and api credentials", () => {
    const oauth = classifyStoredAuth({
      type: "oauth",
      access: "eyJ.access",
      refresh: "refresh",
      expires: Date.now() + 3600_000,
    });
    expect(oauth?.kind).toBe("oauth-jwt");
    expect(oauthRequiresCursorAgent(oauth)).toBe(true);
    expect(sdkApiKeyFromCredential(oauth)).toBeUndefined();

    const api = classifyStoredAuth({ type: "api", key: "sk-live-key" });
    expect(api?.kind).toBe("sdk-api-key");
    expect(sdkApiKeyFromCredential(api)).toBe("sk-live-key");
  });
});
