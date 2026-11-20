import { describe, expect, test } from "bun:test";
import { redactSecrets } from "../../../src/utils/logger.js";

describe("redactSecrets", () => {
  const cases: Array<{ name: string; input: string; secret: string }> = [
    { name: "bearer header text", input: "cursor-agent stderr: Authorization: Bearer abc.def-123", secret: "abc.def-123" },
    { name: "serialized authorization field", input: '{"authorization":"Bearer tok_12345678"}', secret: "tok_12345678" },
    { name: "serialized apiKey field", input: '{"apiKey":"plainsecretvalue"}', secret: "plainsecretvalue" },
    { name: "env assignment", input: "CURSOR_API_KEY=abcdef0123456789", secret: "abcdef0123456789" },
    { name: "proxy token header", input: '{"x-open-cursor-token":"' + "f".repeat(64) + '"}', secret: "f".repeat(64) },
    { name: "bare key-shaped token", input: "failed with key_0123456789abcdefghijABCDEFGHIJ", secret: "key_0123456789abcdefghijABCDEFGHIJ" },
    { name: "basic credentials", input: "Authorization: Basic dXNlcjpwYXNzd29yZA==", secret: "dXNlcjpwYXNzd29yZA==" },
    { name: "x-api-key header", input: '{"x-api-key":"plainsecretvalue"}', secret: "plainsecretvalue" },
    { name: "token field", input: '{"token":"plainsecretvalue"}', secret: "plainsecretvalue" },
    { name: "jwt", input: "access token: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcDEF123", secret: "eyJhbGciOiJIUzI1NiJ9" },
    { name: "query parameter", input: "GET https://api.example/v1?model=x&key=plainsecretvalue", secret: "plainsecretvalue" },
    { name: "command-line flag", input: "spawn cursor-agent --api-key plainsecretvalue", secret: "plainsecretvalue" },
    { name: "camelCase key", input: '{"cursorApiKey":"plainsecretvalue"}', secret: "plainsecretvalue" },
    { name: "camelCase token assignment", input: "sessionToken=plainsecretvalue", secret: "plainsecretvalue" },
  ];

  for (const c of cases) {
    test(`redacts ${c.name}`, () => {
      const out = redactSecrets(c.input);
      expect(out).not.toContain(c.secret);
      expect(out).toContain("[REDACTED]");
    });
  }

  test("leaves ordinary diagnostics intact", () => {
    for (const input of [
      '{"model":"auto","promptLength":1200,"toolCount":3}',
      '{"hasApiKey":true,"maxTokens":4096,"tokenCount":12,"promptTokens":7,"apiKeySource":"env"}',
      "using key-value-store-0123456789abcdefghij for sessions",
    ]) {
      expect(redactSecrets(input)).toBe(input);
    }
  });
});
