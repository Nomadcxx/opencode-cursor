import {
  extractText,
  extractThinking,
  inferToolName,
  isAssistantText,
  isThinking,
  isToolCall,
  type StreamJsonEvent,
  type StreamJsonToolCallEvent,
} from "./types.js";
import { DeltaTracker } from "./delta-tracker.js";

type OpenAiToolCall = {
  index: number;
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

type OpenAiDelta = {
  content?: string;
  reasoning_content?: string;
  tool_calls?: OpenAiToolCall[];
};

type OpenAiChunk = {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: OpenAiDelta;
    finish_reason: string | null;
  }>;
};

const createChunk = (id: string, created: number, model: string, delta: OpenAiDelta): OpenAiChunk => ({
  id,
  object: "chat.completion.chunk",
  created,
  model,
  choices: [
    {
      index: 0,
      delta,
      finish_reason: null,
    },
  ],
});

export const formatSseChunk = (payload: object) => `data: ${JSON.stringify(payload)}\n\n`;

export const formatSseDone = () => "data: [DONE]\n\n";

export class StreamToSseConverter {
  private readonly id: string;
  private readonly created: number;
  private readonly model: string;
  private readonly tracker = new DeltaTracker();

  constructor(model: string, options?: { id?: string; created?: number }) {
    this.model = model;
    this.id = options?.id ?? `cursor-acp-${Date.now()}`;
    this.created = options?.created ?? Math.floor(Date.now() / 1000);
  }

  handleEvent(event: StreamJsonEvent): string[] {
    if (isAssistantText(event)) {
      const hasPartialTimestamp = typeof (event as any).timestamp_ms === "number";
      if (!hasPartialTimestamp) {
        return [];
      }
      const delta = this.tracker.nextText(extractText(event));
      return delta ? [this.chunkWith({ content: delta })] : [];
    }

    if (isThinking(event)) {
      const delta = this.tracker.nextThinking(extractThinking(event));
      return delta ? [this.chunkWith({ reasoning_content: delta })] : [];
    }

    if (isToolCall(event)) {
      return [this.chunkWith(this.toolCallDelta(event))];
    }

    return [];
  }

  private chunkWith(delta: OpenAiDelta): string {
    return formatSseChunk(createChunk(this.id, this.created, this.model, delta));
  }

  private toolCallDelta(event: StreamJsonToolCallEvent): OpenAiDelta {
    const id = event.call_id ?? "unknown";
    const toolName = inferToolName(event) || "tool";
    const toolKey = Object.keys(event.tool_call ?? {})[0];
    const args = toolKey ? event.tool_call[toolKey]?.args : undefined;
    const argumentsText = args ? JSON.stringify(args) : "";

    return {
      tool_calls: [
        {
          index: 0,
          id,
          type: "function",
          function: {
            name: toolName,
            arguments: argumentsText,
          },
        },
      ],
    };
  }
}
