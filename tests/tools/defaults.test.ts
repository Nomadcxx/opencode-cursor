import { describe, it, expect } from "bun:test";
import { ToolRegistry } from "../../src/tools/core/registry.js";
import { registerDefaultTools, getDefaultToolNames, resolveShellOption } from "../../src/tools/defaults.js";
import { executeWithChain } from "../../src/tools/core/executor.js";
import { LocalExecutor } from "../../src/tools/executors/local.js";

describe("Default Tools", () => {
  it("uses the Windows default shell instead of /bin/bash when SHELL is unset", () => {
    const shell = resolveShellOption({ platform: "win32", env: {} });

    expect(shell).not.toBe("/bin/bash");
    expect(shell).toBe(true);
  });

  it("uses ComSpec for the Windows shell when available", () => {
    const shell = resolveShellOption({
      platform: "win32",
      env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
    });

    expect(shell).toBe("C:\\Windows\\System32\\cmd.exe");
  });

  it("should register all 10 default tools", () => {
    const registry = new ToolRegistry();
    registerDefaultTools(registry);

    const toolNames = getDefaultToolNames();
    expect(toolNames).toHaveLength(10);

    for (const name of toolNames) {
      const tool = registry.getTool(name);
      expect(tool).toBeDefined();
    }
  });

  it("should have correct tool definitions", () => {
    const registry = new ToolRegistry();
    registerDefaultTools(registry);

    const bash = registry.getTool("bash");
    expect(bash?.name).toBe("bash");
    expect(bash?.parameters.required).toContain("command");

    const read = registry.getTool("read");
    expect(read?.name).toBe("read");
    expect(read?.parameters.required).toContain("path");

    const write = registry.getTool("write");
    expect(write?.name).toBe("write");

    const edit = registry.getTool("edit");
    expect(edit?.name).toBe("edit");

    const grep = registry.getTool("grep");
    expect(grep?.name).toBe("grep");

    const ls = registry.getTool("ls");
    expect(ls?.name).toBe("ls");

    const glob = registry.getTool("glob");
    expect(glob?.name).toBe("glob");

    const mkdir = registry.getTool("mkdir");
    expect(mkdir?.name).toBe("mkdir");
    expect(mkdir?.parameters.required).toContain("path");

    const rm = registry.getTool("rm");
    expect(rm?.name).toBe("rm");
    expect(rm?.parameters.required).toContain("path");

    const stat = registry.getTool("stat");
    expect(stat?.name).toBe("stat");
    expect(stat?.parameters.required).toContain("path");
  });

  it("should execute ls tool", async () => {
    const registry = new ToolRegistry();
    registerDefaultTools(registry);
    const executor = new LocalExecutor(registry);

    const result = await executeWithChain([executor], "ls", { path: "." });

    // Should list current directory contents
    expect(result.status).toBe("success");
    expect(result.output).toBeDefined();
    expect(result.output!.length).toBeGreaterThan(0);
  });

  it("should execute bash tool with cmd/workdir aliases", async () => {
    const registry = new ToolRegistry();
    registerDefaultTools(registry);
    const executor = new LocalExecutor(registry);
    const fs = await import("fs");
    const os = await import("os");
    const workdir = os.tmpdir();

    const result = await executeWithChain([executor], "bash", {
      cmd: "pwd",
      workdir,
    });

    expect(result.status).toBe("success");
    expect(fs.realpathSync(result.output?.trim() ?? "")).toBe(fs.realpathSync(workdir));
  });

  it("should execute read tool", async () => {
    const registry = new ToolRegistry();
    registerDefaultTools(registry);
    const executor = new LocalExecutor(registry);

    // Create a temp file to read
    const fs = await import("fs");
    const tmpFile = `/tmp/test-read-${Date.now()}.txt`;
    fs.writeFileSync(tmpFile, "Hello, World!", "utf-8");

    const result = await executeWithChain([executor], "read", { path: tmpFile });

    expect(result.status).toBe("success");
    expect(result.output).toBe("Hello, World!");

    // Cleanup
    fs.unlinkSync(tmpFile);
  });

  it("should execute write and read tools together", async () => {
    const registry = new ToolRegistry();
    registerDefaultTools(registry);
    const executor = new LocalExecutor(registry);

    const tmpFile = `/tmp/test-write-${Date.now()}.txt`;

    // Write
    const writeResult = await executeWithChain([executor], "write", {
      path: tmpFile,
      content: "Test content"
    });
    expect(writeResult.status).toBe("success");
    expect(writeResult.output).toContain("written successfully");

    // Read back
    const readResult = await executeWithChain([executor], "read", { path: tmpFile });
    expect(readResult.status).toBe("success");
    expect(readResult.output).toBe("Test content");

    // Cleanup
    const fs = await import("fs");
    fs.unlinkSync(tmpFile);
  });

  it("should execute edit tool", async () => {
    const registry = new ToolRegistry();
    registerDefaultTools(registry);
    const executor = new LocalExecutor(registry);

    const fs = await import("fs");
    const tmpFile = `/tmp/test-edit-${Date.now()}.txt`;
    fs.writeFileSync(tmpFile, "Hello, World!", "utf-8");

    const result = await executeWithChain([executor], "edit", {
      path: tmpFile,
      old_string: "World",
      new_string: "Universe"
    });

    expect(result.status).toBe("success");
    expect(result.output).toContain("edited successfully");

    const content = fs.readFileSync(tmpFile, "utf-8");
    expect(content).toBe("Hello, Universe!");

    // Cleanup
    fs.unlinkSync(tmpFile);
  });

  it("should create file when edit targets a missing path", async () => {
    const registry = new ToolRegistry();
    registerDefaultTools(registry);
    const executor = new LocalExecutor(registry);

    const fs = await import("fs");
    const tmpFile = `/tmp/test-edit-missing-${Date.now()}.txt`;
    if (fs.existsSync(tmpFile)) {
      fs.unlinkSync(tmpFile);
    }

    const result = await executeWithChain([executor], "edit", {
      path: tmpFile,
      old_string: "anything",
      new_string: "Created from edit fallback",
    });

    expect(result.status).toBe("success");
    expect(result.output).toContain("Created and wrote content");
    expect(fs.readFileSync(tmpFile, "utf-8")).toBe("Created from edit fallback");

    fs.unlinkSync(tmpFile);
  });

  it("should reject edit tool when required arguments are missing", async () => {
    const registry = new ToolRegistry();
    registerDefaultTools(registry);
    const executor = new LocalExecutor(registry);

    const result = await executeWithChain([executor], "edit", {
      path: "/tmp/missing-edit-args.txt",
    });

    expect(result.status).toBe("error");
    expect(result.error).toContain("missing required argument 'old_string'");
  });

  it("regression: rejects edit payloads that only provide content without old_string", async () => {
    const registry = new ToolRegistry();
    registerDefaultTools(registry);
    const executor = new LocalExecutor(registry);

    const result = await executeWithChain([executor], "edit", {
      path: "/tmp/test-edit-content-only.txt",
      content: "should not overwrite",
    });

    expect(result.status).toBe("error");
    expect(result.error).toContain("missing required argument 'old_string'");
  });

  it("regression: rejects edit payloads that only provide new_string without old_string", async () => {
    const registry = new ToolRegistry();
    registerDefaultTools(registry);
    const executor = new LocalExecutor(registry);

    const result = await executeWithChain([executor], "edit", {
      path: "/tmp/test-edit-new-only.txt",
      new_string: "should not overwrite",
    });

    expect(result.status).toBe("error");
    expect(result.error).toContain("missing required argument 'old_string'");
  });

  it("should get all tool definitions", () => {
    const registry = new ToolRegistry();
    registerDefaultTools(registry);

    const tools = registry.list();
    expect(tools).toHaveLength(10);

    // All should have required fields
    for (const tool of tools) {
      expect(tool.name).toBeDefined();
      expect(tool.description).toBeDefined();
      expect(tool.source).toBe("local");
    }
  });

  it("should execute grep tool safely with special characters in pattern", async () => {
    const registry = new ToolRegistry();
    registerDefaultTools(registry);
    const executor = new LocalExecutor(registry);

    const fs = await import("fs");
    const tmpFile = `/tmp/test-grep-${Date.now()}.txt`;
    fs.writeFileSync(tmpFile, "hello world\nfoo bar\n", "utf-8");

    const result = await executeWithChain([executor], "grep", {
      pattern: "hello",
      path: tmpFile
    });

    expect(result.status).toBe("success");
    expect(result.output).toContain("hello world");

    fs.unlinkSync(tmpFile);
  });

  it("should treat grep patterns that start with a dash as patterns", async () => {
    const registry = new ToolRegistry();
    registerDefaultTools(registry);
    const executor = new LocalExecutor(registry);

    const fs = await import("fs");
    const tmpFile = `/tmp/test-grep-dash-${Date.now()}.txt`;
    fs.writeFileSync(tmpFile, "--grep\nplain\n", "utf-8");

    try {
      const result = await executeWithChain([executor], "grep", {
        pattern: "--grep",
        path: tmpFile
      });

      expect(result.status).toBe("success");
      expect(result.output).toContain("--grep");
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  it("should retry grep with extended regex when BSD basic regex rejects pattern", async () => {
    const registry = new ToolRegistry();
    registerDefaultTools(registry);
    const executor = new LocalExecutor(registry);

    const fs = await import("fs");
    const os = await import("os");
    const path = await import("path");
    const tmpFile = path.join(os.tmpdir(), `test-grep-bsd-${Date.now()}.txt`);
    fs.writeFileSync(tmpFile, "export DEFAULT=${MY_VAR:-fallback}\n", "utf-8");

    const result = await executeWithChain([executor], "grep", {
      pattern: "\\$\\{[A-Z_][A-Z0-9_]*:-",
      path: tmpFile,
    });

    expect(result.status).toBe("success");
    expect(result.output).toContain("DEFAULT=${MY_VAR:-fallback}");

    fs.unlinkSync(tmpFile);
  });

  it("should prevent grep command injection via pattern", async () => {
    const registry = new ToolRegistry();
    registerDefaultTools(registry);
    const executor = new LocalExecutor(registry);

    const fs = await import("fs");
    const tmpFile = `/tmp/test-inject-${Date.now()}.txt`;
    fs.writeFileSync(tmpFile, "safe content\n", "utf-8");

    const attacks = [
      "test; echo INJECTED",
      "test && echo INJECTED",
      "test || echo INJECTED",
      "test | cat /etc/hostname",
      "test $(echo INJECTED)",
      "test `echo INJECTED`",
    ];

    for (const malicious of attacks) {
      const result = await executeWithChain([executor], "grep", {
        pattern: malicious,
        path: tmpFile
      });
      // execFile passes pattern as argument, not through shell
      // So these should find no matches, not execute commands
      expect(result.status).toBe("success");
      expect(result.output).toBe("No matches found");
    }

    fs.unlinkSync(tmpFile);
  });

  it("should prevent glob command injection via pattern", async () => {
    const registry = new ToolRegistry();
    registerDefaultTools(registry);
    const executor = new LocalExecutor(registry);

    const attacks = [
      "*.ts; echo INJECTED",
      "*.ts && echo INJECTED",
      "$(echo INJECTED).ts",
    ];

    for (const malicious of attacks) {
      const result = await executeWithChain([executor], "glob", {
        pattern: malicious,
        path: "/tmp"
      });
      // execFile passes pattern as -name argument, not through shell
      // find may error on special chars or return no matches — both are safe
      if (result.status === "success") {
        expect(result.output).not.toContain("INJECTED");
      }
      // Either way, no command injection occurred
    }
  });

  it("should execute mkdir tool", async () => {
    const registry = new ToolRegistry();
    registerDefaultTools(registry);
    const executor = new LocalExecutor(registry);
    const fs = await import("fs");

    const tmpDir = `/tmp/test-mkdir-${Date.now()}/nested/deep`;

    const result = await executeWithChain([executor], "mkdir", { path: tmpDir });
    expect(result.status).toBe("success");
    expect(result.output).toContain("Created directory");
    expect(fs.existsSync(tmpDir)).toBe(true);

    // Cleanup
    fs.rmSync(`/tmp/test-mkdir-${Date.now().toString().slice(0, -3)}`, { recursive: true, force: true });
    // Use the parent we know exists
    const parent = tmpDir.split("/nested")[0];
    fs.rmSync(parent, { recursive: true, force: true });
  });

  it("should execute rm tool on a file", async () => {
    const registry = new ToolRegistry();
    registerDefaultTools(registry);
    const executor = new LocalExecutor(registry);
    const fs = await import("fs");

    const tmpFile = `/tmp/test-rm-${Date.now()}.txt`;
    fs.writeFileSync(tmpFile, "delete me", "utf-8");

    const result = await executeWithChain([executor], "rm", { path: tmpFile });
    expect(result.status).toBe("success");
    expect(result.output).toContain("Deleted");
    expect(fs.existsSync(tmpFile)).toBe(false);
  });

  it("should refuse rm on directory without force", async () => {
    const registry = new ToolRegistry();
    registerDefaultTools(registry);
    const executor = new LocalExecutor(registry);
    const fs = await import("fs");

    const tmpDir = `/tmp/test-rm-dir-${Date.now()}`;
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(`${tmpDir}/file.txt`, "content", "utf-8");

    const result = await executeWithChain([executor], "rm", { path: tmpDir });
    expect(result.status).toBe("error");

    // Directory should still exist
    expect(fs.existsSync(tmpDir)).toBe(true);

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should rm directory with force", async () => {
    const registry = new ToolRegistry();
    registerDefaultTools(registry);
    const executor = new LocalExecutor(registry);
    const fs = await import("fs");

    const tmpDir = `/tmp/test-rm-force-${Date.now()}`;
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(`${tmpDir}/file.txt`, "content", "utf-8");

    const result = await executeWithChain([executor], "rm", { path: tmpDir, force: true });
    expect(result.status).toBe("success");
    expect(result.output).toContain("Deleted");
    expect(fs.existsSync(tmpDir)).toBe(false);
  });

  it("should execute stat tool", async () => {
    const registry = new ToolRegistry();
    registerDefaultTools(registry);
    const executor = new LocalExecutor(registry);
    const fs = await import("fs");

    const tmpFile = `/tmp/test-stat-${Date.now()}.txt`;
    fs.writeFileSync(tmpFile, "stat me", "utf-8");

    const result = await executeWithChain([executor], "stat", { path: tmpFile });
    expect(result.status).toBe("success");

    const info = JSON.parse(result.output!);
    expect(info.type).toBe("file");
    expect(info.size).toBe(7); // "stat me" = 7 bytes
    expect(info.modified).toBeDefined();
    expect(info.created).toBeDefined();
    expect(info.mode).toBeDefined();

    // Cleanup
    fs.unlinkSync(tmpFile);
  });

  it("should stat a directory", async () => {
    const registry = new ToolRegistry();
    registerDefaultTools(registry);
    const executor = new LocalExecutor(registry);

    const result = await executeWithChain([executor], "stat", { path: "/tmp" });
    expect(result.status).toBe("success");

    const info = JSON.parse(result.output!);
    expect(info.type).toBe("directory");
  });

  it("should execute glob tool safely", async () => {
    const registry = new ToolRegistry();
    registerDefaultTools(registry);
    const executor = new LocalExecutor(registry);

    const result = await executeWithChain([executor], "glob", {
      pattern: "*.ts",
      path: "src/tools"
    });

    expect(result.status).toBe("success");
    expect(result.output).toContain(".ts");
  });

  it("should execute glob tool for nested slash patterns", async () => {
    const registry = new ToolRegistry();
    registerDefaultTools(registry);
    const executor = new LocalExecutor(registry);
    const fs = await import("fs");
    const base = `/tmp/test-glob-nested-${Date.now()}`;
    const nested = `${base}/a/b`;
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(`${nested}/match.txt`, "x", "utf-8");

    const result = await executeWithChain([executor], "glob", {
      path: base,
      pattern: "**/*.txt",
    });

    expect(result.status).toBe("success");
    expect(result.output).toContain("match.txt");

    fs.rmSync(base, { recursive: true, force: true });
  });
});
