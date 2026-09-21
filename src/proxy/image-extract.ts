/**
 * image-extract.ts
 *
 * Extract image parts from OpenAI-style chat messages so they can be forwarded
 * to the Cursor SDK as SDKImage[] instead of being silently dropped by the
 * text-only prompt flattening.
 *
 * opencode attaches images (for attachment-capable models) as content parts of
 * the form `{ type: "image_url", image_url: { url: "data:<mime>;base64,<payload>" } }`
 * inside a message's `content` array (seen for `@ai-sdk/openai-compatible`
 * providers).
 */

/**
 * A subset of the SDK's SDKImage shape (see @cursor/sdk options.d.ts):
 *   SDKImage = { url: string; dimension? } | { data: string; mimeType: string; dimension? }
 * We keep it dependency-free and let the SDKK layer serialize it as-is.
 */
export interface SdkImageLike {
  url?: string;
  data?: string;
  mimeType?: string;
}

/** Parse a data URL `data:<mime>;base64,<payload>` into { mimeType, payload }. */
function parseDataUrl(value: string): { mimeType: string; payload: string } | null {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(value);
  if (!match) return null;
  const mimeType = match[1];
  const payload = match[2];
  if (!mimeType || !payload) return null;
  return { mimeType, payload };
}

/** Extract images from a single content part. Returns null when it isn't an image. */
function extractFromPart(part: unknown): SdkImageLike | null {
  if (!part || typeof part !== "object") return null;
  const p = part as Record<string, any>;

  // Primary form: { type: "image_url", image_url: { url } }
  const imageUrl =
    (p.type === "image_url" && p.image_url && typeof p.image_url.url === "string"
      ? (p.image_url.url as string)
      : undefined) ??
    // Tolerated: { type: "image", url } or { type: "image", image_url: { url } }
    (p.type === "image"
      ? typeof p.url === "string"
        ? (p.url as string)
        : p.image_url && typeof p.image_url.url === "string"
          ? (p.image_url.url as string)
          : undefined
      : undefined);

  if (!imageUrl) return null;

  // Data URL → { data, mimeType }; everything else → { url }.
  if (imageUrl.startsWith("data:")) {
    const parsed = parseDataUrl(imageUrl);
    // A `data:` URL that fails to parse (e.g. empty payload) is malformed;
    // skip it rather than forwarding it as a bare url.
    if (!parsed) return null;
    return { data: parsed.payload, mimeType: parsed.mimeType };
  }
  return { url: imageUrl };
}

/**
 * Extract images from chat messages.
 *
 * Only the LAST user message that contains images is considered — that is the
 * current turn. Earlier images belong to already-flattened tool/assistant
 * turns and, being part of the text prompt history, should not be re-sent as
 * fresh attachments on this request. This mirrors how opencode sends only the
 * current turn's attachments.
 *
 * Returns `undefined` when there are no usable images so callers can keep the
 * request shape identical to today (backward compatible NDJSON).
 */
export function extractImagesFromMessages(messages: unknown): SdkImageLike[] | undefined {
  if (!Array.isArray(messages)) return undefined;

  // Scan from the end to find the last user message carrying image content.
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg || typeof msg !== "object" || (msg as any).role !== "user") continue;
    const content = (msg as any).content;
    if (!Array.isArray(content)) continue;

    const found: SdkImageLike[] = [];
    for (const part of content) {
      const image = extractFromPart(part);
      if (image) found.push(image);
    }
    if (found.length > 0) {
      // Dedupe identical entries (same data+size or same url) while preserving order.
      const seen = new Set<string>();
      const unique: SdkImageLike[] = [];
      for (const img of found) {
        const key = img.data
          ? `d:${img.mimeType}:${img.data.length}`
          : `u:${img.url}`;
        if (seen.has(key)) continue;
        seen.add(key);
        unique.push(img);
      }
      return unique;
    }
  }

  return undefined;
}
