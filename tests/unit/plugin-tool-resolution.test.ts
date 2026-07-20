import { describe, expect, it } from "bun:test";
import {
  applyCursorWriteToolContract,
  buildLocalFallbackTools,
  resolveChatParamTools,
} from "../../src/plugin";
import { ToolRegistry as CoreRegistry } from "../../src/tools/core/registry";
import { registerDefaultTools } from "../../src/tools/defaults";

describe("resolveChatParamTools", () => {
  it("preserves existing tools in opencode mode", () => {
    const existing = [{ function: { name: "external_tool" } }];
    const resolved = resolveChatParamTools("opencode", existing, []);

    expect(resolved.action).toBe("preserve");
    expect(resolved.tools).toBe(existing);
  });

  it("uses fallback tools in opencode mode when missing", () => {
    const fallback = [{ function: { name: "oc_bash" } }];
    const resolved = resolveChatParamTools("opencode", undefined, fallback);

    expect(resolved.action).toBe("fallback");
    expect(resolved.tools).toBe(fallback);
  });

  it("overrides with refreshed tools in proxy-exec mode", () => {
    const existing = [{ function: { name: "legacy" } }];
    const refreshed = [{ function: { name: "oc_new" } }];
    const resolved = resolveChatParamTools("proxy-exec", existing, refreshed);

    expect(resolved.action).toBe("override");
    expect(resolved.tools).toBe(refreshed);
  });

  it("returns none when off mode has no changes", () => {
    const existing = [{ function: { name: "keep_me" } }];
    const resolved = resolveChatParamTools("off", existing, [{ function: { name: "ignored" } }]);

    expect(resolved.action).toBe("none");
    expect(resolved.tools).toBe(existing);
  });
});

describe("buildLocalFallbackTools", () => {
  it("exposes local edit and write tools under canonical and oc-prefixed names", () => {
    const registry = new CoreRegistry();
    registerDefaultTools(registry);

    const names = buildLocalFallbackTools(registry).map((tool) => tool.name);

    expect(names).toContain("edit");
    expect(names).toContain("oc_edit");
    expect(names).toContain("write");
    expect(names).toContain("oc_write");
  });
});

describe("applyCursorWriteToolContract", () => {
  it("adds the cursor write contract to preserved OpenCode write tools without mutating input", () => {
    const existing = [
      {
        type: "function",
        function: {
          name: "write",
          description: "Write a file",
        },
      },
      {
        type: "function",
        function: {
          name: "read",
          description: "Read a file",
        },
      },
    ];

    const patched = applyCursorWriteToolContract(existing) as typeof existing;

    expect(patched).not.toBe(existing);
    expect(patched[0]).not.toBe(existing[0]);
    expect(patched[0].function).not.toBe(existing[0].function);
    expect(patched[0].function.description).toContain(
      "Use only for new files or intentional full-file replacement.",
    );
    expect(patched[0].function.description).toContain(
      "For targeted edits to existing files, use edit with old_string and new_string.",
    );
    expect(patched[1]).toBe(existing[1]);
    expect(existing[0].function.description).toBe("Write a file");
  });

  it("uses native OpenCode edit argument names when preserving native tools", () => {
    const existing = [
      {
        type: "function",
        function: {
          name: "edit",
          parameters: {
            type: "object",
            properties: {
              filePath: { type: "string" },
              oldString: { type: "string" },
              newString: { type: "string" },
            },
            required: ["filePath", "oldString", "newString"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "write",
          description: "Write a file",
        },
      },
    ];

    const patched = applyCursorWriteToolContract(existing) as typeof existing;

    expect(patched[1].function.description).toContain(
      "use edit with filePath, oldString, and newString",
    );
    expect(patched[1].function.description).not.toContain("old_string");
  });

  it("does not duplicate the cursor write contract", () => {
    const existing = [
      {
        function: {
          name: "write",
          description:
            "Write a file. Use only for new files or intentional full-file replacement. For targeted edits to existing files, use edit with old_string and new_string.",
        },
      },
    ];

    const patched = applyCursorWriteToolContract(existing) as typeof existing;

    expect(patched[0].function.description).toBe(existing[0].function.description);
  });

  it("adds the cursor write contract to top-level write tool definitions", () => {
    const existing = [
      {
        name: "write",
        description: "Write a file",
      },
    ];

    const patched = applyCursorWriteToolContract(existing) as typeof existing;

    expect(patched).not.toBe(existing);
    expect(patched[0]).not.toBe(existing[0]);
    expect(patched[0].description).toContain(
      "Use only for new files or intentional full-file replacement.",
    );
  });

  it("leaves non-array tool payloads unchanged", () => {
    const existing = { function: { name: "write" } };

    expect(applyCursorWriteToolContract(existing)).toBe(existing);
  });
});
