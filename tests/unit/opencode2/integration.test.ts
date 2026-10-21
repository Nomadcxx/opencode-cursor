import { describe, expect, it } from "bun:test";
import { apiKeyFromCredential, applyCursorIntegration } from "../../../src/opencode2/integration.js";
import { cursorAgentCredential, type CursorAgentLogin } from "../../../src/opencode2/cursor-agent-login.js";

describe("OpenCode 2.0 Cursor integration", () => {
  it("offers cursor-agent login as an oauth method before the API key and env methods", async () => {
    const registrations: any[] = [];
    const login: CursorAgentLogin = {
      authorize: async () => ({ url: "", instructions: "ok", mode: "auto", callback: Promise.resolve(cursorAgentCredential()) }),
      dispose: () => {},
    };
    applyCursorIntegration({ update: () => {}, method: { update: (input) => registrations.push(input) } }, login);

    expect(registrations.map((entry) => entry.method.type)).toEqual(["oauth", "key", "env"]);
    const [oauth] = registrations;
    expect(oauth.method).toEqual({ id: "cursor-agent-login", type: "oauth", label: "Log in with cursor-agent (browser)" });
    // No refresh hook: OpenCode then returns the marker credential as-is.
    expect(oauth.refresh).toBeUndefined();
    expect((await oauth.authorize({})).instructions).toBe("ok");
    expect(oauth.label(cursorAgentCredential("ada@example.com"))).toBe("cursor-agent (ada@example.com)");
  });

  it("reads only real keys, so a cursor-agent login credential selects the CLI backend", () => {
    expect(apiKeyFromCredential(cursorAgentCredential("ada@example.com"))).toBeUndefined();
    expect(apiKeyFromCredential({ type: "key", key: " cursor_123 " })).toBe("cursor_123");
  });
});
