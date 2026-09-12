import { createLogger } from "./logger.js";

const log = createLogger("perf");

export interface PerfMarker {
  name: string;
  ts: number;
}

export interface PerfPhase {
  name: string;
  deltaMs: number;
  atMs: number;
}

export interface PerfSummary {
  requestId: string;
  total: number;
  phaseTotals: Record<string, number>;
  timeline: PerfPhase[];
}

function isTimingLogEnabled(): boolean {
  const value = process.env.CURSOR_KILO_TIMING?.toLowerCase();
  return value === "1" || value === "true" || value === "on" || value === "yes";
}

export class RequestPerf {
  private markers: PerfMarker[] = [];
  private readonly requestId: string;

  constructor(requestId: string) {
    this.requestId = requestId;
    this.mark("request:start");
  }

  mark(name: string): void {
    this.markers.push({ name, ts: Date.now() });
  }

  /** Log timing summary. Call once at request end. */
  summarize(): PerfSummary | undefined {
    if (this.markers.length < 2) return undefined;
    const start = this.markers[0].ts;
    const phaseTotals: Record<string, number> = {};
    const timeline: PerfPhase[] = [];
    for (let i = 1; i < this.markers.length; i++) {
      const marker = this.markers[i];
      const deltaMs = marker.ts - this.markers[i - 1].ts;
      phaseTotals[marker.name] = (phaseTotals[marker.name] ?? 0) + deltaMs;
      timeline.push({
        name: marker.name,
        deltaMs,
        atMs: marker.ts - start,
      });
    }
    const total = this.markers[this.markers.length - 1].ts - start;
    const summary: PerfSummary = { requestId: this.requestId, total, phaseTotals, timeline };
    if (isTimingLogEnabled()) {
      log.info("Request timing", summary);
    } else {
      log.debug("Request timing", summary);
    }
    return summary;
  }

  /** Get elapsed ms since construction. */
  elapsed(): number {
    return this.markers.length > 0 ? Date.now() - this.markers[0].ts : 0;
  }

  /** Get all markers (for testing). */
  getMarkers(): ReadonlyArray<PerfMarker> {
    return this.markers;
  }
}
