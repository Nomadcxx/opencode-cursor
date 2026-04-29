import { describe, expect, it } from "bun:test";
import {
  createVariantModelEntries,
  groupCursorModels,
  mergeCursorModelEntries,
} from "../../../src/models/variants.js";

describe("models/variants", () => {
  it("groups Cursor model families into base models and variants", () => {
    const result = groupCursorModels([
      { id: "gpt-5.3-codex-low", name: "GPT-5.3 Codex Low" },
      { id: "gpt-5.3-codex-low-fast", name: "GPT-5.3 Codex Low Fast" },
      { id: "gpt-5.3-codex", name: "GPT-5.3 Codex" },
      { id: "gpt-5.3-codex-high", name: "GPT-5.3 Codex High" },
      { id: "gpt-5.3-codex-high-fast", name: "GPT-5.3 Codex High Fast" },
    ]);

    expect(result.direct).toEqual([]);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]).toMatchObject({
      baseId: "gpt-5.3-codex",
      name: "GPT-5.3 Codex",
      defaultCursorModelId: "gpt-5.3-codex",
      variants: {
        low: "gpt-5.3-codex-low",
        "low-fast": "gpt-5.3-codex-low-fast",
        high: "gpt-5.3-codex-high",
        "high-fast": "gpt-5.3-codex-high-fast",
      },
    });
  });

  it("keeps ambiguous product models direct", () => {
    const result = groupCursorModels([
      { id: "auto", name: "Auto" },
      { id: "composer-1.5", name: "Composer 1.5" },
      { id: "gemini-3-flash", name: "Gemini 3 Flash" },
      { id: "gpt-5-mini", name: "GPT-5 Mini" },
      { id: "kimi-k2.5", name: "Kimi K2.5" },
    ]);

    expect(result.groups).toEqual([]);
    expect(result.direct.map(model => model.id)).toEqual([
      "auto",
      "composer-1.5",
      "gemini-3-flash",
      "gpt-5-mini",
      "kimi-k2.5",
    ]);
  });

  it("groups Composer 2 fast under Composer 2 when the base exists", () => {
    const result = groupCursorModels([
      { id: "composer-2", name: "Composer 2" },
      { id: "composer-2-fast", name: "Composer 2 Fast" },
      { id: "composer-1.5", name: "Composer 1.5" },
    ]);

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]).toMatchObject({
      baseId: "composer-2",
      name: "Composer 2",
      defaultCursorModelId: "composer-2",
      variants: {
        fast: "composer-2-fast",
      },
    });
    expect(result.direct.map(model => model.id)).toEqual(["composer-1.5"]);
  });

  it("uses conservative base names for mini, nano, and preview families", () => {
    const result = groupCursorModels([
      { id: "gpt-5.4-mini-none", name: "GPT-5.4 Mini None" },
      { id: "gpt-5.4-mini-low", name: "GPT-5.4 Mini Low" },
      { id: "gpt-5.4-nano-medium", name: "GPT-5.4 Nano Medium" },
      { id: "gpt-5.4-nano-high", name: "GPT-5.4 Nano High" },
      { id: "gpt-5.3-codex-spark-preview-low", name: "GPT-5.3 Codex Spark Preview Low" },
      { id: "gpt-5.3-codex-spark-preview-high", name: "GPT-5.3 Codex Spark Preview High" },
    ]);

    expect(result.groups.map(group => group.baseId)).toEqual([
      "gpt-5.4-mini",
      "gpt-5.4-nano",
      "gpt-5.3-codex-spark-preview",
    ]);
    expect(result.groups[0].variants).toEqual({
      none: "gpt-5.4-mini-none",
      low: "gpt-5.4-mini-low",
    });
  });

  it("folds spark preview models into the parent family when the parent exists", () => {
    const result = groupCursorModels([
      { id: "gpt-5.3-codex-low", name: "GPT-5.3 Codex Low" },
      { id: "gpt-5.3-codex", name: "GPT-5.3 Codex" },
      { id: "gpt-5.3-codex-high", name: "GPT-5.3 Codex High" },
      { id: "gpt-5.3-codex-spark-preview-low", name: "GPT-5.3 Codex Spark Preview Low" },
      { id: "gpt-5.3-codex-spark-preview", name: "GPT-5.3 Codex Spark Preview" },
      { id: "gpt-5.3-codex-spark-preview-high", name: "GPT-5.3 Codex Spark Preview High" },
      { id: "gpt-5.3-codex-spark-preview-xhigh", name: "GPT-5.3 Codex Spark Preview XHigh" },
    ]);

    expect(result.groups).toHaveLength(1);
    expect(result.direct).toEqual([]);
    expect(result.groups[0]).toMatchObject({
      baseId: "gpt-5.3-codex",
      defaultCursorModelId: "gpt-5.3-codex",
      variants: {
        low: "gpt-5.3-codex-low",
        high: "gpt-5.3-codex-high",
        "spark-preview": "gpt-5.3-codex-spark-preview",
        "spark-preview-low": "gpt-5.3-codex-spark-preview-low",
        "spark-preview-high": "gpt-5.3-codex-spark-preview-high",
        "spark-preview-xhigh": "gpt-5.3-codex-spark-preview-xhigh",
      },
    });
  });

  it("groups thinking variants under the non-thinking family", () => {
    const result = groupCursorModels([
      { id: "claude-opus-4-7-low", name: "Claude Opus 4.7 Low" },
      { id: "claude-opus-4-7-thinking-high", name: "Claude Opus 4.7 Thinking High" },
      { id: "claude-opus-4-7-thinking-high-fast", name: "Claude Opus 4.7 Thinking High Fast" },
    ]);

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]).toMatchObject({
      baseId: "claude-opus-4-7",
      variants: {
        low: "claude-opus-4-7-low",
        "thinking-high": "claude-opus-4-7-thinking-high",
        "thinking-high-fast": "claude-opus-4-7-thinking-high-fast",
      },
    });
  });

  it("groups Claude 4.6 Opus thinking variants under one family", () => {
    const result = groupCursorModels([
      { id: "claude-4.6-opus-high", name: "Opus 4.6 1M" },
      { id: "claude-4.6-opus-max", name: "Opus 4.6 1M Max" },
      { id: "claude-4.6-opus-high-thinking", name: "Opus 4.6 1M Thinking" },
      { id: "claude-4.6-opus-high-thinking-fast", name: "Opus 4.6 1M Thinking Fast" },
      { id: "claude-4.6-opus-max-thinking", name: "Opus 4.6 1M Max Thinking" },
      { id: "claude-4.6-opus-max-thinking-fast", name: "Opus 4.6 1M Max Thinking Fast" },
    ]);

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]).toMatchObject({
      baseId: "claude-4.6-opus",
      defaultCursorModelId: "claude-4.6-opus-high",
      variants: {
        high: "claude-4.6-opus-high",
        max: "claude-4.6-opus-max",
        "high-thinking": "claude-4.6-opus-high-thinking",
        "high-thinking-fast": "claude-4.6-opus-high-thinking-fast",
        "max-thinking": "claude-4.6-opus-max-thinking",
        "max-thinking-fast": "claude-4.6-opus-max-thinking-fast",
      },
    });
  });

  it("groups Claude 4.6 Sonnet thinking variants under one family", () => {
    const result = groupCursorModels([
      { id: "claude-4.6-sonnet-medium", name: "Sonnet 4.6 1M" },
      { id: "claude-4.6-sonnet-medium-thinking", name: "Sonnet 4.6 1M Thinking" },
    ]);

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]).toMatchObject({
      baseId: "claude-4.6-sonnet",
      defaultCursorModelId: "claude-4.6-sonnet-medium",
      variants: {
        medium: "claude-4.6-sonnet-medium",
        "medium-thinking": "claude-4.6-sonnet-medium-thinking",
      },
    });
  });

  it("creates OpenCode model entries with cursorModel options and variants", () => {
    const { entries } = createVariantModelEntries([
      { id: "gpt-5.5-medium", name: "GPT-5.5 Medium" },
      { id: "gpt-5.5-high", name: "GPT-5.5 High" },
      { id: "gpt-5.5-extra-high", name: "GPT-5.5 Extra High" },
    ]);

    expect(entries).toEqual({
      "gpt-5.5": {
        name: "GPT 5.5",
        options: {
          cursorModel: "gpt-5.5-medium",
        },
        variants: {
          medium: { cursorModel: "gpt-5.5-medium" },
          high: { cursorModel: "gpt-5.5-high" },
          "extra-high": { cursorModel: "gpt-5.5-extra-high" },
        },
      },
    });
  });

  it("merges compact variant entries while preserving custom models", () => {
    const result = mergeCursorModelEntries(
      {
        "custom-model": { name: "Custom" },
        "gpt-5.3-codex-low": { name: "Old Low" },
        "gpt-5.3-codex-high": { name: "Old High" },
      },
      [
        { id: "gpt-5.3-codex", name: "GPT-5.3 Codex" },
        { id: "gpt-5.3-codex-low", name: "GPT-5.3 Codex Low" },
        { id: "gpt-5.3-codex-high", name: "GPT-5.3 Codex High" },
      ],
      { variants: true, compact: true },
    );

    expect(result.removedCount).toBe(2);
    expect(result.models).toEqual({
      "custom-model": { name: "Custom" },
      "gpt-5.3-codex": {
        name: "GPT-5.3 Codex",
        options: {
          cursorModel: "gpt-5.3-codex",
        },
        variants: {
          low: { cursorModel: "gpt-5.3-codex-low" },
          high: { cursorModel: "gpt-5.3-codex-high" },
        },
      },
    });
  });

  it("keeps default direct sync behavior unchanged", () => {
    const result = mergeCursorModelEntries(
      {
        "custom-model": { name: "Custom" },
      },
      [
        { id: "gpt-5.3-codex-low", name: "GPT-5.3 Codex Low" },
        { id: "gpt-5.3-codex-high", name: "GPT-5.3 Codex High" },
      ],
      { variants: false, compact: false },
    );

    expect(result).toEqual({
      syncedCount: 2,
      groupedCount: 0,
      removedCount: 0,
      models: {
        "custom-model": { name: "Custom" },
        "gpt-5.3-codex-low": { name: "GPT-5.3 Codex Low" },
        "gpt-5.3-codex-high": { name: "GPT-5.3 Codex High" },
      },
    });
  });

  it("keeps raw grouped entries unless compact mode is enabled", () => {
    const result = mergeCursorModelEntries(
      {
        "gpt-5.3-codex-low": { name: "Old Low" },
        "gpt-5.3-codex-high": { name: "Old High" },
      },
      [
        { id: "gpt-5.3-codex", name: "GPT-5.3 Codex" },
        { id: "gpt-5.3-codex-low", name: "GPT-5.3 Codex Low" },
        { id: "gpt-5.3-codex-high", name: "GPT-5.3 Codex High" },
      ],
      { variants: true, compact: false },
    );

    expect(result.removedCount).toBe(0);
    expect(result.models["gpt-5.3-codex-low"]).toEqual({ name: "Old Low" });
    expect(result.models["gpt-5.3-codex-high"]).toEqual({ name: "Old High" });
    expect(result.models["gpt-5.3-codex"]).toEqual({
      name: "GPT-5.3 Codex",
      options: {
        cursorModel: "gpt-5.3-codex",
      },
      variants: {
        low: { cursorModel: "gpt-5.3-codex-low" },
        high: { cursorModel: "gpt-5.3-codex-high" },
      },
    });
  });
});
