import { describe, expect, it } from "bun:test";
import {
  applyCursorAgentAuthToProcessEnv,
  classifyStoredAuth,
  envWithCursorAgentAuth,
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

  it("injects CURSOR_AUTH_TOKEN for oauth credentials", () => {
    const env = envWithCursorAgentAuth(
      { PATH: "/usr/bin" },
      { kind: "oauth-jwt", accessToken: "jwt-access" },
    );
    expect(env.CURSOR_AUTH_TOKEN).toBe("jwt-access");
    expect(env.AGENT_CLI_CREDENTIAL_STORE).toBe("memory");
    expect(env.PATH).toBe("/usr/bin");
    expect(
      envWithCursorAgentAuth({ PATH: "/usr/bin" }, { kind: "cursor-agent-placeholder" }).CURSOR_AUTH_TOKEN,
    ).toBeUndefined();
    expect(
      envWithCursorAgentAuth({ PATH: "/usr/bin" }, { kind: "cursor-agent-placeholder" }).AGENT_CLI_CREDENTIAL_STORE,
    ).toBeUndefined();
  });

  it("injects CURSOR_API_KEY for sdk api-key credentials", () => {
    const env = envWithCursorAgentAuth(
      { PATH: "/usr/bin" },
      { kind: "sdk-api-key", token: "sk-live-key" },
    );
    expect(env.CURSOR_API_KEY).toBe("sk-live-key");
    expect(env.AGENT_CLI_CREDENTIAL_STORE).toBe("memory");
    expect(env.CURSOR_AUTH_TOKEN).toBeUndefined();
  });

  it("writes kilo oauth onto a process env object", () => {
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
    applyCursorAgentAuthToProcessEnv(env, { kind: "oauth-jwt", accessToken: "jwt-access" });
    expect(env.CURSOR_AUTH_TOKEN).toBe("jwt-access");
    expect(env.AGENT_CLI_CREDENTIAL_STORE).toBe("memory");
  });
});
