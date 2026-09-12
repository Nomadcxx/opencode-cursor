import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  formatAttachmentInstruction,
  resolveAttachmentFromPart,
  rewriteMessagesWithAttachments,
} from "../../../src/proxy/attachments.js";
import { buildPromptFromMessages } from "../../../src/proxy/prompt-builder.js";
import { resolvePromptForBackend } from "../../../src/plugin.js";

const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PNG_DATA = `data:image/png;base64,${PNG_B64}`;

describe("proxy/attachments", () => {
  let workspace = "";

  afterEach(() => {
    if (workspace && existsSync(workspace)) {
      rmSync(workspace, { recursive: true, force: true });
    }
    workspace = "";
  });

  function makeWorkspace(): string {
    workspace = mkdtempSync(join(tmpdir(), "kilo-attachments-"));
    return workspace;
  }

  it("resolves an existing filesystem image path", () => {
    const dir = makeWorkspace();
    const imagePath = join(dir, "shot.png");
    writeFileSync(imagePath, Buffer.from(PNG_B64, "base64"));

    expect(resolveAttachmentFromPart(
      { type: "file", mime: "image/png", filename: "shot.png", url: imagePath },
      dir,
    )).toEqual({
      path: imagePath,
      mime: "image/png",
      filename: "shot.png",
      kind: "image",
    });
  });

  it("resolves file:// URLs and OpenCode source.path", () => {
    const dir = makeWorkspace();
    const pdfPath = join(dir, "notes.pdf");
    writeFileSync(pdfPath, "%PDF-1.4");

    expect(resolveAttachmentFromPart(
      { type: "file", mime: "application/pdf", url: pathToFileURL(pdfPath).href },
      dir,
    )?.path).toBe(pdfPath);

    expect(resolveAttachmentFromPart(
      { type: "file", mime: "application/pdf", source: { path: pdfPath } },
      dir,
    )?.kind).toBe("pdf");
  });

  it("writes data-URL images under .kilo/cursor-attachments", () => {
    const dir = makeWorkspace();
    const resolved = resolveAttachmentFromPart(
      { type: "image_url", image_url: { url: PNG_DATA } },
      dir,
    );
    expect(resolved?.kind).toBe("image");
    expect(resolved?.path.startsWith(join(dir, ".kilo", "cursor-attachments"))).toBe(true);
    expect(existsSync(resolved!.path)).toBe(true);
    expect(resolved?.path.endsWith(".png")).toBe(true);
  });

  it("rewrites user messages so the prompt tells the model to read attachments", () => {
    const dir = makeWorkspace();
    const imagePath = join(dir, "paste.png");
    writeFileSync(imagePath, Buffer.from(PNG_B64, "base64"));

    const rewritten = rewriteMessagesWithAttachments(
      [
        {
          role: "user",
          content: [
            { type: "text", text: "What is in this screenshot?" },
            { type: "image_url", image_url: { url: pathToFileURL(imagePath).href } },
          ],
        },
      ],
      dir,
    );

    const prompt = buildPromptFromMessages(rewritten, []);
    expect(prompt).toContain("What is in this screenshot?");
    expect(prompt).toContain(imagePath);
    expect(prompt).toContain("You MUST call read");
    expect(prompt).not.toContain("data:image/png");
  });

  it("appends read instructions when attachments sit on the message, not in content", () => {
    const dir = makeWorkspace();
    const pdfPath = join(dir, "spec.pdf");
    writeFileSync(pdfPath, "%PDF-1.4");

    const rewritten = rewriteMessagesWithAttachments(
      [
        {
          role: "user",
          content: "Summarize this PDF",
          attachments: [
            { type: "file", mime: "application/pdf", filename: "spec.pdf", url: pdfPath },
          ],
        } as any,
      ],
      dir,
    );

    expect(rewritten[0]?.content).toContain("Summarize this PDF");
    expect(String(rewritten[0]?.content)).toContain(pdfPath);
    expect(String(rewritten[0]?.content)).toContain("application/pdf");
  });

  it("injects attachment read paths in resolvePromptForBackend", () => {
    const dir = makeWorkspace();
    mkdirSync(join(dir, "docs"), { recursive: true });
    const pdfPath = join(dir, "docs", "brief.pdf");
    writeFileSync(pdfPath, "%PDF-1.4");

    const result = resolvePromptForBackend({
      backend: "sdk",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Read the brief" },
            { type: "file", mime: "application/pdf", filename: "brief.pdf", url: pdfPath },
          ],
        },
      ],
      tools: [],
      model: "composer",
      workspaceDirectory: dir,
    });

    expect(result.prompt).toContain("Read the brief");
    expect(result.prompt).toContain(pdfPath);
    expect(result.prompt).toContain("MUST call read");
  });

  it("formatAttachmentInstruction deduplicates paths", () => {
    const text = formatAttachmentInstruction([
      { path: "/tmp/a.png", mime: "image/png", kind: "image" },
      { path: "/tmp/a.png", mime: "image/png", kind: "image" },
    ]);
    expect(text.split("/tmp/a.png").length - 1).toBe(1);
  });
});
