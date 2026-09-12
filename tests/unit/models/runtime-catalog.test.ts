import { describe, expect, it } from "bun:test";
import { buildKiloCatalogFromConfigModels } from "../../../src/models/kilo-catalog.js";
import {
  resolveChatParamsModelRef,
  resolveChatParamsWireModel,
} from "../../../src/models/runtime-catalog.js";

describe("runtime-catalog", () => {
  it("reads session variant from message.model for chat.params", () => {
    const ref = resolveChatParamsModelRef({
      model: { id: "grok-4.6", providerID: "cursor" },
      message: {
        model: {
          providerID: "cursor",
          modelID: "grok-4.6",
          variant: "high",
        },
      },
    });

    expect(ref).toEqual({
      modelID: "grok-4.6",
      variant: "high",
      providerID: "cursor",
    });
  });

  it("resolves wire model from message variant in chat.params", () => {
    const catalog = buildKiloCatalogFromConfigModels({
      "grok-4.6": {
        options: { cursorModel: "cursor-grok-4.6-medium" },
        variants: {
          high: {
            reasoning: { effort: "high" },
            options: { cursorModel: "cursor-grok-4.6-high" },
          },
        },
      },
    });

    const ref = resolveChatParamsModelRef({
      model: { id: "grok-4.6" },
      message: { model: { modelID: "grok-4.6", variant: "high" } },
    });

    expect(resolveChatParamsWireModel(catalog, ref, {})).toBe("cursor-grok-4.6-high");
  });
});
