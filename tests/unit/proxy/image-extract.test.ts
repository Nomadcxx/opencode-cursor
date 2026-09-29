import { describe, expect, it } from "bun:test";
import { extractImagesFromMessages } from "../../../src/proxy/image-extract.js";

describe("extractImagesFromMessages", () => {
  it("extracts a single data URL image_url part", () => {
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "look at this" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
        ],
      },
    ];
    expect(extractImagesFromMessages(messages)).toEqual([
      { data: "AAAA", mimeType: "image/png" },
    ]);
  });

  it("extracts multiple image parts preserving order", () => {
    const messages = [
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
          { type: "image_url", image_url: { url: "data:image/jpeg;base64,BBBB" } },
        ],
      },
    ];
    expect(extractImagesFromMessages(messages)).toEqual([
      { data: "AAAA", mimeType: "image/png" },
      { data: "BBBB", mimeType: "image/jpeg" },
    ]);
  });

  it("handles mixed text+image content arrays", () => {
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "hello" },
          { type: "image_url", image_url: { url: "data:image/webp;base64,CCCC" } },
          { type: "text", text: "world" },
        ],
      },
    ];
    expect(extractImagesFromMessages(messages)).toEqual([
      { data: "CCCC", mimeType: "image/webp" },
    ]);
  });

  it("converts non-data URLs to { url } form", () => {
    const messages = [
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: "https://example.com/a.png" } },
        ],
      },
    ];
    expect(extractImagesFromMessages(messages)).toEqual([
      { url: "https://example.com/a.png" },
    ]);
  });

  it("tolerates type:image with url or image_url.url", () => {
    const messages = [
      {
        role: "user",
        content: [
          { type: "image", url: "https://example.com/b.png" },
          { type: "image", image_url: { url: "https://example.com/c.png" } },
        ],
      },
    ];
    expect(extractImagesFromMessages(messages)).toEqual([
      { url: "https://example.com/b.png" },
      { url: "https://example.com/c.png" },
    ]);
  });

  it("returns undefined when there are no images", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "no image here" }] },
      { role: "user", content: "plain string content" },
    ];
    expect(extractImagesFromMessages(messages)).toBeUndefined();
  });

  it("returns undefined when messages is not an array", () => {
    expect(extractImagesFromMessages(undefined)).toBeUndefined();
    expect(extractImagesFromMessages({})).toBeUndefined();
    expect(extractImagesFromMessages(null)).toBeUndefined();
  });

  it("skips malformed/empty image entries", () => {
    const messages = [
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: "" } },
          { type: "image_url", image_url: {} },
          { type: "image_url", image_url: { url: "data:image/png;base64," } },
          { type: "image_url" },
          { type: "text", text: "x" },
        ],
      },
    ];
    expect(extractImagesFromMessages(messages)).toBeUndefined();
  });

  it("extracts images from the last user message when it has them", () => {
    const messages = [
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: "data:image/png;base64,OLD" } },
        ],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
      },
      {
        role: "user",
        content: [
          { type: "text", text: "current turn" },
          { type: "image_url", image_url: { url: "data:image/png;base64,NEW" } },
        ],
      },
    ];
    expect(extractImagesFromMessages(messages)).toEqual([
      { data: "NEW", mimeType: "image/png" },
    ]);
  });

  it("returns undefined when the last user message has no images even if an earlier one does", () => {
    // A text-only turn must not re-send an old image: only the LAST user
    // message is considered, so an earlier user message's image is ignored.
    const messages = [
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: "data:image/png;base64,X" } },
        ],
      },
      { role: "user", content: "no image here" },
    ];
    expect(extractImagesFromMessages(messages)).toBeUndefined();
  });

  it("dedupes identical entries while preserving order", () => {
    const messages = [
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: "data:image/png;base64,SAME" } },
          { type: "image_url", image_url: { url: "data:image/png;base64,SAME" } },
          { type: "image_url", image_url: { url: "https://example.com/u.png" } },
          { type: "image_url", image_url: { url: "https://example.com/u.png" } },
        ],
      },
    ];
    expect(extractImagesFromMessages(messages)).toEqual([
      { data: "SAME", mimeType: "image/png" },
      { url: "https://example.com/u.png" },
    ]);
  });

  it("keeps distinct images that share a mime type and payload length", () => {
    const messages = [
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
          { type: "image_url", image_url: { url: "data:image/png;base64,BBBB" } },
        ],
      },
    ];
    expect(extractImagesFromMessages(messages)).toEqual([
      { data: "AAAA", mimeType: "image/png" },
      { data: "BBBB", mimeType: "image/png" },
    ]);
  });
});
