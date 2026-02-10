import { createLogger } from "./logger.js";

const log = createLogger("perf");

export interface PerfMarker {
  name: string;
  ts: number;
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

  /** Log timing summary at debug level. Call once at request end. */
  summarize(): void {
    if (this.markers.length < 2) return;
    const start = this.markers[0].ts;
    const phases: Record<string, number> = {};
    for (let i = 1; i < this.markers.length; i++) {
      phases[this.markers[i].name] = this.markers[i].ts - this.markers[i - 1].ts;
    }
    const total = this.markers[this.markers.length - 1].ts - start;
    log.debug("Request timing", { requestId: this.requestId, total, phases });
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
