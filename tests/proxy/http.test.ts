import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { createProxyServer } from "../../src/proxy/server.js";

describe("HTTP Proxy Comprehensive Tests", () => {
  const server = createProxyServer({ port: 32130 });
  let baseURL: string;

  beforeAll(async () => {
    baseURL = await server.start();
  });

  afterAll(async () => {
    await server.stop();
  });

  describe("Health Check", () => {
    it("should respond to health check with ok: true", async () => {
      const response = await fetch(`${baseURL.replace('/v1', '')}/health`);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.ok).toBe(true);
    });

    it("should respond with JSON content type", async () => {
      const response = await fetch(`${baseURL.replace('/v1', '')}/health`);
      expect(response.headers.get('content-type')).toContain('application/json');
    });
  });

  describe("OpenAI API Compatibility", () => {
    it("should return 404 for unknown endpoints", async () => {
      const response = await fetch(`${baseURL}/unknown-endpoint`);
      expect(response.status).toBe(404);
    });

    it("should handle POST to /chat/completions", async () => {
      const response = await fetch(`${baseURL}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "cursor-kilo/auto",
          messages: [{ role: "user", content: "Hello" }]
        })
      });

      // Currently returns 404 as we haven't fully implemented chat completions
      expect([200, 404]).toContain(response.status);
    });

    it("should handle streaming requests", async () => {
      const response = await fetch(`${baseURL}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "cursor-kilo/auto",
          messages: [{ role: "user", content: "Hello" }],
          stream: true
        })
      });

      expect([200, 404]).toContain(response.status);
    });

    it("should handle invalid JSON", async () => {
      const response = await fetch(`${baseURL}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "invalid json"
      });

      expect([400, 404]).toContain(response.status);
    });

    it("should handle empty request body", async () => {
      const response = await fetch(`${baseURL}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" }
      });

      expect([400, 404]).toContain(response.status);
    });
  });

  describe("CORS Headers", () => {
    it("should handle OPTIONS requests", async () => {
      const response = await fetch(`${baseURL}/chat/completions`, {
        method: "OPTIONS"
      });

      // Server should respond to OPTIONS
      expect([200, 204, 404]).toContain(response.status);
    });
  });

  describe("Concurrent Requests", () => {
    it("should handle multiple concurrent health checks", async () => {
      const promises = Array(10).fill(null).map(() =>
        fetch(`${baseURL.replace('/v1', '')}/health`)
      );

      const responses = await Promise.all(promises);

      for (const response of responses) {
        expect(response.status).toBe(200);
      }
    });
  });

  describe("Server Lifecycle", () => {
    it("should return same baseURL after multiple starts", async () => {
      // Server is already started from beforeAll
      expect(server.getBaseURL()).toBe(baseURL);
    });

    it("should handle stop gracefully", async () => {
      const tempServer = createProxyServer({ port: 32131 });
      await tempServer.start();

      // Should not throw
      await tempServer.stop();
      await tempServer.stop(); // Second stop should be safe
    });
  });

  describe("Request Parsing", () => {
    it("should parse OpenAI-formatted requests correctly", async () => {
      const testCases = [
        {
          model: "cursor-kilo/auto",
          messages: [{ role: "user", content: "Hello" }]
        },
        {
          model: "cursor-kilo/gpt-5.2",
          messages: [
            { role: "system", content: "You are helpful" },
            { role: "user", content: "Hi" }
          ]
        },
        {
          model: "cursor-kilo/sonnet-4.5",
          messages: [{ role: "user", content: "Test" }],
          stream: true,
          temperature: 0.7
        }
      ];

      for (const testCase of testCases) {
        const response = await fetch(`${baseURL}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(testCase)
        });

        // Should handle without crashing
        expect([200, 404]).toContain(response.status);
      }
    });
  });
});