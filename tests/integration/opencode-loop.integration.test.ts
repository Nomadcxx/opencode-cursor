import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const READ_TOOL = {
  type: "function",
  function: {
    name: "read",
    description: "Read a file",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
      },
      required: ["path"],
    },
  },
};

const TODO_WRITE_TOOL = {
  type: "function",
  function: {
    name: "todowrite",
    description: "Create or update todos",
    parameters: {
      type: "object",
      properties: {
        todos: { type: "array" },
      },
      required: ["todos"],
    },
  },
};

const EDIT_TOOL = {
  type: "function",
  function: {
    name: "edit",
    description: "Edit a file",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_string: { type: "string" },
        new_string: { type: "string" },
      },
      required: ["path", "old_string", "new_string"],
      additionalProperties: false,
    },
  },
};

const WRITE_TOOL = {
  type: "function",
  function: {
    name: "write",
    description: "Write a file",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
};

const MOCK_CURSOR_AGENT = `#!/usr/bin/env node
const fs = require("fs");

const args = process.argv.slice(2);
if (args[0] === "models") {
  process.stdout.write("auto - Auto (current) (default)\\n");
  process.exit(0);
}

const scenario = process.env.MOCK_CURSOR_SCENARIO || "assistant-text";
const promptFile = process.env.MOCK_CURSOR_PROMPT_FILE;
const argsFile = process.env.MOCK_CURSOR_ARGS_FILE;
let prompt = "";

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  prompt += chunk;
});

process.stdin.on("end", () => {
  if (argsFile) {
    fs.writeFileSync(argsFile, JSON.stringify(args));
  }
  if (promptFile) {
    fs.writeFileSync(promptFile, prompt);
  }

  const now = Date.now();
  let events = [];
  if (scenario === "tool-read-then-text") {
    events = [
      {
        type: "tool_call",
        call_id: "c1",
        tool_call: {
          readToolCall: {
            args: { path: "foo.txt" },
          },
        },
      },
      {
        type: "assistant",
        timestamp_ms: now + 1,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "should not appear" }],
        },
      },
    ];
  } else if (scenario === "tool-bash-then-text") {
    events = [
      {
        type: "tool_call",
        call_id: "c1",
        tool_call: {
          bashToolCall: {
            args: { command: "echo test" },
          },
        },
      },
      {
        type: "assistant",
        timestamp_ms: now + 1,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "bash passthrough text" }],
        },
      },
    ];
  } else if (scenario === "tool-updateTodos-then-text") {
    events = [
      {
        type: "tool_call",
        call_id: "c1",
        name: "updateTodos",
        tool_call: {
          updateTodos: {
            args: {
              todos: [{ content: "Book flights", status: "pending" }],
            },
          },
        },
      },
      {
        type: "assistant",
        timestamp_ms: now + 1,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "todo alias passthrough text" }],
        },
      },
    ];
  } else if (scenario === "tool-edit-invalid") {
    events = [
      {
        type: "tool_call",
        call_id: "c1",
        tool_call: {
          editToolCall: {
            args: { path: "TODO.md", content: "full rewrite" },
          },
        },
      },
      {
        type: "assistant",
        timestamp_ms: now + 1,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "edit fallback text" }],
        },
      },
    ];
  } else if (scenario === "tool-edit-missing-path") {
    events = [
      {
        type: "tool_call",
        call_id: "c1",
        tool_call: {
          editToolCall: {
            args: { content: "full rewrite" },
          },
        },
      },
      {
        type: "assistant",
        timestamp_ms: now + 1,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "edit missing path fallback text" }],
        },
      },
    ];
  } else if (scenario === "assistant-done") {
    events = [
      {
        type: "assistant",
        timestamp_ms: now + 1,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "DONE" }],
        },
      },
    ];
  } else if (scenario === "assistant-bridge-write") {
    events = [
      {
        type: "assistant",
        timestamp_ms: now + 1,
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "{\\"name\\":\\"write\\",\\"arguments\\":{\\"path\\":\\"TODO.md\\",\\"content\\":\\"bridge rewrite\\"}}",
            },
          ],
        },
      },
    ];
  } else {
    events = [
      {
        type: "assistant",
        timestamp_ms: now + 1,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "The file contains..." }],
        },
      },
    ];
  }

  for (const event of events) {
    process.stdout.write(JSON.stringify(event) + "\\n");
  }

  if (scenario === "assistant-text-quota-exit") {
    process.stderr.write("You've hit your Cursor usage limit\\n");
    process.exitCode = 1;
    return;
  }
});
`;

type StreamChunk = {
  choices?: Array<{
    delta?: {
      content?: string;
      tool_calls?: Array<{
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
    finish_reason?: string | null;
  }>;
};

function parseSseData(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice("data: ".length));
}

function parseJsonChunks(dataLines: string[]): StreamChunk[] {
  return dataLines
    .filter((line) => line !== "[DONE]")
    .map((line) => JSON.parse(line) as StreamChunk);
}

async function requestCompletion(baseURL: string, body: any): Promise<Response> {
  const response = await fetch(`${baseURL}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  return response;
}

async function waitForFileText(path: string, requiredText?: string): Promise<string> {
  for (let i = 0; i < 20; i++) {
    if (existsSync(path)) {
      const text = readFileSync(path, "utf8");
      if (text.length > 0 && (requiredText === undefined || text.includes(requiredText))) {
        return text;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

describe("OpenCode-owned tool loop integration", () => {
  let originalPath = "";
  let originalToolLoopMode: string | undefined;
  let originalToolsEnabled: string | undefined;
  let originalReuseExistingProxy: string | undefined;
  let originalProviderBoundary: string | undefined;
  let originalToolLoopMaxRepeat: string | undefined;
  let originalTiming: string | undefined;
  let originalLogDir: string | undefined;
  let originalLogConsole: string | undefined;
  let mockDir = "";
  let promptFile = "";
  let argsFile = "";
  let logDir = "";
  let baseURL = "";

  beforeAll(async () => {
    originalPath = process.env.PATH || "";
    originalToolLoopMode = process.env.CURSOR_ACP_TOOL_LOOP_MODE;
    originalToolsEnabled = process.env.CURSOR_ACP_ENABLE_OPENCODE_TOOLS;
    originalReuseExistingProxy = process.env.CURSOR_ACP_REUSE_EXISTING_PROXY;
    originalProviderBoundary = process.env.CURSOR_ACP_PROVIDER_BOUNDARY;
    originalToolLoopMaxRepeat = process.env.CURSOR_ACP_TOOL_LOOP_MAX_REPEAT;
    originalTiming = process.env.CURSOR_ACP_TIMING;
    originalLogDir = process.env.CURSOR_ACP_LOG_DIR;
    originalLogConsole = process.env.CURSOR_ACP_LOG_CONSOLE;
    mockDir = mkdtempSync(join(tmpdir(), "cursor-agent-mock-"));
    promptFile = join(mockDir, "prompt.txt");
    argsFile = join(mockDir, "args.json");
    logDir = join(mockDir, "logs");

    const mockCursorPath = join(mockDir, "cursor-agent");
    writeFileSync(mockCursorPath, MOCK_CURSOR_AGENT, "utf8");
    chmodSync(mockCursorPath, 0o755);

    process.env.PATH = `${mockDir}:${originalPath}`;
    process.env.CURSOR_ACP_TOOL_LOOP_MODE = "opencode";
    process.env.CURSOR_ACP_ENABLE_OPENCODE_TOOLS = "true";
    process.env.CURSOR_ACP_REUSE_EXISTING_PROXY = "false";
    process.env.CURSOR_ACP_PROVIDER_BOUNDARY = "v1";
    process.env.CURSOR_ACP_TOOL_LOOP_MAX_REPEAT = "1";
    process.env.CURSOR_ACP_TIMING = "1";
    process.env.CURSOR_ACP_LOG_DIR = logDir;
    process.env.CURSOR_ACP_LOG_CONSOLE = "0";
    process.env.MOCK_CURSOR_PROMPT_FILE = "";
    process.env.MOCK_CURSOR_ARGS_FILE = "";
    process.env.MOCK_CURSOR_SCENARIO = "assistant-text";

    const { _resetLoggerState } = await import("../../src/utils/logger");
    _resetLoggerState();

    const { CursorPlugin } = await import("../../src/plugin");
    const hooks = await CursorPlugin({
      directory: process.cwd(),
      worktree: process.cwd(),
      serverUrl: new URL("http://localhost:8080"),
      client: {
        tool: {
          list: async () => [],
        },
      } as any,
      project: {} as any,
      $: {} as any,
    });

    const output: any = { options: {} };
    await hooks["chat.params"](
      {
        model: { providerID: "cursor-acp" },
      },
      output,
    );
    baseURL = output.options.baseURL;
  });

  afterAll(async () => {
    process.env.PATH = originalPath;
    if (originalToolLoopMode === undefined) {
      delete process.env.CURSOR_ACP_TOOL_LOOP_MODE;
    } else {
      process.env.CURSOR_ACP_TOOL_LOOP_MODE = originalToolLoopMode;
    }
    if (originalToolsEnabled === undefined) {
      delete process.env.CURSOR_ACP_ENABLE_OPENCODE_TOOLS;
    } else {
      process.env.CURSOR_ACP_ENABLE_OPENCODE_TOOLS = originalToolsEnabled;
    }
    if (originalReuseExistingProxy === undefined) {
      delete process.env.CURSOR_ACP_REUSE_EXISTING_PROXY;
    } else {
      process.env.CURSOR_ACP_REUSE_EXISTING_PROXY = originalReuseExistingProxy;
    }
    if (originalProviderBoundary === undefined) {
      delete process.env.CURSOR_ACP_PROVIDER_BOUNDARY;
    } else {
      process.env.CURSOR_ACP_PROVIDER_BOUNDARY = originalProviderBoundary;
    }
    if (originalToolLoopMaxRepeat === undefined) {
      delete process.env.CURSOR_ACP_TOOL_LOOP_MAX_REPEAT;
    } else {
      process.env.CURSOR_ACP_TOOL_LOOP_MAX_REPEAT = originalToolLoopMaxRepeat;
    }
    if (originalTiming === undefined) {
      delete process.env.CURSOR_ACP_TIMING;
    } else {
      process.env.CURSOR_ACP_TIMING = originalTiming;
    }
    if (originalLogDir === undefined) {
      delete process.env.CURSOR_ACP_LOG_DIR;
    } else {
      process.env.CURSOR_ACP_LOG_DIR = originalLogDir;
    }
    if (originalLogConsole === undefined) {
      delete process.env.CURSOR_ACP_LOG_CONSOLE;
    } else {
      process.env.CURSOR_ACP_LOG_CONSOLE = originalLogConsole;
    }
    const { _resetLoggerState } = await import("../../src/utils/logger");
    _resetLoggerState();
    delete process.env.MOCK_CURSOR_PROMPT_FILE;
    delete process.env.MOCK_CURSOR_ARGS_FILE;
    delete process.env.MOCK_CURSOR_SCENARIO;
    rmSync(mockDir, { recursive: true, force: true });
  });

  it("intercepts streaming tool_call and terminates with tool_calls finish", async () => {
    process.env.MOCK_CURSOR_SCENARIO = "tool-read-then-text";
    process.env.MOCK_CURSOR_PROMPT_FILE = "";

    const response = await requestCompletion(baseURL, {
      model: "auto",
      stream: true,
      tools: [READ_TOOL],
      messages: [{ role: "user", content: "Read foo.txt" }],
    });

    const body = await response.text();
    const dataLines = parseSseData(body);
    const chunks = parseJsonChunks(dataLines);

    const toolDelta = chunks.find((chunk) => chunk.choices?.[0]?.delta?.tool_calls?.length);
    expect(toolDelta?.choices?.[0]?.delta?.tool_calls?.[0]?.function?.name).toBe("read");
    expect(toolDelta?.choices?.[0]?.delta?.tool_calls?.[0]?.function?.arguments).toContain("foo.txt");

    const finishReasons = chunks.map((chunk) => chunk.choices?.[0]?.finish_reason).filter(Boolean);
    expect(finishReasons).toContain("tool_calls");

    const allContent = chunks
      .map((chunk) => chunk.choices?.[0]?.delta?.content)
      .filter((value): value is string => typeof value === "string");
    expect(allContent).not.toContain("should not appear");
    expect(dataLines[dataLines.length - 1]).toBe("[DONE]");
  });

  it("writes request timing phases for streaming requests", async () => {
    process.env.MOCK_CURSOR_SCENARIO = "assistant-text";

    const response = await requestCompletion(baseURL, {
      model: "auto",
      stream: true,
      messages: [{ role: "user", content: "Say hello" }],
    });

    await response.text();

    const logText = await waitForFileText(join(logDir, "plugin.log"), "Request timing");
    expect(logText).toContain("Request timing");
    expect(logText).toContain("body-parsed");
    expect(logText).toContain("prompt-built");
    expect(logText).toContain("backend-resolved");
    expect(logText).toContain("first-stdout-byte");
    expect(logText).toContain("first-sse-write");
    expect(logText).toContain("request:done");
  });

  it("returns non-streaming tool_calls response", async () => {
    process.env.MOCK_CURSOR_SCENARIO = "tool-read-then-text";
    process.env.MOCK_CURSOR_PROMPT_FILE = "";

    const response = await requestCompletion(baseURL, {
      model: "auto",
      stream: false,
      tools: [READ_TOOL],
      messages: [{ role: "user", content: "Read foo.txt" }],
    });

    const json: any = await response.json();
    expect(json.choices?.[0]?.message?.tool_calls?.[0]?.function?.name).toBe("read");
    expect(json.choices?.[0]?.finish_reason).toBe("tool_calls");
    expect(json.choices?.[0]?.message?.content).toBeNull();
  });

  it("maps updateTodos alias to allowed todowrite in non-stream mode", async () => {
    process.env.MOCK_CURSOR_SCENARIO = "tool-updateTodos-then-text";
    process.env.MOCK_CURSOR_PROMPT_FILE = "";

    const response = await requestCompletion(baseURL, {
      model: "auto",
      stream: false,
      tools: [TODO_WRITE_TOOL],
      messages: [{ role: "user", content: "Create a todo list" }],
    });

    const json: any = await response.json();
    expect(json.choices?.[0]?.message?.tool_calls?.[0]?.function?.name).toBe("todowrite");
    expect(json.choices?.[0]?.finish_reason).toBe("tool_calls");
  });

  it("reroutes non-streaming edit content payloads to write when write is available", async () => {
    process.env.MOCK_CURSOR_SCENARIO = "tool-edit-invalid";
    process.env.MOCK_CURSOR_PROMPT_FILE = "";

    const response = await requestCompletion(baseURL, {
      model: "auto",
      stream: false,
      tools: [EDIT_TOOL, WRITE_TOOL],
      messages: [{ role: "user", content: "Edit TODO.md" }],
    });

    const json: any = await response.json();
    expect(json.choices?.[0]?.message?.tool_calls?.[0]?.function?.name).toBe("write");
    const args = JSON.parse(json.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments ?? "{}");
    expect(args.path).toBe("TODO.md");
    expect(args.content).toBe("full rewrite");
    expect(json.choices?.[0]?.finish_reason).toBe("tool_calls");
  });

  it("reroutes streaming edit content payloads to write when write is available", async () => {
    process.env.MOCK_CURSOR_SCENARIO = "tool-edit-invalid";
    process.env.MOCK_CURSOR_PROMPT_FILE = "";

    const response = await requestCompletion(baseURL, {
      model: "auto",
      stream: true,
      tools: [EDIT_TOOL, WRITE_TOOL],
      messages: [{ role: "user", content: "Edit TODO.md" }],
    });

    const body = await response.text();
    const dataLines = parseSseData(body);
    const chunks = parseJsonChunks(dataLines);

    const toolDelta = chunks.find((chunk) => chunk.choices?.[0]?.delta?.tool_calls?.length);
    expect(toolDelta?.choices?.[0]?.delta?.tool_calls?.[0]?.function?.name).toBe("write");
    expect(toolDelta?.choices?.[0]?.delta?.tool_calls?.[0]?.function?.arguments).toContain("TODO.md");
    expect(toolDelta?.choices?.[0]?.delta?.tool_calls?.[0]?.function?.arguments).toContain("full rewrite");

    const finishReasons = chunks.map((chunk) => chunk.choices?.[0]?.finish_reason).filter(Boolean);
    expect(finishReasons).toContain("tool_calls");

    const allContent = chunks
      .map((chunk) => chunk.choices?.[0]?.delta?.content)
      .filter((value): value is string => typeof value === "string")
      .join("");
    expect(allContent).not.toContain("Skipped malformed tool call");
    expect(allContent).not.toContain("edit fallback text");
  });

  it("converts non-stream bridge JSON into a write tool call", async () => {
    process.env.MOCK_CURSOR_SCENARIO = "assistant-bridge-write";
    process.env.MOCK_CURSOR_PROMPT_FILE = promptFile;

    const response = await requestCompletion(baseURL, {
      model: "auto",
      stream: false,
      tools: [READ_TOOL, WRITE_TOOL],
      messages: [{ role: "user", content: "Update TODO.md" }],
    });

    const json: any = await response.json();
    const toolCall = json.choices?.[0]?.message?.tool_calls?.[0];
    expect(toolCall?.function?.name).toBe("write");
    expect(JSON.parse(toolCall?.function?.arguments ?? "{}")).toEqual({
      path: "TODO.md",
      content: "bridge rewrite",
    });
    expect(json.choices?.[0]?.finish_reason).toBe("tool_calls");

    const promptText = readFileSync(promptFile, "utf8");
    expect(promptText).toContain("opencode bridge mode is active");
  });

  it("converts streaming bridge JSON into a write tool call without leaking JSON text", async () => {
    process.env.MOCK_CURSOR_SCENARIO = "assistant-bridge-write";
    process.env.MOCK_CURSOR_PROMPT_FILE = "";

    const response = await requestCompletion(baseURL, {
      model: "auto",
      stream: true,
      tools: [READ_TOOL, WRITE_TOOL],
      messages: [{ role: "user", content: "Update TODO.md" }],
    });

    const body = await response.text();
    const dataLines = parseSseData(body);
    const chunks = parseJsonChunks(dataLines);
    const toolDelta = chunks.find((chunk) => chunk.choices?.[0]?.delta?.tool_calls?.length);

    expect(toolDelta?.choices?.[0]?.delta?.tool_calls?.[0]?.function?.name).toBe("write");
    expect(toolDelta?.choices?.[0]?.delta?.tool_calls?.[0]?.function?.arguments).toContain("bridge rewrite");

    const allContent = chunks
      .map((chunk) => chunk.choices?.[0]?.delta?.content)
      .filter((value): value is string => typeof value === "string")
      .join("");
    expect(allContent).not.toContain('"name":"write"');
  });

  it("skips streaming edit when write tool is not offered", async () => {
    process.env.MOCK_CURSOR_SCENARIO = "tool-edit-invalid";
    process.env.MOCK_CURSOR_PROMPT_FILE = "";

    const response = await requestCompletion(baseURL, {
      model: "auto",
      stream: true,
      tools: [EDIT_TOOL],
      messages: [{ role: "user", content: "Edit TODO.md" }],
    });

    const body = await response.text();
    const dataLines = parseSseData(body);
    const chunks = parseJsonChunks(dataLines);

    const toolDelta = chunks.find((chunk) => chunk.choices?.[0]?.delta?.tool_calls?.length);
    expect(toolDelta).toBeUndefined();

    const allContent = chunks
      .map((chunk) => chunk.choices?.[0]?.delta?.content)
      .filter((value): value is string => typeof value === "string")
      .join("");
    expect(allContent).toContain("edit fallback text");
  });

  // TODO: Fix test isolation issue - this test passes alone but fails in full suite
  // The guard state appears to be leaked from previous tests
  it.skip("returns loop-guard terminal chunk for repeated schema-invalid edit calls", async () => {
    process.env.MOCK_CURSOR_SCENARIO = "tool-edit-missing-path";
    process.env.MOCK_CURSOR_PROMPT_FILE = "";

    const response = await requestCompletion(baseURL, {
      model: "auto",
      stream: true,
      tools: [EDIT_TOOL],
      messages: [
        { role: "user", content: "Edit TODO.md" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "c1",
              type: "function",
                function: {
                  name: "edit",
                  arguments: "{\"content\":\"full rewrite\"}",
                },
              },
            ],
        },
        {
          role: "tool",
          tool_call_id: "c1",
          content: "Invalid arguments: missing required field path",
        },
      ],
    });

    const body = await response.text();
    const dataLines = parseSseData(body);
    const chunks = parseJsonChunks(dataLines);

    const assistantContent = chunks
      .map((chunk) => chunk.choices?.[0]?.delta?.content)
      .find((value): value is string => typeof value === "string");
    expect(assistantContent).toContain("Tool loop guard stopped repeated schema-invalid calls");

    const toolDelta = chunks.find((chunk) => chunk.choices?.[0]?.delta?.tool_calls?.length);
    expect(toolDelta).toBeUndefined();

    const finishReasons = chunks.map((chunk) => chunk.choices?.[0]?.finish_reason).filter(Boolean);
    expect(finishReasons).toContain("stop");
    expect(finishReasons).not.toContain("tool_calls");
    expect(dataLines[dataLines.length - 1]).toBe("[DONE]");
  });

  it("continues on second turn with role tool result and includes TOOL_RESULT in prompt", async () => {
    process.env.MOCK_CURSOR_SCENARIO = "assistant-text";
    process.env.MOCK_CURSOR_PROMPT_FILE = promptFile;

    const response = await requestCompletion(baseURL, {
      model: "auto",
      stream: true,
      tools: [READ_TOOL],
      messages: [
        { role: "user", content: "Read foo.txt" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "c1",
              type: "function",
              function: { name: "read", arguments: "{\"path\":\"foo.txt\"}" },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "c1",
          content: "{\"content\":\"file contents here\"}",
        },
      ],
    });

    const body = await response.text();
    const dataLines = parseSseData(body);
    const chunks = parseJsonChunks(dataLines);

    const contentTexts = chunks
      .map((chunk) => chunk.choices?.[0]?.delta?.content)
      .filter((value): value is string => typeof value === "string");
    expect(contentTexts.join("")).toContain("The file contains...");

    const finishReasons = chunks.map((chunk) => chunk.choices?.[0]?.finish_reason).filter(Boolean);
    expect(finishReasons).toContain("stop");
    expect(finishReasons).not.toContain("tool_calls");

    const promptText = readFileSync(promptFile, "utf8");
    expect(promptText).toContain("TOOL_RESULT (name: read, call_id: c1): {\"content\":\"file contents here\"}");
  });

  it("continues after a successful write tool result and can stop with DONE", async () => {
    process.env.MOCK_CURSOR_SCENARIO = "assistant-done";
    process.env.MOCK_CURSOR_PROMPT_FILE = promptFile;

    const response = await requestCompletion(baseURL, {
      model: "auto",
      stream: true,
      tools: [WRITE_TOOL],
      messages: [
        { role: "user", content: "Change line 50 and reply DONE after saving" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "c-write-1",
              type: "function",
              function: {
                name: "write",
                arguments: "{\"path\":\"test.txt\",\"content\":\"updated\"}",
              },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "c-write-1",
          content: "Wrote file successfully.",
        },
      ],
    });

    const body = await response.text();
    const dataLines = parseSseData(body);
    const chunks = parseJsonChunks(dataLines);

    const contentTexts = chunks
      .map((chunk) => chunk.choices?.[0]?.delta?.content)
      .filter((value): value is string => typeof value === "string");
    expect(contentTexts.join("")).toContain("DONE");

    const finishReasons = chunks.map((chunk) => chunk.choices?.[0]?.finish_reason).filter(Boolean);
    expect(finishReasons).toContain("stop");
    expect(finishReasons).not.toContain("tool_calls");
    expect(dataLines[dataLines.length - 1]).toBe("[DONE]");

    const promptText = readFileSync(promptFile, "utf8");
    expect(promptText).toContain("TOOL_RESULT (name: write, call_id: c-write-1): Wrote file successfully.");
  });

  it("does not append quota error after successful streamed output", async () => {
    process.env.MOCK_CURSOR_SCENARIO = "assistant-text-quota-exit";
    process.env.MOCK_CURSOR_PROMPT_FILE = "";

    const response = await requestCompletion(baseURL, {
      model: "auto",
      stream: true,
      messages: [{ role: "user", content: "Say hello" }],
    });

    const body = await response.text();
    const dataLines = parseSseData(body);
    const chunks = parseJsonChunks(dataLines);

    const allContent = chunks
      .map((chunk) => chunk.choices?.[0]?.delta?.content)
      .filter((value): value is string => typeof value === "string")
      .join("");

    expect(allContent).toContain("The file contains...");
    expect(allContent).not.toContain("cursor-acp error");
    expect(allContent).not.toContain("Cursor usage limit");
    expect(dataLines[dataLines.length - 1]).toBe("[DONE]");
  });

  it("normalizes provider-prefixed model ids before invoking cursor-agent", async () => {
    process.env.MOCK_CURSOR_SCENARIO = "assistant-text";
    process.env.MOCK_CURSOR_PROMPT_FILE = "";
    process.env.MOCK_CURSOR_ARGS_FILE = argsFile;

    const response = await requestCompletion(baseURL, {
      model: "cursor-acp/auto",
      stream: false,
      messages: [{ role: "user", content: "Say hello" }],
    });

    const json: any = await response.json();
    expect(json.choices?.[0]?.message?.content).toContain("The file contains...");

    const argv = JSON.parse(readFileSync(argsFile, "utf8")) as string[];
    const modelIndex = argv.indexOf("--model");
    expect(modelIndex).toBeGreaterThan(-1);
    expect(argv[modelIndex + 1]).toBe("auto");
  });

  it("does not intercept non-allowed tools", async () => {
    process.env.MOCK_CURSOR_SCENARIO = "tool-bash-then-text";
    process.env.MOCK_CURSOR_PROMPT_FILE = "";

    const response = await requestCompletion(baseURL, {
      model: "auto",
      stream: true,
      tools: [READ_TOOL],
      messages: [{ role: "user", content: "Run bash" }],
    });

    const body = await response.text();
    const dataLines = parseSseData(body);
    const chunks = parseJsonChunks(dataLines);

    const toolDelta = chunks.find((chunk) => chunk.choices?.[0]?.delta?.tool_calls?.length);
    expect(toolDelta?.choices?.[0]?.delta?.tool_calls?.[0]?.function?.name).toBe("bash");

    const finishReasons = chunks.map((chunk) => chunk.choices?.[0]?.finish_reason).filter(Boolean);
    expect(finishReasons).toContain("stop");
    expect(finishReasons).not.toContain("tool_calls");
  });

  it("does not intercept when request tools are empty", async () => {
    process.env.MOCK_CURSOR_SCENARIO = "tool-read-then-text";
    process.env.MOCK_CURSOR_PROMPT_FILE = "";

    const response = await requestCompletion(baseURL, {
      model: "auto",
      stream: true,
      tools: [],
      messages: [{ role: "user", content: "Read foo.txt" }],
    });

    const body = await response.text();
    const dataLines = parseSseData(body);
    const chunks = parseJsonChunks(dataLines);

    const toolDelta = chunks.find((chunk) => chunk.choices?.[0]?.delta?.tool_calls?.length);
    expect(toolDelta?.choices?.[0]?.delta?.tool_calls?.[0]?.function?.name).toBe("read");

    const finishReasons = chunks.map((chunk) => chunk.choices?.[0]?.finish_reason).filter(Boolean);
    expect(finishReasons).toContain("stop");
    expect(finishReasons).not.toContain("tool_calls");
  });
});
