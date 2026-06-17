import { afterEach, describe, expect, it } from "bun:test";
import {
  _resetSessionResumeCache,
  buildSessionKey,
  deriveConversationAnchor,
  getResumeChatId,
} from "../../../src/proxy/session-resume.js";
import {
  buildCursorAgentCommand,
  captureResumeChatIdFromEvent,
  captureResumeChatIdFromOutput,
  maybeEvictResumeChatId,
  resolvePromptForBackend,
} from "../../../src/plugin.js";
import { isResumeSpecificFailure } from "../../../src/utils/errors.js";

describe("plugin resume orchestration", () => {
  afterEach(() => {
    _resetSessionResumeCache();
    delete process.env.CURSOR_ACP_SESSION_RESUME;
  });

  const baseInput = {
    backend: "cursor-agent" as const,
    messages: [{ role: "user", content: "Remember BETA" }],
    tools: [] as any[],
    subagentNames: [] as string[],
    model: "gpt-5",
    workspaceDirectory: "/workspace",
  };

  it("resolvePromptForBackend: disabled → full prompt, no resume", () => {
    const result = resolvePromptForBackend({
      ...baseInput,
      backend: "sdk" as const,
    });
    expect(result.prompt).toBe("USER: Remember BETA");
    expect(result.resumeChatId).toBeUndefined();
    expect(result.usedIncremental).toBe(false);
  });

  it("resolvePromptForBackend: enabled + no chatId → full prompt + sessionKey", () => {
    process.env.CURSOR_ACP_SESSION_RESUME = "1";
    const result = resolvePromptForBackend(baseInput);
    expect(result.prompt).toBe("USER: Remember BETA");
    expect(result.resumeChatId).toBeUndefined();
    expect(result.sessionKey).toBe(
      buildSessionKey("/workspace", "gpt-5", deriveConversationAnchor(baseInput.messages)!.anchor),
    );
    expect(result.usedIncremental).toBe(false);
    expect(result.contentPrefix).toBe("Remember BETA");
  });

  it("resolvePromptForBackend: enabled + no usable anchor → full prompt, no sessionKey", () => {
    process.env.CURSOR_ACP_SESSION_RESUME = "1";
    const messages = [{ role: "system", content: "You are helpful" }];
    const result = resolvePromptForBackend({
      ...baseInput,
      messages,
    });
    expect(result.prompt).toBe("SYSTEM: You are helpful");
    expect(result.resumeChatId).toBeUndefined();
    expect(result.sessionKey).toBeUndefined();
    expect(result.usedIncremental).toBe(false);
  });

  it("resolvePromptForBackend: enabled + chatId + incremental → incremental + resume", () => {
    process.env.CURSOR_ACP_SESSION_RESUME = "1";
    const { sessionKey, contentPrefix } = resolvePromptForBackend(baseInput);
    // Seed the cache as if turn 1 produced a session_id.
    const chatId = "chat-abc";
    const entry = getResumeChatId(sessionKey!, contentPrefix!);
    expect(entry).toBeUndefined();
    // Use the exported capture helper to seed.
    captureResumeChatIdFromEvent(
      { type: "system", session_id: chatId } as any,
      sessionKey,
      "gpt-5",
      "/workspace",
      contentPrefix,
    );

    const followUp = resolvePromptForBackend({
      ...baseInput,
      messages: [
        { role: "user", content: "Remember BETA" },
        { role: "assistant", content: "Got it." },
        { role: "user", content: "What was the codeword?" },
      ],
    });
    expect(followUp.resumeChatId).toBe(chatId);
    expect(followUp.prompt).toBe("What was the codeword?");
    expect(followUp.usedIncremental).toBe(true);
  });

  it("resolvePromptForBackend: enabled + chatId + incremental null → full prompt + resume", () => {
    process.env.CURSOR_ACP_SESSION_RESUME = "1";
    const { sessionKey, contentPrefix } = resolvePromptForBackend(baseInput);
    const chatId = "chat-abc";
    captureResumeChatIdFromEvent(
      { type: "system", session_id: chatId } as any,
      sessionKey,
      "gpt-5",
      "/workspace",
      contentPrefix,
    );

    const followUp = resolvePromptForBackend({
      ...baseInput,
      messages: [
        { role: "user", content: "Remember BETA" },
        { role: "assistant", content: "Hi there" },
      ],
    });
    expect(followUp.resumeChatId).toBe(chatId);
    expect(followUp.usedIncremental).toBe(false);
    expect(followUp.prompt).toContain("USER: Remember BETA");
  });

  it("captureResumeChatIdFromEvent records a string session_id", () => {
    process.env.CURSOR_ACP_SESSION_RESUME = "1";
    const key = "/workspace\0gpt-5\0anchor";
    captureResumeChatIdFromEvent(
      { type: "system", session_id: "chat-123" } as any,
      key,
      "gpt-5",
      "/workspace",
      "prefix",
    );
    expect(getResumeChatId(key, "prefix")).toBe("chat-123");
  });

  it("captureResumeChatIdFromEvent ignores non-string or empty session_id", () => {
    process.env.CURSOR_ACP_SESSION_RESUME = "1";
    const key = "/workspace\0gpt-5\0anchor";
    captureResumeChatIdFromEvent({ type: "system" } as any, key, "gpt-5", "/workspace", "prefix");
    captureResumeChatIdFromEvent({ type: "system", session_id: 123 } as any, key, "gpt-5", "/workspace", "prefix");
    captureResumeChatIdFromEvent({ type: "system", session_id: "   " } as any, key, "gpt-5", "/workspace", "prefix");
    expect(getResumeChatId(key, "prefix")).toBeUndefined();
  });

  it("captureResumeChatIdFromEvent no-ops when disabled or no sessionKey", () => {
    const key = "/workspace\0gpt-5\0anchor";
    captureResumeChatIdFromEvent(
      { type: "system", session_id: "chat-123" } as any,
      key,
      "gpt-5",
      "/workspace",
      "prefix",
    );
    expect(getResumeChatId(key, "prefix")).toBeUndefined();

    process.env.CURSOR_ACP_SESSION_RESUME = "1";
    captureResumeChatIdFromEvent(
      { type: "system", session_id: "chat-123" } as any,
      undefined,
      "gpt-5",
      "/workspace",
      "prefix",
    );
    expect(getResumeChatId(key, "prefix")).toBeUndefined();
  });

  it("captureResumeChatIdFromOutput parses NDJSON lines and records session_id", () => {
    process.env.CURSOR_ACP_SESSION_RESUME = "1";
    const key = "/workspace\0gpt-5\0anchor";
    const output = [
      '{"type":"system","session_id":"chat-xyz"}',
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hi"}]}}',
    ].join("\n");
    captureResumeChatIdFromOutput(output, key, "gpt-5", "/workspace", "prefix");
    expect(getResumeChatId(key, "prefix")).toBe("chat-xyz");
  });

  it("buildCursorAgentCommand includes --resume when chatId provided", () => {
    const cmd = buildCursorAgentCommand("gpt-5", "/workspace", "chat-123");
    const resumeIndex = cmd.indexOf("--resume");
    expect(resumeIndex).toBeGreaterThan(-1);
    expect(cmd[resumeIndex + 1]).toBe("chat-123");
  });

  it("buildCursorAgentCommand omits --resume when no chatId", () => {
    const cmd = buildCursorAgentCommand("gpt-5", "/workspace");
    expect(cmd).not.toContain("--resume");
  });

  it("buildCursorAgentCommand omits --resume for unsafe chatIds", () => {
    const unsafeIds = [
      "",
      " chat-123",
      "chat-123 ",
      "-chat-123",
      "_chat-123",
      "chat.123",
      "chat/123",
      "chat-123;echo bad",
      "chat|123",
      "chat$123",
      "chat`123",
      "chat\n123",
      "chat\x00123",
    ];
    for (const unsafeId of unsafeIds) {
      const cmd = buildCursorAgentCommand("gpt-5", "/workspace", unsafeId);
      expect(cmd).not.toContain("--resume");
    }
  });

  it("buildCursorAgentCommand keeps --resume for safe chatIds", () => {
    const safeIds = ["chat-123", "Chat_123-abc", "a", "A1_b2-c3"];
    for (const safeId of safeIds) {
      const cmd = buildCursorAgentCommand("gpt-5", "/workspace", safeId);
      expect(cmd).toContain("--resume");
      const resumeIndex = cmd.indexOf("--resume");
      expect(cmd[resumeIndex + 1]).toBe(safeId);
    }
  });

  it("captureResumeChatIdFromOutput ignores malformed and empty lines", () => {
    process.env.CURSOR_ACP_SESSION_RESUME = "1";
    const key = "/workspace\0gpt-5\0anchor";
    const output = [
      "",
      "not-json",
      "{}",
      "{\"type\":\"assistant\"}",
      "{\"type\":\"system\",\"session_id\":\"\"}",
    ].join("\n");
    expect(() => captureResumeChatIdFromOutput(output, key, "gpt-5", "/workspace", "prefix")).not.toThrow();
    expect(getResumeChatId(key, "prefix")).toBeUndefined();
  });

  it("falls back to full prompt when tool fingerprint changes", () => {
    process.env.CURSOR_ACP_SESSION_RESUME = "1";
    const { sessionKey, contentPrefix, toolFingerprint } = resolvePromptForBackend({
      ...baseInput,
      tools: [{ function: { name: "read", description: "Read files", parameters: { properties: {} } } }],
    });
    captureResumeChatIdFromEvent(
      { type: "system", session_id: "chat-abc" } as any,
      sessionKey,
      "gpt-5",
      "/workspace",
      contentPrefix,
      toolFingerprint,
    );

    const followUp = resolvePromptForBackend({
      ...baseInput,
      messages: [
        { role: "user", content: "Remember BETA" },
        { role: "assistant", content: "Got it." },
        { role: "user", content: "What was the codeword?" },
      ],
      tools: [
        { function: { name: "read", description: "Read files", parameters: { properties: { path: {} } } } },
        { function: { name: "write", description: "Write files", parameters: { properties: {} } } },
      ],
    });
    expect(followUp.resumeChatId).toBeUndefined();
    expect(followUp.usedIncremental).toBe(false);
    expect(followUp.prompt).toContain("write");
  });

  it("falls back to full prompt when subagent list changes", () => {
    process.env.CURSOR_ACP_SESSION_RESUME = "1";
    const { sessionKey, contentPrefix, subagentFingerprint } = resolvePromptForBackend({
      ...baseInput,
      subagentNames: ["agent-a"],
    });
    captureResumeChatIdFromEvent(
      { type: "system", session_id: "chat-abc" } as any,
      sessionKey,
      "gpt-5",
      "/workspace",
      contentPrefix,
      undefined,
      subagentFingerprint,
    );

    const followUp = resolvePromptForBackend({
      ...baseInput,
      messages: [
        { role: "user", content: "Remember BETA" },
        { role: "assistant", content: "Got it." },
        { role: "user", content: "What was the codeword?" },
      ],
      subagentNames: ["agent-a", "agent-b"],
    });
    expect(followUp.resumeChatId).toBeUndefined();
    expect(followUp.usedIncremental).toBe(false);
  });

  it("captures session_id from stream result events", () => {
    process.env.CURSOR_ACP_SESSION_RESUME = "1";
    const key = "/workspace\0gpt-5\0anchor";
    captureResumeChatIdFromEvent(
      { type: "result", session_id: "chat-stream" } as any,
      key,
      "gpt-5",
      "/workspace",
      "prefix",
    );
    expect(getResumeChatId(key, "prefix")).toBe("chat-stream");
  });

  it("evicts cached chatId on resume-specific failures", () => {
    process.env.CURSOR_ACP_SESSION_RESUME = "1";
    const { sessionKey, contentPrefix } = resolvePromptForBackend(baseInput);
    captureResumeChatIdFromEvent(
      { type: "system", session_id: "chat-abc" } as any,
      sessionKey,
      "gpt-5",
      "/workspace",
      contentPrefix,
    );
    expect(getResumeChatId(sessionKey!, contentPrefix!)).toBe("chat-abc");

    const errSource = "Error: session not found";
    expect(isResumeSpecificFailure(errSource)).toBe(true);
    const evicted = maybeEvictResumeChatId(errSource, "chat-abc", sessionKey, {
      code: 1,
    });
    expect(evicted).toBe(true);
    expect(getResumeChatId(sessionKey!, contentPrefix!)).toBeUndefined();
  });

  it("does not evict cached chatId on transient failures", () => {
    process.env.CURSOR_ACP_SESSION_RESUME = "1";
    const { sessionKey, contentPrefix } = resolvePromptForBackend(baseInput);
    captureResumeChatIdFromEvent(
      { type: "system", session_id: "chat-abc" } as any,
      sessionKey,
      "gpt-5",
      "/workspace",
      contentPrefix,
    );
    expect(getResumeChatId(sessionKey!, contentPrefix!)).toBe("chat-abc");

    const errSource = "fetch failed ECONNREFUSED";
    expect(isResumeSpecificFailure(errSource)).toBe(false);
    const evicted = maybeEvictResumeChatId(errSource, "chat-abc", sessionKey, {
      code: 1,
    });
    expect(evicted).toBe(false);
    expect(getResumeChatId(sessionKey!, contentPrefix!)).toBe("chat-abc");
  });
});
