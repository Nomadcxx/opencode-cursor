import { describe, expect, it } from "bun:test";
import {
  applyBridgeJsonPrompt,
  extractBridgeToolCallFromStreamOutput,
  extractBridgeToolCallFromText,
  isBridgeJsonEnabled,
} from "../../../src/proxy/bridge-json.js";

describe("proxy/bridge-json", () => {
  it("extracts a strict write bridge response into an OpenAI tool call", () => {
    const toolCall = extractBridgeToolCallFromText(
      '{"name":"write","arguments":{"path":"demo.txt","content":"hello"}}',
      new Set(["write"]),
    );

    expect(toolCall?.function.name).toBe("write");
    expect(toolCall?.function.arguments).toBe('{"path":"demo.txt","content":"hello"}');
    expect(toolCall?.id).toStartWith("call_bridge_");
  });

  it("extracts a single fenced json bridge response", () => {
    const toolCall = extractBridgeToolCallFromText(
      '```json\n{"name":"write","arguments":{"path":"demo.txt","content":"hello"}}\n```',
      new Set(["write"]),
    );

    expect(toolCall?.function.name).toBe("write");
  });

  it("rejects prose-wrapped bridge json", () => {
    const toolCall = extractBridgeToolCallFromText(
      'I will write this:\n{"name":"write","arguments":{"path":"demo.txt","content":"hello"}}',
      new Set(["write"]),
    );

    expect(toolCall).toBeNull();
  });

  it("rejects bridge writes when write is not an offered tool", () => {
    const toolCall = extractBridgeToolCallFromText(
      '{"name":"write","arguments":{"path":"demo.txt","content":"hello"}}',
      new Set(["read"]),
    );

    expect(toolCall).toBeNull();
  });

  it("extracts a later bridge response from stream-json output after prelude text", () => {
    const output = [
      JSON.stringify({
        type: "assistant",
        timestamp_ms: 1,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Reading first.\n" }],
        },
      }),
      JSON.stringify({
        type: "tool_call",
        call_id: "read_1",
        tool_call: { readToolCall: { args: { path: "demo.txt" } } },
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: '{"name":"write","arguments":{"path":"demo.txt","content":"after read"}}',
            },
          ],
        },
      }),
    ].join("\n");

    const toolCall = extractBridgeToolCallFromStreamOutput(output, new Set(["write"]));

    expect(toolCall?.function.name).toBe("write");
    expect(toolCall?.function.arguments).toBe('{"path":"demo.txt","content":"after read"}');
  });

  it("appends bridge instructions unless the runtime env opts out", () => {
    const prompt = applyBridgeJsonPrompt("USER: update demo.txt", {
      allowedToolNames: new Set(["write"]),
      env: {},
    });
    const disabled = applyBridgeJsonPrompt("USER: update demo.txt", {
      allowedToolNames: new Set(["write"]),
      env: { CURSOR_ACP_BRIDGE_JSON: "0" },
    });

    expect(prompt).toContain("opencode bridge mode");
    expect(disabled).toBe("USER: update demo.txt");
    expect(isBridgeJsonEnabled({ CURSOR_ACP_BRIDGE_JSON: "false" })).toBe(false);
  });
});
