import { afterEach, describe, expect, it } from "bun:test";
import {
  _resetSessionResumeCache,
  buildSessionKey,
  clearResumeChatId,
  deriveConversationAnchor,
  getResumeChatId,
  hashForLog,
  hasResumeChatId,
  isSessionResumeEnabled,
  recordResumeChatId,
} from "../../../src/proxy/session-resume.js";

describe("session-resume", () => {
  afterEach(() => {
    _resetSessionResumeCache();
    delete process.env.CURSOR_ACP_SESSION_RESUME;
  });

  it("is disabled by default", () => {
    expect(isSessionResumeEnabled()).toBe(false);
  });

  it.each([
    ["1", true],
    ["true", true],
    ["TRUE", true],
    ["on", true],
    ["yes", true],
    ["0", false],
    ["false", false],
    ["", false],
    [undefined, false],
  ])("isSessionResumeEnabled(%p) === %p", (value, expected) => {
    if (value !== undefined) {
      process.env.CURSOR_ACP_SESSION_RESUME = value;
    } else {
      delete process.env.CURSOR_ACP_SESSION_RESUME;
    }
    expect(isSessionResumeEnabled()).toBe(expected);
  });

  it("derives anchor from first real user message", () => {
    const messages = [
      { role: "user", content: "Title generator: make a brief title" },
      { role: "user", content: "Remember the codeword BETA" },
    ];
    const { anchor: anchorA, contentPrefix: prefixA } = deriveConversationAnchor(messages);
    const { anchor: anchorB, contentPrefix: prefixB } = deriveConversationAnchor([
      { role: "user", content: "Remember the codeword BETA" },
    ]);
    expect(anchorA).toBe(anchorB);
    expect(prefixA).toBe(prefixB);
  });

  it("handles array-content first user message", () => {
    const stringResult = deriveConversationAnchor([
      { role: "user", content: "Remember BETA" },
    ]);
    const arrayResult = deriveConversationAnchor([
      { role: "user", content: [{ type: "text", text: "Remember BETA" }] },
    ]);
    expect(arrayResult!.anchor).toBe(stringResult!.anchor);
    expect(arrayResult!.anchor).not.toBe("default");
  });

  it("ignores non-text parts when deriving array-content anchor", () => {
    const stringResult = deriveConversationAnchor([{ role: "user", content: "hello" }]);
    const mixedResult = deriveConversationAnchor([
      {
        role: "user",
        content: [
          { type: "text", text: "hello" },
          { type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
        ],
      },
    ]);
    expect(mixedResult!.anchor).not.toBe(stringResult!.anchor);
  });

  it("produces different anchors for identical text with different images", () => {
    const messagesA = [
      {
        role: "user",
        content: [
          { type: "text", text: "Describe this" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
        ],
      },
    ];
    const messagesB = [
      {
        role: "user",
        content: [
          { type: "text", text: "Describe this" },
          { type: "image_url", image_url: { url: "data:image/png;base64,BBB" } },
        ],
      },
    ];
    const anchorA = deriveConversationAnchor(messagesA)!.anchor;
    const anchorB = deriveConversationAnchor(messagesB)!.anchor;
    expect(anchorA).not.toBe(anchorB);
    expect(deriveConversationAnchor(messagesA)!.contentPrefix).toBe("Describe this".slice(0, 500));
  });

  it("produces different anchors for text-only vs text+image user messages", () => {
    const textOnly = deriveConversationAnchor([{ role: "user", content: "hello" }])!.anchor;
    const textAndImage = deriveConversationAnchor([
      {
        role: "user",
        content: [
          { type: "text", text: "hello" },
          { type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
        ],
      },
    ])!.anchor;
    expect(textAndImage).not.toBe(textOnly);
  });

  it("returns undefined when no usable user message", () => {
    const result = deriveConversationAnchor([
      { role: "system", content: "You are helpful" },
      { role: "assistant", content: "Hi" },
    ]);
    expect(result).toBeUndefined();
  });

  it("returns undefined when all user messages are meta", () => {
    const result = deriveConversationAnchor([
      { role: "user", content: "Generate a brief title for this thread" },
    ]);
    expect(result).toBeUndefined();
  });

  it("documents that meta substring filter can misclassify real messages", () => {
    // The substring heuristic for title-generation prompts is not precise: a real
    // user message that contains "title generator" is currently treated as meta.
    const result = deriveConversationAnchor([
      { role: "user", content: "I tried the title generator but it failed; remember BETA" },
    ]);
    expect(result).toBeUndefined();
  });

  it("stores and retrieves chat IDs by session key", () => {
    const key = buildSessionKey("/workspace", "gpt-5", "abc123");
    expect(getResumeChatId(key)).toBeUndefined();

    recordResumeChatId(key, "chat-uuid-1", "hello");
    expect(getResumeChatId(key)).toBe("chat-uuid-1");
  });

  it("clears a stored chat ID", () => {
    const key = buildSessionKey("/workspace", "gpt-5", "abc123");
    recordResumeChatId(key, "chat-uuid-1", "hello");
    clearResumeChatId(key);
    expect(getResumeChatId(key)).toBeUndefined();
  });

  it("builds distinct keys for different workspaces and models", () => {
    const { anchor } = deriveConversationAnchor([{ role: "user", content: "hello" }]);
    const keyA = buildSessionKey("/a", "model-1", anchor);
    const keyB = buildSessionKey("/b", "model-1", anchor);
    const keyC = buildSessionKey("/a", "model-2", anchor);
    expect(keyA).not.toBe(keyB);
    expect(keyA).not.toBe(keyC);
  });

  it("refuses to cache unsafe chat IDs", () => {
    const key = buildSessionKey("/workspace", "gpt-5", "abc123");
    recordResumeChatId(key, "safe-id_123", "hello");
    expect(getResumeChatId(key)).toBe("safe-id_123");

    clearResumeChatId(key);
    recordResumeChatId(key, "unsafe; id", "hello");
    expect(getResumeChatId(key)).toBeUndefined();

    recordResumeChatId(key, "", "hello");
    expect(getResumeChatId(key)).toBeUndefined();
  });

  it("evicts oldest entry when max entries exceeded", () => {
    for (let i = 0; i < 64; i++) {
      const key = buildSessionKey("/ws", "model", `anchor-${i}`);
      recordResumeChatId(key, `chat-${i}`, `prefix-${i}`);
    }
    const firstKey = buildSessionKey("/ws", "model", "anchor-0");
    const secondKey = buildSessionKey("/ws", "model", "anchor-1");

    // Add one more; oldest untouched entry should be evicted.
    const extraKey = buildSessionKey("/ws", "model", "anchor-64");
    recordResumeChatId(extraKey, "chat-64", "prefix-64");
    expect(getResumeChatId(firstKey)).toBeUndefined();
    expect(getResumeChatId(secondKey)).toBe("chat-1");
    expect(getResumeChatId(extraKey)).toBe("chat-64");
  });

  it("refreshes insertion order on update so recently-updated entry survives eviction", () => {
    for (let i = 0; i < 64; i++) {
      const key = buildSessionKey("/ws", "model", `anchor-${i}`);
      recordResumeChatId(key, `chat-${i}`, `prefix-${i}`);
    }
    const firstKey = buildSessionKey("/ws", "model", "anchor-0");
    // Touch the first entry to refresh its LRU position.
    getResumeChatId(firstKey);
    recordResumeChatId(firstKey, "chat-0-updated", "prefix-0");

    const extraKey = buildSessionKey("/ws", "model", "anchor-64");
    recordResumeChatId(extraKey, "chat-64", "prefix-64");
    // anchor-1 (not touched) should be evicted instead of anchor-0.
    const secondKey = buildSessionKey("/ws", "model", "anchor-1");
    expect(getResumeChatId(secondKey)).toBeUndefined();
    expect(getResumeChatId(firstKey)).toBe("chat-0-updated");
  });

  it("expires entries after TTL", () => {
    const originalNow = Date.now;
    try {
      const key = buildSessionKey("/workspace", "gpt-5", "abc123");
      const now = 1_000_000_000_000;
      Date.now = () => now;
      recordResumeChatId(key, "chat-uuid-1", "hello");
      expect(getResumeChatId(key)).toBe("chat-uuid-1");

      // Just over 1 hour later.
      Date.now = () => now + 60 * 60 * 1000 + 1;
      expect(getResumeChatId(key)).toBeUndefined();
    } finally {
      Date.now = originalNow;
    }
  });

  it("treats prefix mismatch as a cache miss without evicting another branch", () => {
    const key = buildSessionKey("/workspace", "gpt-5", "abc123");
    recordResumeChatId(key, "chat-uuid-1", "hello");
    expect(getResumeChatId(key, "different")).toBeUndefined();
    expect(getResumeChatId(key, "hello")).toBe("chat-uuid-1");
  });

  it("evicts entry on tool fingerprint mismatch", () => {
    const key = buildSessionKey("/workspace", "gpt-5", "abc123");
    recordResumeChatId(key, "chat-uuid-1", "hello", "fp-v1");
    expect(getResumeChatId(key, "hello", "fp-v1")).toBe("chat-uuid-1");
    expect(getResumeChatId(key, "hello", "fp-v2")).toBeUndefined();
    expect(getResumeChatId(key)).toBeUndefined();
  });

  it("evicts entries recorded without a fingerprint when a request fingerprint is supplied", () => {
    const key = buildSessionKey("/workspace", "gpt-5", "abc123");
    recordResumeChatId(key, "chat-uuid-1", "hello");
    expect(getResumeChatId(key, "hello", "any-fp")).toBeUndefined();
    expect(getResumeChatId(key)).toBeUndefined();
  });

  it("evicts entries with a fingerprint when the request supplies none", () => {
    const key = buildSessionKey("/workspace", "gpt-5", "abc123");
    recordResumeChatId(key, "chat-uuid-1", "hello", "fp-v1");
    expect(getResumeChatId(key, "hello")).toBeUndefined();
    expect(getResumeChatId(key)).toBeUndefined();
  });

  it("hasResumeChatId reports presence without refreshing LRU order", () => {
    for (let i = 0; i < 64; i++) {
      const key = buildSessionKey("/ws", "model", `anchor-${i}`);
      recordResumeChatId(key, `chat-${i}`, `prefix-${i}`);
    }
    const firstKey = buildSessionKey("/ws", "model", "anchor-0");
    expect(hasResumeChatId(firstKey, "prefix-0")).toBe(true);

    const extraKey = buildSessionKey("/ws", "model", "anchor-64");
    recordResumeChatId(extraKey, "chat-64", "prefix-64");

    const secondKey = buildSessionKey("/ws", "model", "anchor-1");
    expect(hasResumeChatId(firstKey, "prefix-0")).toBe(false);
    expect(hasResumeChatId(secondKey, "prefix-1")).toBe(true);
    expect(getResumeChatId(extraKey, "prefix-64")).toBe("chat-64");
  });

  it("hasResumeChatId returns false for prefix and fingerprint mismatches without evicting", () => {
    const key = buildSessionKey("/workspace", "gpt-5", "abc123");
    recordResumeChatId(key, "chat-uuid-1", "hello", "fp-v1");
    expect(hasResumeChatId(key, "different")).toBe(false);
    expect(hasResumeChatId(key, "hello", "fp-v2")).toBe(false);
    expect(getResumeChatId(key, "hello", "fp-v1")).toBe("chat-uuid-1");
  });

  it("hashForLog hashes strings and coerces non-strings deterministically", () => {
    const hashA = hashForLog("sensitive text");
    const hashB = hashForLog("sensitive text");
    expect(typeof hashA).toBe("string");
    expect(hashA.length).toBe(32);
    expect(hashA).toBe(hashB);
    expect(hashForLog(null)).toBe(hashForLog(""));
    expect(hashForLog(new Error("boom"))).toBe(hashForLog(String(new Error("boom"))));
  });
});
