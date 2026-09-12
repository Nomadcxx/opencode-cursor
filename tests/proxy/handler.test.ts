import { describe, it, expect } from "bun:test";
import { parseOpenAIRequest } from "../../src/proxy/handler.js";

describe("RequestHandler", () => {
  it("should parse OpenAI chat completion request", () => {
    const body = {
      model: "cursor-kilo/auto",
      messages: [
        { role: "user", content: "Hello" }
      ],
      stream: false
    };

    const result = parseOpenAIRequest(body);
    expect(result.model).toBe("auto");
    expect(result.prompt).toBe("USER: Hello");
    expect(result.stream).toBe(false);
  });

  it("should handle messages array", () => {
    const body = {
      messages: [
        { role: "system", content: "You are helpful" },
        { role: "user", content: "Hi" }
      ]
    };

    const result = parseOpenAIRequest(body);
    expect(result.prompt).toBe("SYSTEM: You are helpful\n\nUSER: Hi");
  });
});