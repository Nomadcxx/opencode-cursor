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

export type AiSdkStreamPart =
  | {
      type: "text-delta";
      textDelta: string;
    }
  | {
      type: "tool-call-streaming-start";
      toolCallId: string;
      toolName: string;
    }
  | {
      type: "tool-call-delta";
      toolCallId: string;
      toolName: string;
      argsTextDelta: string;
    }
  | {
      type: "tool-input-available";
      toolCallId: string;
      toolName: string;
      inputText: string;
    };

export class StreamToAiSdkParts {
  private readonly toolArgsById = new Map<string, string>();
  private readonly startedToolIds = new Set<string>();
  private emittedText = "";
  private emittedThinking = "";

  handleEvent(event: StreamJsonEvent): AiSdkStreamPart[] {
    if (isAssistantText(event)) {
      const text = extractText(event);
      if (!text) return [];
      const delta = this.nextDelta(text, "text");
      return delta ? [{ type: "text-delta", textDelta: delta }] : [];
    }

    if (isThinking(event)) {
      const text = extractThinking(event);
      if (!text) return [];
      const delta = this.nextDelta(text, "thinking");
      return delta ? [{ type: "text-delta", textDelta: delta }] : [];
    }

    if (isToolCall(event)) {
      return this.handleToolCall(event);
    }

    return [];
  }

  /**
   * Computes the actual new delta, correctly handling both delta-style and
   * accumulated-style partial events from cursor-agent.
   */
  private nextDelta(text: string, channel: "text" | "thinking"): string {
    const emitted = channel === "text" ? this.emittedText : this.emittedThinking;

    if (!emitted) {
      if (channel === "text") this.emittedText = text;
      else this.emittedThinking = text;
      return text;
    }

    if (text.startsWith(emitted)) {
      const delta = text.slice(emitted.length);
      if (channel === "text") this.emittedText = text;
      else this.emittedThinking = text;
      return delta;
    }

    if (emitted.startsWith(text)) {
      return "";
    }

    if (channel === "text") this.emittedText += text;
    else this.emittedThinking += text;
    return text;
  }

  private handleToolCall(event: StreamJsonToolCallEvent): AiSdkStreamPart[] {
    const toolCallId = event.call_id || (event as { tool_call_id?: string }).tool_call_id || "unknown";
    const toolName = inferToolName(event) || "tool";
    const toolKey = Object.keys(event.tool_call ?? {})[0];
    const entry = toolKey ? event.tool_call[toolKey] : undefined;
    const parts: AiSdkStreamPart[] = [];

    if (entry?.args) {
      const argsText = JSON.stringify(entry.args);
      const previous = this.toolArgsById.get(toolCallId) ?? "";
      const delta = argsText.startsWith(previous)
        ? argsText.slice(previous.length)
        : argsText;

      this.toolArgsById.set(toolCallId, argsText);

      if (!this.startedToolIds.has(toolCallId)) {
        this.startedToolIds.add(toolCallId);
        parts.push({
          type: "tool-call-streaming-start",
          toolCallId,
          toolName,
        });
      }

      if (delta) {
        parts.push({
          type: "tool-call-delta",
          toolCallId,
          toolName,
          argsTextDelta: delta,
        });
      }
    }

    if (entry?.result) {
      parts.push({
        type: "tool-input-available",
        toolCallId,
        toolName,
        inputText: JSON.stringify(entry.result),
      });
    }

    return parts;
  }
}
