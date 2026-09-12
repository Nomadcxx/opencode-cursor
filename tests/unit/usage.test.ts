import {
  appendOpenAiUsage,
  createChatCompletionUsageChunk,
  createOpenAiUsage,
  extractOpenAiUsageFromResult,
  formatStreamUsageAndDoneSse,
  normalizeCursorUsage,
  shouldEmitOpenAiUsage,
  type OpenAiUsage,
} from "../../src/usage.js";

function toStepFinishTokens(usage: OpenAiUsage) {
  return {
    input: usage.prompt_tokens,
    output: usage.completion_tokens,
    reasoning: usage.completion_tokens_details.reasoning_tokens,
    cache: {
      read: usage.prompt_tokens_details.cached_tokens,
      write: usage.prompt_tokens_details.cache_write_tokens,
    },
  };
}

describe("usage metrics", () => {
  it("maps Cursor stream usage to OpenAI usage", () => {
    const usage = extractOpenAiUsageFromResult({
      type: "result",
      subtype: "success",
      usage: {
        inputTokens: 1397,
        outputTokens: 8,
        cacheReadTokens: 9856,
        cacheWriteTokens: 2,
      },
    });

    expect(usage).toEqual({
      prompt_tokens: 11255,
      completion_tokens: 8,
      total_tokens: 11263,
      prompt_tokens_details: {
        cached_tokens: 9856,
        cache_write_tokens: 2,
      },
      completion_tokens_details: {
        reasoning_tokens: 0,
      },
    });
  });

  it("supports reasoning tokens and cost aliases", () => {
    const metrics = normalizeCursorUsage({
      input_tokens: 100,
      output_tokens: 25,
      reasoning_tokens: 5,
      cache_read_tokens: 50,
      cache_write_tokens: 10,
      total_cost: 0.0012,
    });

    expect(metrics).toEqual({
      inputTokens: 100,
      outputTokens: 25,
      reasoningTokens: 5,
      cacheReadTokens: 50,
      cacheWriteTokens: 10,
      cost: 0.0012,
    });
    expect(createOpenAiUsage(metrics!)).toEqual({
      prompt_tokens: 160,
      completion_tokens: 25,
      total_tokens: 190,
      prompt_tokens_details: {
        cached_tokens: 50,
        cache_write_tokens: 10,
      },
      completion_tokens_details: {
        reasoning_tokens: 5,
      },
      cost: 0.0012,
    });
  });

  it("ignores empty or invalid usage", () => {
    expect(normalizeCursorUsage(undefined)).toBeUndefined();
    expect(normalizeCursorUsage({})).toBeUndefined();
    expect(normalizeCursorUsage({ inputTokens: -1, outputTokens: Number.NaN })).toBeUndefined();
  });

  it("does not emit usage when Cursor result has no usage payload", () => {
    expect(extractOpenAiUsageFromResult({
      type: "result",
      subtype: "success",
      result: "ok",
    })).toBeUndefined();
  });

  it("provides the fields OpenCode TokenSpeed reads from step-finish parts", () => {
    const usage = createOpenAiUsage({
      inputTokens: 120,
      outputTokens: 32,
      reasoningTokens: 7,
      cacheReadTokens: 80,
      cacheWriteTokens: 5,
      cost: 0.0042,
    });

    expect(toStepFinishTokens(usage)).toEqual({
      input: 205,
      output: 32,
      reasoning: 7,
      cache: {
        read: 80,
        write: 5,
      },
    });
    expect(usage.cost).toBe(0.0042);
  });

  it("appends usage to non-streaming completion payloads", () => {
    const usage = createOpenAiUsage({
      inputTokens: 10,
      outputTokens: 2,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(appendOpenAiUsage({ id: "x", choices: [] }, usage)).toEqual({
      id: "x",
      choices: [],
      usage,
    });
  });

  it("skips usage on non-streaming tool_calls responses", () => {
    const usage = createOpenAiUsage({
      inputTokens: 10,
      outputTokens: 2,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(
      appendOpenAiUsage(
        { id: "x", choices: [{ finish_reason: "tool_calls" }] },
        usage,
      ),
    ).toEqual({
      id: "x",
      choices: [{ finish_reason: "tool_calls" }],
    });
  });

  it("omits usage chunks for tool_calls stream termination", () => {
    const usage = createOpenAiUsage({
      inputTokens: 10,
      outputTokens: 2,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    const payloads = formatStreamUsageAndDoneSse("chatcmpl-test", 123, "auto", usage, {
      finishReason: "tool_calls",
    });
    expect(payloads).toEqual(["data: [DONE]\n\n"]);
    expect(shouldEmitOpenAiUsage("tool_calls")).toBe(false);
    expect(shouldEmitOpenAiUsage("stop")).toBe(true);
  });

  it("formats streaming usage before [DONE]", () => {
    const usage = createOpenAiUsage({
      inputTokens: 10,
      outputTokens: 2,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    const payloads = formatStreamUsageAndDoneSse("chatcmpl-test", 123, "auto", usage);
    expect(payloads).toHaveLength(2);
    expect(payloads[0]).toContain("\"prompt_tokens\":10");
    expect(payloads[1]).toBe("data: [DONE]\n\n");
  });

  it("creates OpenAI streaming usage chunks", () => {
    const chunk = createChatCompletionUsageChunk("chatcmpl-test", 123, "auto", {
      prompt_tokens: 10,
      completion_tokens: 2,
      total_tokens: 12,
      prompt_tokens_details: {
        cached_tokens: 4,
        cache_write_tokens: 0,
      },
      completion_tokens_details: {
        reasoning_tokens: 0,
      },
    });

    expect(chunk).toEqual({
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      created: 123,
      model: "auto",
      choices: [],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 2,
        total_tokens: 12,
        prompt_tokens_details: {
          cached_tokens: 4,
          cache_write_tokens: 0,
        },
        completion_tokens_details: {
          reasoning_tokens: 0,
        },
      },
    });
  });
});
