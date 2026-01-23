import { describe, it, expect, beforeEach } from "bun:test";
import { MetricsTracker } from "../../src/acp/metrics.js";

describe("MetricsTracker", () => {
  let tracker: MetricsTracker;

  beforeEach(() => {
    tracker = new MetricsTracker();
  });

  it("should record prompt metrics", async () => {
    tracker.recordPrompt("session-1", "gpt-4", 100);
    
    const metrics = tracker.getSessionMetrics("session-1");
    expect(metrics).toBeDefined();
    expect(metrics?.sessionId).toBe("session-1");
    expect(metrics?.model).toBe("gpt-4");
    expect(metrics?.promptTokens).toBe(100);
    expect(metrics?.toolCalls).toBe(0);
    expect(metrics?.duration).toBe(0);
    expect(metrics?.timestamp).toBeGreaterThan(0);
  });

  it("should record tool calls", async () => {
    tracker.recordPrompt("session-1", "gpt-4", 100);
    tracker.recordToolCall("session-1", "read_file", 50);
    tracker.recordToolCall("session-1", "write_file", 100);
    
    const metrics = tracker.getSessionMetrics("session-1");
    expect(metrics?.toolCalls).toBe(2);
    expect(metrics?.duration).toBe(150);
  });

  it("should calculate aggregate metrics", async () => {
    tracker.recordPrompt("session-1", "gpt-4", 100);
    tracker.recordToolCall("session-1", "read_file", 50);
    
    tracker.recordPrompt("session-2", "gpt-4", 200);
    tracker.recordToolCall("session-2", "write_file", 100);
    tracker.recordToolCall("session-2", "execute", 50);
    
    const aggregate = tracker.getAggregateMetrics(24);
    expect(aggregate.totalPrompts).toBe(2);
    expect(aggregate.totalToolCalls).toBe(3);
    expect(aggregate.totalDuration).toBe(200);
    expect(aggregate.avgDuration).toBe(100);
  });

  it("should clear metrics for a specific session", async () => {
    tracker.recordPrompt("session-1", "gpt-4", 100);
    tracker.recordPrompt("session-2", "gpt-4", 200);
    
    tracker.clearMetrics("session-1");
    
    expect(tracker.getSessionMetrics("session-1")).toBeUndefined();
    expect(tracker.getSessionMetrics("session-2")).toBeDefined();
  });

  it("should clear all metrics", async () => {
    tracker.recordPrompt("session-1", "gpt-4", 100);
    tracker.recordPrompt("session-2", "gpt-4", 200);
    
    tracker.clearAll();
    
    expect(tracker.getSessionMetrics("session-1")).toBeUndefined();
    expect(tracker.getSessionMetrics("session-2")).toBeUndefined();
    
    const aggregate = tracker.getAggregateMetrics(24);
    expect(aggregate.totalPrompts).toBe(0);
  });

  it("should ignore tool calls for non-existent sessions", async () => {
    tracker.recordToolCall("non-existent", "read_file", 50);
    
    const metrics = tracker.getSessionMetrics("non-existent");
    expect(metrics).toBeUndefined();
  });
});
