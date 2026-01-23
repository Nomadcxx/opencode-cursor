import type { PromptMetrics, AggregateMetrics } from "./types.js";
import { createLogger } from "./logger.js";

const log = createLogger("MetricsTracker");

export class MetricsTracker {
  private metrics: Map<string, PromptMetrics>;

  constructor() {
    this.metrics = new Map();
  }

  recordPrompt(sessionId: string, model: string, promptTokens: number = 0): void {
    const metrics: PromptMetrics = {
      sessionId,
      model,
      promptTokens,
      toolCalls: 0,
      duration: 0,
      timestamp: Date.now()
    };

    this.metrics.set(sessionId, metrics);
    log.debug(`Recorded prompt for session ${sessionId}`, { model, tokens: promptTokens });
  }

  recordToolCall(sessionId: string, toolName: string, durationMs: number): void {
    const metrics = this.metrics.get(sessionId);
    if (metrics) {
      metrics.toolCalls++;
      metrics.duration += durationMs;
      log.debug(`Recorded tool call for session ${sessionId}`, { tool: toolName, duration: durationMs });
    }
  }

  getSessionMetrics(sessionId: string): PromptMetrics | undefined {
    return this.metrics.get(sessionId);
  }

  getAggregateMetrics(hours: number = 24): AggregateMetrics {
    const cutoff = Date.now() - (hours * 60 * 60 * 1000);
    const relevant = Array.from(this.metrics.values())
      .filter(m => m.timestamp >= cutoff);

    const totalPrompts = relevant.length;
    const totalToolCalls = relevant.reduce((sum, m) => sum + m.toolCalls, 0);
    const totalDuration = relevant.reduce((sum, m) => sum + m.duration, 0);
    const avgDuration = totalPrompts > 0 ? totalDuration / totalPrompts : 0;

    return {
      totalPrompts,
      totalToolCalls,
      totalDuration,
      avgDuration
    };
  }

  clearMetrics(sessionId: string): void {
    this.metrics.delete(sessionId);
  }

  clearAll(): void {
    this.metrics.clear();
  }
}
