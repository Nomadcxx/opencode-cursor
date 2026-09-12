/**
 * Materialize Kilo UI image/PDF attachments so cursor-agent can see them.
 *
 * cursor-agent only accepts a text prompt on stdin. The proxy used to drop
 * non-text content parts, so pasted images/PDFs never reached the model.
 * This module resolves those parts to local files and injects read-tool paths.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger } from "../utils/logger.js";
import type { ProxyMessage } from "./incremental-prompt.js";

const log = createLogger("proxy:attachments");

export type ResolvedAttachment = {
  path: string;
  mime: string;
  filename?: string;
  kind: "image" | "pdf" | "file";
};

const MIME_EXTENSION: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
  "application/pdf": ".pdf",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function pickString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function mimeFromFilename(name: string | undefined): string {
  const lower = (name ?? "").toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  if (lower.endsWith(".pdf")) return "application/pdf";
  return "";
}

function extFromMime(mime: string, filename?: string): string {
  if (filename && /\.[a-z0-9]{2,8}$/i.test(filename)) {
    return filename.slice(filename.lastIndexOf(".")).toLowerCase();
  }
  return MIME_EXTENSION[mime.toLowerCase()] ?? ".bin";
}

function kindFromMime(mime: string, path: string): ResolvedAttachment["kind"] {
  const lower = mime.toLowerCase();
  if (lower.startsWith("image/") || /\.(png|jpe?g|gif|webp|svg)$/i.test(path)) {
    return "image";
  }
  if (lower.includes("pdf") || path.toLowerCase().endsWith(".pdf")) {
    return "pdf";
  }
  return "file";
}

function looksLikeDataUrl(value: string): boolean {
  return /^data:[a-z0-9.+\-/]+;base64,/i.test(value);
}

function parseDataUrl(value: string): { mime: string; bytes: Buffer } | null {
  const match = value.match(/^data:([^;,]+);base64,([\s\S]+)$/i);
  if (!match) {
    return null;
  }
  try {
    return { mime: match[1].trim().toLowerCase(), bytes: Buffer.from(match[2], "base64") };
  } catch {
    return null;
  }
}

function decodeBase64Payload(value: unknown): Buffer | null {
  if (typeof value === "string" && value.length > 0 && !value.includes("://") && !value.startsWith("/") && !looksLikeDataUrl(value)) {
    const compact = value.replace(/\s/g, "");
    if (compact.length >= 32 && /^[A-Za-z0-9+/]+=*$/.test(compact)) {
      try {
        return Buffer.from(compact, "base64");
      } catch {
        return null;
      }
    }
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value);
  }
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    return Buffer.from(view.buffer, view.byteOffset, view.byteLength);
  }
  return null;
}

function existingPath(candidate: string | undefined, workspace: string): string | undefined {
  if (!candidate) {
    return undefined;
  }
  let raw = candidate;
  if (raw.startsWith("file://")) {
    try {
      raw = fileURLToPath(raw);
    } catch {
      return undefined;
    }
  }
  if (raw.startsWith("data:") || /^https?:\/\//i.test(raw)) {
    return undefined;
  }
  const resolved = isAbsolute(raw) ? raw : resolvePath(workspace, raw);
  return existsSync(resolved) ? resolved : undefined;
}

function attachmentDir(workspace: string): string {
  return join(workspace, ".kilo", "cursor-attachments");
}

function writeBytes(workspace: string, bytes: Buffer, mime: string, filename?: string): string {
  const dir = attachmentDir(workspace);
  mkdirSync(dir, { recursive: true });
  const digest = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
  const dest = join(dir, `${digest}${extFromMime(mime, filename)}`);
  if (!existsSync(dest)) {
    writeFileSync(dest, bytes);
  }
  return dest;
}

function partLooksBinary(part: Record<string, unknown>): boolean {
  const type = String(part.type ?? "").toLowerCase();
  if (type === "text" || type === "input_text" || type === "output_text") {
    return false;
  }
  if (
    type === "image"
    || type === "image_url"
    || type === "input_image"
    || type === "file"
    || type === "input_file"
    || type === "file_url"
  ) {
    return true;
  }
  const mime = String(part.mime ?? part.mediaType ?? part.mimeType ?? "").toLowerCase();
  if (mime.startsWith("image/") || mime.includes("pdf")) {
    return true;
  }
  return Boolean(part.image_url || part.file || part.source);
}

export function resolveAttachmentFromPart(
  part: unknown,
  workspace: string,
): ResolvedAttachment | null {
  if (!isRecord(part) || !workspace) {
    return null;
  }
  if (!partLooksBinary(part)) {
    return null;
  }

  const nestedFile = isRecord(part.file) ? part.file : {};
  const nestedSource = isRecord(part.source) ? part.source : {};
  const filename = pickString(part.filename, part.name, nestedFile.filename, nestedFile.name);
  const mime = (
    pickString(part.mime, part.mediaType, part.mimeType, nestedFile.mime, nestedFile.mediaType)
    || mimeFromFilename(filename)
    || ""
  ).toLowerCase();

  const locator = pickString(
    part.url,
    isRecord(part.image_url) ? part.image_url.url : undefined,
    typeof part.image_url === "string" ? part.image_url : undefined,
    typeof part.image === "string" ? part.image : undefined,
    isRecord(part.image) ? pickString(part.image.url, part.image.path) : undefined,
    typeof part.data === "string" ? part.data : undefined,
    nestedFile.file_data,
    nestedFile.url,
    nestedFile.path,
    nestedSource.path,
    nestedSource.url,
    part.path,
  );

  const onDisk = existingPath(
    locator,
    workspace,
  ) ?? existingPath(pickString(nestedSource.path, part.path, nestedFile.path), workspace);
  if (onDisk) {
    const resolvedMime = mime || mimeFromFilename(onDisk) || "application/octet-stream";
    return {
      path: onDisk,
      mime: resolvedMime,
      filename,
      kind: kindFromMime(resolvedMime, onDisk),
    };
  }

  if (locator && looksLikeDataUrl(locator)) {
    const parsed = parseDataUrl(locator);
    if (parsed && parsed.bytes.length > 0) {
      const resolvedMime = parsed.mime || mime || "application/octet-stream";
      const path = writeBytes(workspace, parsed.bytes, resolvedMime, filename);
      return { path, mime: resolvedMime, filename, kind: kindFromMime(resolvedMime, path) };
    }
  }

  const rawBytes = decodeBase64Payload(part.data)
    ?? decodeBase64Payload(typeof part.image === "string" ? undefined : part.image)
    ?? decodeBase64Payload(nestedFile.data)
    ?? (locator && !locator.includes("://") ? decodeBase64Payload(locator) : null);
  if (rawBytes && rawBytes.length > 0) {
    const resolvedMime = mime || "application/octet-stream";
    const path = writeBytes(workspace, rawBytes, resolvedMime, filename);
    return { path, mime: resolvedMime, filename, kind: kindFromMime(resolvedMime, path) };
  }

  if (locator && /^https?:\/\//i.test(locator)) {
    log.debug("Skipping remote attachment URL; model can webfetch if needed", {
      kind: kindFromMime(mime, locator),
    });
  }

  return null;
}

function collectParts(message: ProxyMessage): unknown[] {
  const rec = message as Record<string, unknown>;
  const parts: unknown[] = [];
  if (Array.isArray(message.content)) {
    parts.push(...message.content);
  } else if (isRecord(message.content) && partLooksBinary(message.content)) {
    parts.push(message.content);
  }
  for (const key of ["parts", "attachments", "experimental_attachments"]) {
    const extra = rec[key];
    if (Array.isArray(extra)) {
      parts.push(...extra);
    }
  }
  return parts;
}

export function formatAttachmentInstruction(attachments: ResolvedAttachment[]): string {
  const unique = new Map<string, ResolvedAttachment>();
  for (const item of attachments) {
    unique.set(item.path, item);
  }
  const lines = [...unique.values()].map((item) => {
    const label = item.filename ? `${item.path} (${item.mime}; ${item.filename})` : `${item.path} (${item.mime})`;
    return `- ${label}`;
  });
  return [
    "The user attached files in the Kilo UI. Cursor does not receive pasted image/PDF bytes on this bridge.",
    "You MUST call read on each path below before describing or using the file contents:",
    ...lines,
  ].join("\n");
}

export function rewriteMessagesWithAttachments(
  messages: Array<ProxyMessage>,
  workspaceDirectory: string,
): Array<ProxyMessage> {
  if (!workspaceDirectory || messages.length === 0) {
    return messages;
  }

  let changed = false;
  const next = messages.map((message) => {
    const attachments: ResolvedAttachment[] = [];
    for (const part of collectParts(message)) {
      const resolved = resolveAttachmentFromPart(part, workspaceDirectory);
      if (resolved) {
        attachments.push(resolved);
      }
    }
    if (attachments.length === 0) {
      return message;
    }

    changed = true;
    const instruction = formatAttachmentInstruction(attachments);
    if (typeof message.content === "string") {
      const text = message.content.trim() ? `${message.content}\n\n${instruction}` : instruction;
      return { ...message, content: text };
    }
    if (Array.isArray(message.content)) {
      const textParts = message.content.filter((part) => {
        if (!isRecord(part)) {
          return true;
        }
        const type = String(part.type ?? "").toLowerCase();
        return type === "text" || type === "input_text" || type === "output_text";
      });
      return {
        ...message,
        content: [...textParts, { type: "text", text: instruction }],
      };
    }
    return { ...message, content: instruction };
  });

  if (changed) {
    log.debug("Rewrote pasted attachments into read-tool paths", {
      messageCount: messages.length,
    });
  }
  return changed ? next : messages;
}
