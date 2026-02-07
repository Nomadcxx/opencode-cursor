export type StreamJsonTextContent = {
  type: "text";
  text: string;
};

export type StreamJsonThinkingContent = {
  type: "thinking";
  thinking: string;
};

export type StreamJsonContent = StreamJsonTextContent | StreamJsonThinkingContent;

export type StreamJsonSystemEvent = {
  type: "system";
  subtype?: string;
  timestamp?: number;
  session_id?: string;
  cwd?: string;
  model?: string;
  permissionMode?: string;
  tools?: Array<{ name: string; description?: string }>;
  message?: string;
};

export type StreamJsonUserEvent = {
  type: "user";
  timestamp?: number;
  session_id?: string;
  message: {
    role: "user";
    content: StreamJsonContent[];
  };
};

export type StreamJsonAssistantEvent = {
  type: "assistant";
  timestamp?: number;
  session_id?: string;
  message: {
    role: "assistant";
    content: StreamJsonContent[];
  };
};

/**
 * Thinking event from cursor-agent stream-json output.
 * Real format: {"type":"thinking","subtype":"delta","text":"...","session_id":"...","timestamp_ms":...}
 * OR: {"type":"thinking","subtype":"completed","session_id":"...","timestamp_ms":...}
 */
export type StreamJsonThinkingEvent = {
  type: "thinking";
  subtype?: "delta" | "completed" | string;
  text?: string;
  timestamp?: number;
  timestamp_ms?: number;
  session_id?: string;
};

export type StreamJsonToolCallPayload = {
  args?: Record<string, unknown>;
  result?: Record<string, unknown>;
};

export type StreamJsonToolCallEvent = {
  type: "tool_call";
  subtype?: string;
  timestamp?: number;
  session_id?: string;
  call_id?: string;
  tool_call: Record<string, StreamJsonToolCallPayload>;
};

export type StreamJsonResultEvent = {
  type: "result";
  subtype?: "success" | "error" | string;
  timestamp?: number;
  session_id?: string;
  is_error?: boolean;
  error?: {
    message?: string;
    code?: number | string;
    details?: string;
  };
};

export type StreamJsonEvent =
  | StreamJsonSystemEvent
  | StreamJsonUserEvent
  | StreamJsonAssistantEvent
  | StreamJsonThinkingEvent
  | StreamJsonToolCallEvent
  | StreamJsonResultEvent;

const hasTextContent = (event: StreamJsonAssistantEvent) =>
  event.message.content.some((content) => content.type === "text");

const hasThinkingContent = (event: StreamJsonAssistantEvent) =>
  event.message.content.some((content) => content.type === "thinking");

export const isAssistantText = (event: StreamJsonEvent): event is StreamJsonAssistantEvent =>
  event.type === "assistant" && hasTextContent(event);

export const isThinking = (
  event: StreamJsonEvent,
): event is StreamJsonAssistantEvent | StreamJsonThinkingEvent => {
  if (event.type === "thinking") {
    return true;
  }

  return event.type === "assistant" && hasThinkingContent(event);
};

export const isToolCall = (event: StreamJsonEvent): event is StreamJsonToolCallEvent =>
  event.type === "tool_call";

export const isResult = (event: StreamJsonEvent): event is StreamJsonResultEvent =>
  event.type === "result";

export const extractText = (event: StreamJsonAssistantEvent) =>
  event.message.content
    .filter((content): content is StreamJsonTextContent => content.type === "text")
    .map((content) => content.text)
    .join("");

export const extractThinking = (
  event: StreamJsonAssistantEvent | StreamJsonThinkingEvent,
): string => {
  if (event.type === "thinking") {
    return event.text ?? "";
  }

  return event.message.content
    .filter(
      (content): content is StreamJsonThinkingContent => content.type === "thinking",
    )
    .map((content) => content.thinking)
    .join("");
};

export const inferToolName = (event: StreamJsonToolCallEvent) => {
  const [key] = Object.keys(event.tool_call ?? {});
  if (!key) {
    return "";
  }

  if (key.endsWith("ToolCall")) {
    const base = key.slice(0, -"ToolCall".length);
    return base.charAt(0).toLowerCase() + base.slice(1);
  }

  return key;
};
