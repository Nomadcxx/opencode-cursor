export class DeltaTracker {
  private lastText = "";
  private lastThinking = "";

  nextText(value: string): string {
    const delta = this.diff(this.lastText, value);
    this.lastText = value;
    return delta;
  }

  nextThinking(value: string): string {
    const delta = this.diff(this.lastThinking, value);
    this.lastThinking = value;
    return delta;
  }

  reset(): void {
    this.lastText = "";
    this.lastThinking = "";
  }

  private diff(previous: string, current: string): string {
    if (!previous) {
      return current;
    }

    // Happy path: accumulated text grows with exact prefix match
    if (current.startsWith(previous)) {
      return current.slice(previous.length);
    }

    // Accumulated text was already fully emitted (e.g. duplicate or trimmed event)
    if (previous.startsWith(current)) {
      return "";
    }

    // Prefix mismatch (formatting drift, unicode normalization, whitespace changes):
    // find longest common prefix and emit only the new suffix.
    // This prevents re-emitting the entire accumulated text as a "delta".
    let i = 0;
    const minLen = Math.min(previous.length, current.length);
    while (i < minLen && previous[i] === current[i]) {
      i++;
    }
    return current.slice(i);
  }
}

export class MixedDeltaTracker {
  private emittedText = "";
  private emittedThinking = "";

  nextText(value: string, isDelta = false): string {
    const delta = isDelta ? value : this.diff(this.emittedText, value);
    if (delta) {
      this.emittedText += delta;
    }
    return delta;
  }

  nextThinking(value: string, isDelta = false): string {
    const delta = isDelta ? value : this.diff(this.emittedThinking, value);
    if (delta) {
      this.emittedThinking += delta;
    }
    return delta;
  }

  reset(): void {
    this.emittedText = "";
    this.emittedThinking = "";
  }

  private diff(emitted: string, current: string): string {
    if (!emitted) {
      return current;
    }

    if (current.startsWith(emitted)) {
      return current.slice(emitted.length);
    }

    if (emitted.startsWith(current)) {
      return "";
    }

    return current;
  }
}
