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
  ];

  for (const c of cases) {
    test(`redacts ${c.name}`, () => {
      const out = redactSecrets(c.input);
      expect(out).not.toContain(c.secret);
      expect(out).toContain("[REDACTED]");
    });
  }

  test("leaves ordinary diagnostics intact", () => {
    const input = '{"model":"auto","promptLength":1200,"toolCount":3}';
    expect(redactSecrets(input)).toBe(input);
  });
});
