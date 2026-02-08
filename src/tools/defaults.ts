import type { ToolRegistry } from "./core/registry.js";

/**
 * Register default OpenCode tools in the registry
 */
export function registerDefaultTools(registry: ToolRegistry): void {
  // 1. Bash tool - Execute shell commands
  registry.register({
    id: "bash",
    name: "bash",
    description: "Execute a shell command in a safe environment",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The shell command to execute"
        },
        timeout: {
          type: "number",
          description: "Timeout in milliseconds (default: 30000)"
        },
        cwd: {
          type: "string",
          description: "Working directory for the command"
        }
      },
      required: ["command"]
    },
    source: "local" as const
  }, async (args) => {
    const { exec } = await import("child_process");
    const { promisify } = await import("util");
    const execAsync = promisify(exec);

    try {
      const { stdout, stderr } = await execAsync(args.command, {
        timeout: args.timeout || 30000,
        cwd: args.cwd
      });
      return stdout || stderr || "Command executed successfully";
    } catch (error: any) {
      return `Error: ${error.message}`;
    }
  });

  // 2. Read tool - Read file contents
  registry.register({
    id: "read",
    name: "read",
    description: "Read the contents of a file",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute path to the file to read"
        },
        offset: {
          type: "number",
          description: "Line number to start reading from"
        },
        limit: {
          type: "number",
          description: "Maximum number of lines to read"
        }
      },
      required: ["path"]
    },
    source: "local" as const
  }, async (args) => {
    const fs = await import("fs");
    try {
      let content = fs.readFileSync(args.path, "utf-8");

      if (args.offset !== undefined || args.limit !== undefined) {
        const lines = content.split("\n");
        const start = args.offset || 0;
        const end = args.limit ? start + args.limit : lines.length;
        content = lines.slice(start, end).join("\n");
      }

      return content;
    } catch (error: any) {
      return `Error reading file: ${error.message}`;
    }
  });

  // 3. Write tool - Write file contents
  registry.register({
    id: "write",
    name: "write",
    description: "Write content to a file (creates or overwrites)",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute path to the file to write"
        },
        content: {
          type: "string",
          description: "Content to write to the file"
        }
      },
      required: ["path", "content"]
    },
    source: "local" as const
  }, async (args) => {
    const fs = await import("fs");
    const path = await import("path");
    try {
      // Ensure directory exists
      const dir = path.dirname(args.path);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      fs.writeFileSync(args.path, args.content, "utf-8");
      return `File written successfully: ${args.path}`;
    } catch (error: any) {
      return `Error writing file: ${error.message}`;
    }
  });

  // 4. Edit tool - Edit file contents
  registry.register({
    id: "edit",
    name: "edit",
    description: "Edit a file by replacing old text with new text",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute path to the file to edit"
        },
        old_string: {
          type: "string",
          description: "The text to replace"
        },
        new_string: {
          type: "string",
          description: "The replacement text"
        }
      },
      required: ["path", "old_string", "new_string"]
    },
    source: "local" as const
  }, async (args) => {
    const fs = await import("fs");
    try {
      let content = fs.readFileSync(args.path, "utf-8");

      if (!content.includes(args.old_string)) {
        return `Error: Could not find the text to replace in ${args.path}`;
      }

      content = content.replaceAll(args.old_string, args.new_string);
      fs.writeFileSync(args.path, content, "utf-8");

      return `File edited successfully: ${args.path}`;
    } catch (error: any) {
      return `Error editing file: ${error.message}`;
    }
  });

  // 5. Grep tool - Search file contents
  registry.register({
    id: "grep",
    name: "grep",
    description: "Search for a pattern in files",
    parameters: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "The search pattern (regex supported)"
        },
        path: {
          type: "string",
          description: "Directory or file to search in"
        },
        include: {
          type: "string",
          description: "File pattern to include (e.g., '*.ts')"
        }
      },
      required: ["pattern", "path"]
    },
    source: "local" as const
  }, async (args) => {
    const { exec } = await import("child_process");
    const { promisify } = await import("util");
    const execAsync = promisify(exec);

    try {
      const includeFlag = args.include ? `--include="${args.include}"` : "";
      const { stdout } = await execAsync(
        `grep -r ${includeFlag} -n "${args.pattern}" "${args.path}" 2>/dev/null || true`,
        { timeout: 30000 }
      );

      return stdout || "No matches found";
    } catch (error: any) {
      return `Error searching: ${error.message}`;
    }
  });

  // 6. LS tool - List directory contents
  registry.register({
    id: "ls",
    name: "ls",
    description: "List directory contents",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute path to the directory"
        }
      },
      required: ["path"]
    },
    source: "local" as const
  }, async (args) => {
    const fs = await import("fs");
    const path = await import("path");
    try {
      const entries = fs.readdirSync(args.path, { withFileTypes: true });

      const result = entries.map(entry => {
        const type = entry.isDirectory() ? "d" :
                     entry.isSymbolicLink() ? "l" :
                     entry.isFile() ? "f" : "?";
        return `[${type}] ${entry.name}`;
      });

      return result.join("\n") || "Empty directory";
    } catch (error: any) {
      return `Error listing directory: ${error.message}`;
    }
  });

  // 7. Glob tool - Find files matching pattern
  registry.register({
    id: "glob",
    name: "glob",
    description: "Find files matching a glob pattern",
    parameters: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "Glob pattern (e.g., '**/*.ts')"
        },
        path: {
          type: "string",
          description: "Directory to search in (default: current directory)"
        }
      },
      required: ["pattern"]
    },
    source: "local" as const
  }, async (args) => {
    const { exec } = await import("child_process");
    const { promisify } = await import("util");
    const execAsync = promisify(exec);

    try {
      const cwd = args.path || ".";
      const { stdout } = await execAsync(
        `find "${cwd}" -type f -name "${args.pattern}" 2>/dev/null | head -50`,
        { timeout: 30000 }
      );

      return stdout || "No files found";
    } catch (error: any) {
      return `Error searching: ${error.message}`;
    }
  });
}

/**
 * Get the names of all default tools
 */
export function getDefaultToolNames(): string[] {
  return ["bash", "read", "write", "edit", "grep", "ls", "glob"];
}