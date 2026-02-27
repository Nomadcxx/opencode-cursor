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
  private readonly tracker = new DeltaTracker();
  private readonly toolArgsById = new Map<string, string>();
  private readonly startedToolIds = new Set<string>();
  private sawAssistantPartials = false;
  private sawThinkingPartials = false;

  handleEvent(event: StreamJsonEvent): AiSdkStreamPart[] {
    if (isAssistantText(event)) {
      const isPartial = typeof event.timestamp_ms === "number";
      if (isPartial) {
        const text = extractText(event);
        if (text) {
          this.sawAssistantPartials = true;
          return [{ type: "text-delta", textDelta: text }];
        }
        return [];
      }
      if (this.sawAssistantPartials) {
        return [];
      }
      const delta = this.tracker.nextText(extractText(event));
      return delta ? [{ type: "text-delta", textDelta: delta }] : [];
    }

    if (isThinking(event)) {
      const isPartial = typeof event.timestamp_ms === "number";
      if (isPartial) {
        const text = extractThinking(event);
        if (text) {
          this.sawThinkingPartials = true;
          return [{ type: "text-delta", textDelta: text }];
        }
        return [];
      }
      if (this.sawThinkingPartials) {
        return [];
      }
      const delta = this.tracker.nextThinking(extractThinking(event));
      return delta ? [{ type: "text-delta", textDelta: delta }] : [];
    }

    if (isToolCall(event)) {
      return this.handleToolCall(event);
    }

    return [];
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
