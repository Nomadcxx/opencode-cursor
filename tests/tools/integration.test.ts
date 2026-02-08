import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { ToolRegistry } from "../../src/tools/core/registry.js";
import { ToolExecutor } from "../../src/tools/executor.js";
import { registerDefaultTools, getDefaultToolNames } from "../../src/tools/defaults.js";
import { createToolSchemaPrompt } from "../../src/tools/mapper.js";

describe("Tool Integration Tests", () => {
  let registry: ToolRegistry;
  let executor: ToolExecutor;
  let fs: any;
  let path: any;

  beforeEach(async () => {
    registry = new ToolRegistry();
    executor = new ToolExecutor(registry);
    fs = await import("fs");
    path = await import("path");
  });

  describe("Bash Tool", () => {
    it("should execute echo command", async () => {
      registerDefaultTools(registry);

      const result = await executor.execute("bash", { command: "echo 'Hello World'" });
      expect(result).toContain("Hello World");
    });

    it("should execute pwd command", async () => {
      registerDefaultTools(registry);

      const result = await executor.execute("bash", { command: "pwd" });
      expect(result.length).toBeGreaterThan(0);
    });

    it("should execute ls command", async () => {
      registerDefaultTools(registry);

      const result = await executor.execute("bash", { command: "ls -la" });
      expect(result.length).toBeGreaterThan(0);
    });

    it("should handle command with cwd", async () => {
      registerDefaultTools(registry);

      const result = await executor.execute("bash", {
        command: "pwd",
        cwd: "/tmp"
      });
      expect(result).toContain("/tmp");
    });

    it("should handle command timeout", async () => {
      registerDefaultTools(registry);

      const result = await executor.execute("bash", {
        command: "sleep 0.1 && echo done",
        timeout: 5000
      });
      expect(result).toContain("done");
    });

    it("should handle invalid command gracefully", async () => {
      registerDefaultTools(registry);

      const result = await executor.execute("bash", {
        command: "this_command_does_not_exist_12345"
      });
      expect(result).toContain("Error");
    });
  });

  describe("Read Tool", () => {
    it("should read file contents", async () => {
      registerDefaultTools(registry);

      const tmpFile = `/tmp/read-test-${Date.now()}.txt`;
      fs.writeFileSync(tmpFile, "Test content line 1\nTest content line 2");

      const result = await executor.execute("read", { path: tmpFile });
      expect(result).toBe("Test content line 1\nTest content line 2");

      fs.unlinkSync(tmpFile);
    });

    it("should read with offset", async () => {
      registerDefaultTools(registry);

      const tmpFile = `/tmp/read-offset-test-${Date.now()}.txt`;
      fs.writeFileSync(tmpFile, "line1\nline2\nline3\nline4");

      const result = await executor.execute("read", {
        path: tmpFile,
        offset: 2
      });
      expect(result).toBe("line3\nline4");

      fs.unlinkSync(tmpFile);
    });

    it("should read with limit", async () => {
      registerDefaultTools(registry);

      const tmpFile = `/tmp/read-limit-test-${Date.now()}.txt`;
      fs.writeFileSync(tmpFile, "line1\nline2\nline3\nline4");

      const result = await executor.execute("read", {
        path: tmpFile,
        limit: 2
      });
      expect(result).toBe("line1\nline2");

      fs.unlinkSync(tmpFile);
    });

    it("should handle non-existent file", async () => {
      registerDefaultTools(registry);

      const result = await executor.execute("read", {
        path: "/non/existent/file.txt"
      });
      expect(result).toContain("Error");
    });
  });

  describe("Write Tool", () => {
    it("should write file", async () => {
      registerDefaultTools(registry);

      const tmpFile = `/tmp/write-test-${Date.now()}.txt`;

      const result = await executor.execute("write", {
        path: tmpFile,
        content: "Hello from write tool"
      });

      expect(result).toContain("written successfully");
      expect(fs.existsSync(tmpFile)).toBe(true);
      expect(fs.readFileSync(tmpFile, "utf-8")).toBe("Hello from write tool");

      fs.unlinkSync(tmpFile);
    });

    it("should create directories if needed", async () => {
      registerDefaultTools(registry);

      const tmpDir = `/tmp/nested-dir-${Date.now()}`;
      const tmpFile = path.join(tmpDir, "nested.txt");

      const result = await executor.execute("write", {
        path: tmpFile,
        content: "Nested file content"
      });

      expect(result).toContain("written successfully");
      expect(fs.existsSync(tmpFile)).toBe(true);

      // Cleanup
      fs.unlinkSync(tmpFile);
      fs.rmdirSync(tmpDir);
    });
  });

  describe("Edit Tool", () => {
    it("should replace text in file", async () => {
      registerDefaultTools(registry);

      const tmpFile = `/tmp/edit-test-${Date.now()}.txt`;
      fs.writeFileSync(tmpFile, "Hello World! How are you?");

      const result = await executor.execute("edit", {
        path: tmpFile,
        old_string: "World",
        new_string: "Universe"
      });

      expect(result).toContain("edited successfully");
      expect(fs.readFileSync(tmpFile, "utf-8")).toBe("Hello Universe! How are you?");

      fs.unlinkSync(tmpFile);
    });

    it("should replace multiple occurrences", async () => {
      registerDefaultTools(registry);

      const tmpFile = `/tmp/edit-multi-test-${Date.now()}.txt`;
      fs.writeFileSync(tmpFile, "foo bar foo baz foo");

      const result = await executor.execute("edit", {
        path: tmpFile,
        old_string: "foo",
        new_string: "qux"
      });

      expect(result).toContain("edited successfully");
      expect(fs.readFileSync(tmpFile, "utf-8")).toBe("qux bar qux baz qux");

      fs.unlinkSync(tmpFile);
    });

    it("should handle non-existent old_string", async () => {
      registerDefaultTools(registry);

      const tmpFile = `/tmp/edit-error-${Date.now()}.txt`;
      fs.writeFileSync(tmpFile, "Some content");

      const result = await executor.execute("edit", {
        path: tmpFile,
        old_string: "nonexistent text",
        new_string: "new text"
      });

      expect(result).toContain("Error");
      expect(result).toContain("Could not find");

      fs.unlinkSync(tmpFile);
    });
  });

  describe("Grep Tool", () => {
    it("should find pattern in files", async () => {
      registerDefaultTools(registry);

      const tmpDir = `/tmp/grep-test-${Date.now()}`;
      fs.mkdirSync(tmpDir, { recursive: true });
      fs.writeFileSync(path.join(tmpDir, "file1.txt"), "hello world");
      fs.writeFileSync(path.join(tmpDir, "file2.txt"), "hello universe");
      fs.writeFileSync(path.join(tmpDir, "file3.txt"), "goodbye world");

      const result = await executor.execute("grep", {
        pattern: "hello",
        path: tmpDir
      });

      expect(result).toContain("file1.txt");
      expect(result).toContain("file2.txt");
      expect(result).not.toContain("file3.txt");

      // Cleanup
      fs.unlinkSync(path.join(tmpDir, "file1.txt"));
      fs.unlinkSync(path.join(tmpDir, "file2.txt"));
      fs.unlinkSync(path.join(tmpDir, "file3.txt"));
      fs.rmdirSync(tmpDir);
    });

    it("should handle no matches", async () => {
      registerDefaultTools(registry);

      // Create empty temp directory to ensure no matches
      const tmpDir = `/tmp/grep-test-empty-${Date.now()}`;
      fs.mkdirSync(tmpDir);

      const result = await executor.execute("grep", {
        pattern: "xyz12345nonexistent",
        path: tmpDir
      });

      expect(result).toContain("No matches");

      // Cleanup
      fs.rmdirSync(tmpDir);
    });
  });

  describe("LS Tool", () => {
    it("should list directory contents", async () => {
      registerDefaultTools(registry);

      const result = await executor.execute("ls", { path: "/tmp" });

      expect(result.length).toBeGreaterThan(0);
      expect(result).toContain("[");
      expect(result).toContain("]");
    });

    it("should handle empty directory", async () => {
      registerDefaultTools(registry);

      const tmpDir = `/tmp/empty-${Date.now()}`;
      fs.mkdirSync(tmpDir);

      const result = await executor.execute("ls", { path: tmpDir });

      expect(result).toBe("Empty directory");

      fs.rmdirSync(tmpDir);
    });

    it("should handle non-existent directory", async () => {
      registerDefaultTools(registry);

      const result = await executor.execute("ls", {
        path: "/non/existent/directory"
      });

      expect(result).toContain("Error");
    });
  });

  describe("Glob Tool", () => {
    it("should find files matching pattern", async () => {
      registerDefaultTools(registry);

      const result = await executor.execute("glob", {
        pattern: "*.ts",
        path: "/home/nomadx/opencode-cursor/src"
      });

      expect(result.length).toBeGreaterThan(0);
      expect(result).toContain(".ts");
    });

    it("should handle no matches", async () => {
      registerDefaultTools(registry);

      const result = await executor.execute("glob", {
        pattern: "*.nonexistentxyz",
        path: "/tmp"
      });

      expect(result).toContain("No files found");
    });
  });

  describe("Tool Schema Mapper", () => {
    it("should generate tool schema prompt", () => {
      const tools = registry.list();
      expect(tools.length).toBe(0);

      registerDefaultTools(registry);

      // Convert Tool[] to ToolDefinition[] for mapper
      const toolDefs = registry.list().map(t => ({
        type: "function" as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters
        }
      }));

      const prompt = createToolSchemaPrompt(toolDefs);
      expect(prompt.length).toBeGreaterThan(0);
      expect(prompt).toContain("Tool:");
      expect(prompt).toContain("bash");
    });
  });

  describe("Tool Executor Edge Cases", () => {
    it("should handle unknown tool", async () => {
      let errorThrown = false;
      try {
        await executor.execute("unknown-tool", {});
      } catch (e) {
        errorThrown = true;
        expect(String(e)).toContain("not found");
      }
      expect(errorThrown).toBe(true);
    });

    it("should parse tool call JSON", () => {
      const json = '{"tool": "bash", "arguments": {"command": "echo test"}}';
      const parsed = executor.parseToolCall(json);

      expect(parsed.name).toBe("bash");
      expect(parsed.arguments).toEqual({ command: "echo test" });
    });

    it("should parse OpenAI-style tool call", () => {
      const json = '{"name": "read", "arguments": "{\\"path\\": \\"/etc/hosts\\"}"}';
      const parsed = executor.parseToolCall(json);

      expect(parsed.name).toBe("read");
      expect(parsed.arguments).toEqual({ path: "/etc/hosts" });
    });

    it("should handle invalid JSON", () => {
      let errorThrown = false;
      try {
        executor.parseToolCall("invalid json");
      } catch (e) {
        errorThrown = true;
      }
      expect(errorThrown).toBe(true);
    });
  });

  describe("All 7 Default Tools", () => {
    it("should register all default tools", () => {
      registerDefaultTools(registry);

      const toolNames = getDefaultToolNames();
      expect(toolNames).toHaveLength(7);

      for (const name of toolNames) {
        const tool = registry.getTool(name);
        expect(tool).toBeDefined();
      }
    });

    it("should execute all tools successfully", async () => {
      registerDefaultTools(registry);

      const testFile = `/tmp/all-tools-test-${Date.now()}.txt`;

      // Write
      await executor.execute("write", {
        path: testFile,
        content: "Test content"
      });

      // Read
      const readResult = await executor.execute("read", { path: testFile });
      expect(readResult).toBe("Test content");

      // Edit
      await executor.execute("edit", {
        path: testFile,
        old_string: "content",
        new_string: "updated"
      });

      // Bash
      const bashResult = await executor.execute("bash", {
        command: `cat ${testFile}`
      });
      expect(bashResult).toContain("updated");

      // LS
      const lsResult = await executor.execute("ls", { path: "/tmp" });
      expect(lsResult.toLowerCase()).toContain(testFile.split('/').pop()?.toLowerCase() || '');

      // Grep - use /tmp with file pattern
      const grepResult = await executor.execute("grep", {
        pattern: "updated",
        path: "/tmp",
        include: "all-tools-test*.txt"
      });
      expect(grepResult.toLowerCase()).toContain("updated");

      // Cleanup
      fs.unlinkSync(testFile);
    });
  });
});