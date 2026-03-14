import type { ToolRegistry } from "./core/registry.js";

/**
 * Register default OpenCode tools in the registry
 */
export function registerDefaultTools(registry: ToolRegistry): void {
  // 1. Bash tool - Execute shell commands
  registry.register({
    id: "bash",
    name: "bash",
    description: "Execute a shell command. Use this to run programs/tests; prefer write/edit for creating or modifying files.",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The shell command to execute"
        },
        timeout: {
          type: "number",
          description: "Timeout in seconds (default: 30)"
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
    const { spawn } = await import("child_process");

    const command = resolveBashCommand(args);
    if (!command) {
      throw new Error("bash: missing required argument 'command'");
    }
    const timeoutMs = resolveTimeoutMs(args.timeout);
    const cwd = resolveWorkingDirectory(args);

    return new Promise<string>((resolve, reject) => {
      const proc = spawn(command, {
        shell: process.env.SHELL || (process.platform === "win32" ? "cmd.exe" : "/bin/bash"),
        cwd,
      });

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill("SIGTERM");
      }, timeoutMs);

      proc.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
      proc.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

      proc.on("close", (code) => {
        clearTimeout(timer);
        const stdout = Buffer.concat(stdoutChunks).toString("utf8");
        const stderr = Buffer.concat(stderrChunks).toString("utf8");
        const output = stdout || stderr || "Command executed successfully";
        if (timedOut) {
          resolve(`Command timed out after ${timeoutMs / 1000}s\n${output}`);
        } else if (code !== 0) {
          resolve(`${output}\n[Exit code: ${code}]`);
        } else {
          resolve(output);
        }
      });

      proc.on("error", reject);
    });
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
      const path = args.path as string;
      const offset = args.offset as number | undefined;
      const limit = args.limit as number | undefined;
      let content = fs.readFileSync(path, "utf-8");

      if (offset !== undefined || limit !== undefined) {
        const lines = content.split("\n");
        const start = offset || 0;
        const end = limit ? start + limit : lines.length;
        content = lines.slice(start, end).join("\n");
      }

      return content;
    } catch (error: any) {
      throw error;
    }
  });

  // 3. Write tool - Write file contents
  registry.register({
    id: "write",
    name: "write",
    description: "Write content to a file (creates or overwrites). Prefer this over using bash redirection/heredocs for file creation.",
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
      const filePath = args.path as string;
      const content = args.content as string;
      // Ensure directory exists
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      fs.writeFileSync(filePath, content, "utf-8");
      return `File written successfully: ${filePath}`;
    } catch (error: any) {
      throw error;
    }
  });

  // 4. Edit tool - Edit file contents
  registry.register({
    id: "edit",
    name: "edit",
    description: "Edit a file by replacing old text with new text. Use for targeted replacements; use write to overwrite an entire file.",
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
    const path = await import("path");
    try {
      const resolvedArgs = resolveEditArguments(args);
      const filePath = resolvedArgs.path;
      const oldString = resolvedArgs.old_string;
      const newString = resolvedArgs.new_string;
      if (!filePath) {
        throw new Error("edit: missing required argument 'path'");
      }
      if (typeof oldString !== "string") {
        throw new Error("edit: missing required argument 'old_string'");
      }
      if (typeof newString !== "string") {
        throw new Error("edit: missing required argument 'new_string'");
      }
      let content = "";
      try {
        content = fs.readFileSync(filePath, "utf-8");
      } catch (error: any) {
        if (error?.code === "ENOENT") {
          const dir = path.dirname(filePath);
          if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
          }
          fs.writeFileSync(filePath, newString, "utf-8");
          return `File did not exist. Created and wrote content: ${filePath}`;
        }
        throw error;
      }

      if (!oldString) {
        fs.writeFileSync(filePath, newString, "utf-8");
        return `File edited successfully: ${filePath}`;
      }

      if (!content.includes(oldString)) {
        return `Error: Could not find the text to replace in ${filePath}`;
      }

      content = content.replaceAll(oldString, newString);
      fs.writeFileSync(filePath, content, "utf-8");

      return `File edited successfully: ${filePath}`;
    } catch (error: any) {
      throw error;
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
    const { execFile } = await import("child_process");
    const { promisify } = await import("util");
    const execFileAsync = promisify(execFile);

    const pattern = args.pattern as string;
    const path = args.path as string;
    const include = args.include as string | undefined;

    if (process.platform === "win32") { return await nodeFallbackGrep(pattern, path, include); }

    const grepArgs = ["-r", "-n"];
    if (include) {
      grepArgs.push(`--include=${include}`);
    }
    grepArgs.push(pattern, path);

    const runGrep = async (extraArgs: string[] = []) => {
      return execFileAsync("grep", [...extraArgs, ...grepArgs], { timeout: 30000 });
    };

    try {
      const { stdout } = await runGrep();
      return stdout || "No matches found";
    } catch (error: any) {
      // grep exits with code 1 when no matches found — not an error
      if (error.code === 1) {
        return "No matches found";
      }

      const stderr = typeof error?.stderr === "string" ? error.stderr : "";
      const isRegexSyntaxError = error.code === 2
        && /(invalid regular expression|invalid repetition count|braces not balanced|repetition-operator operand invalid|unmatched(\s*\\?\{)?)/i.test(stderr);

      // BSD grep uses basic regex by default and can reject patterns that work in ERE.
      // Retry with -E so patterns like \$\{[A-Z_][A-Z0-9_]*:- are handled.
      if (isRegexSyntaxError) {
        try {
          const { stdout } = await runGrep(["-E"]);
          return stdout || "No matches found";
        } catch (extendedError: any) {
          if (extendedError.code === 1) {
            return "No matches found";
          }
          throw extendedError;
        }
      }

      throw error;
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
      const dirPath = args.path as string;
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });

      const result = entries.map(entry => {
        const type = entry.isDirectory() ? "d" :
                     entry.isSymbolicLink() ? "l" :
                     entry.isFile() ? "f" : "?";
        return `[${type}] ${entry.name}`;
      });

      return result.join("\n") || "Empty directory";
    } catch (error: any) {
      throw error;
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
    const { execFile } = await import("child_process");
    const { promisify } = await import("util");
    const execFileAsync = promisify(execFile);

    const pattern = resolveGlobPattern(args);
    if (!pattern) {
      throw new Error("glob: missing required argument 'pattern'");
    }
    const path = resolvePathArg(args, "glob");
    const cwd = path || ".";
    const normalizedPattern = pattern.replace(/\\/g, "/");
    if (process.platform === "win32") { return await nodeFallbackGlob(normalizedPattern, cwd); }
    const isPathPattern = normalizedPattern.includes("/");
    const findArgs = [cwd, "-type", "f"];
    if (isPathPattern) {
      if (cwd === "." || cwd === "./") {
        const dotPattern = normalizedPattern.startsWith("./")
          ? normalizedPattern
          : `./${normalizedPattern}`;
        findArgs.push("(", "-path", normalizedPattern, "-o", "-path", dotPattern, ")");
      } else {
        findArgs.push("-path", normalizedPattern);
      }
    } else {
      findArgs.push("-name", normalizedPattern);
    }

    try {
      const { stdout } = await execFileAsync("find", findArgs, { timeout: 30000 });
      // Limit output to 50 lines (replaces piped `| head -50`)
      const lines = (stdout || "").split("\n").filter(Boolean);
      return lines.slice(0, 50).join("\n") || "No files found";
    } catch (error: any) {
      const stdout = typeof error?.stdout === "string" ? error.stdout : "";
      const stderr = typeof error?.stderr === "string" ? error.stderr : "";
      // Permission-denied and "no results" scenarios from find should not be fatal.
      if (error?.code === 1 || stderr.includes("Permission denied")) {
        const lines = stdout.split("\n").filter(Boolean);
        return lines.slice(0, 50).join("\n") || "No files found";
      }
      throw error;
    }
  });

  // 8. Mkdir tool - Create directories
  registry.register({
    id: "mkdir",
    name: "mkdir",
    description: "Create a directory, including parent directories if needed",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Directory path to create"
        }
      },
      required: ["path"]
    },
    source: "local" as const
  }, async (args) => {
    const { mkdir } = await import("fs/promises");
    const { resolve } = await import("path");
    const rawPath = resolvePathArg(args, "mkdir");
    if (!rawPath) {
      throw new Error("mkdir: missing required argument 'path'");
    }
    const target = resolve(rawPath);
    await mkdir(target, { recursive: true });
    return `Created directory: ${target}`;
  });

  // 9. Rm tool - Delete files/directories
  registry.register({
    id: "rm",
    name: "rm",
    description: "Delete a file or directory. Use force: true for non-empty directories.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to delete"
        },
        force: {
          type: "boolean",
          description: "If true, recursively delete non-empty directories"
        }
      },
      required: ["path"]
    },
    source: "local" as const
  }, async (args) => {
    const { rm, stat } = await import("fs/promises");
    const { resolve } = await import("path");
    const rawPath = resolvePathArg(args, "rm");
    if (!rawPath) {
      throw new Error("rm: missing required argument 'path'");
    }
    const target = resolve(rawPath);
    const force = resolveBoolean(args.force, false);
    const info = await stat(target);
    if (info.isDirectory() && !force) {
      throw new Error("Directory not empty. Use force: true to delete recursively.");
    }
    await rm(target, { recursive: force });
    return `Deleted: ${target}`;
  });

  // 10. Stat tool - Get file/directory metadata
  registry.register({
    id: "stat",
    name: "stat",
    description: "Get file or directory information: size, type, permissions, timestamps",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to inspect"
        }
      },
      required: ["path"]
    },
    source: "local" as const
  }, async (args) => {
    const { stat } = await import("fs/promises");
    const { resolve } = await import("path");
    const rawPath = resolvePathArg(args, "stat");
    if (!rawPath) {
      throw new Error("stat: missing required argument 'path'");
    }
    const target = resolve(rawPath);
    const info = await stat(target);
    return JSON.stringify({
      path: target,
      type: info.isDirectory() ? "directory" : info.isFile() ? "file" : "other",
      size: info.size,
      mode: info.mode.toString(8),
      modified: info.mtime.toISOString(),
      created: info.birthtime.toISOString(),
    }, null, 2);
  });
}

function resolveEditArguments(args: Record<string, unknown>): {
  path: string;
  old_string: string | undefined;
  new_string: string | undefined;
} {
  const path = typeof args.path === "string" ? args.path : "";
  let oldString = typeof args.old_string === "string" ? args.old_string : undefined;
  let newString = typeof args.new_string === "string" ? args.new_string : undefined;

  if (newString === undefined) {
    const fallbackContent = coerceToString(args.content ?? args.streamContent);
    if (fallbackContent !== null) {
      newString = fallbackContent;
    }
  }

  if (oldString === undefined && newString !== undefined) {
    oldString = "";
  }

  return {
    path,
    old_string: oldString,
    new_string: newString,
  };
}

function resolveBashCommand(args: Record<string, unknown>): string | null {
  const direct = coerceToString(args.command ?? args.cmd ?? args.script ?? args.input);
  if (direct !== null && direct.trim().length > 0) {
    return direct;
  }

  if (Array.isArray(args.command)) {
    const parts = args.command
      .map((part) => coerceToString(part))
      .filter((part): part is string => typeof part === "string" && part.trim().length > 0);
    if (parts.length > 0) {
      return parts.join(" ");
    }
  }

  const commandObject = args.command;
  if (typeof commandObject === "object" && commandObject !== null && !Array.isArray(commandObject)) {
    const record = commandObject as Record<string, unknown>;
    const base = coerceToString(record.command ?? record.cmd);
    if (base !== null && base.trim().length > 0) {
      if (Array.isArray(record.args)) {
        const argParts = record.args
          .map((entry) => coerceToString(entry))
          .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
        return argParts.length > 0 ? `${base} ${argParts.join(" ")}` : base;
      }
      return base;
    }
  }

  return null;
}

function resolveWorkingDirectory(args: Record<string, unknown>): string | undefined {
  const cwd = coerceToString(args.cwd ?? args.workdir ?? args.path);
  if (cwd !== null && cwd.trim().length > 0) {
    return cwd;
  }
  return undefined;
}

function resolveGlobPattern(args: Record<string, unknown>): string | null {
  const direct = coerceToString(
    args.pattern
      ?? args.globPattern
      ?? args.filePattern
      ?? args.searchPattern
      ?? args.includePattern,
  );
  if (direct !== null && direct.trim().length > 0) {
    return direct;
  }
  return null;
}

function resolvePathArg(args: Record<string, unknown>, toolName: string): string | null {
  const value = coerceToString(
    args.path
      ?? args.filePath
      ?? args.targetPath
      ?? args.directory
      ?? args.dir
      ?? args.folder
      ?? args.targetDirectory
      ?? args.targetFile,
  );
  if (value !== null && value.trim().length > 0) {
    return value;
  }
  if (toolName === "glob") {
    return ".";
  }
  return null;
}

function resolveTimeout(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return undefined;
}

// Convert model-supplied timeout (seconds) to milliseconds. Falls back to 30s.
function resolveTimeoutMs(value: unknown): number {
  const raw = resolveTimeout(value);
  if (raw === undefined) return 30_000;
  // Values ≤ 600 are treated as seconds (no real use case for a <600ms shell timeout).
  return raw <= 600 ? raw * 1000 : raw;
}

function resolveBoolean(value: unknown, defaultValue: boolean): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "1" || normalized === "yes") {
      return true;
    }
    if (normalized === "false" || normalized === "0" || normalized === "no") {
      return false;
    }
  }
  return defaultValue;
}

function coerceToString(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (value === null || value === undefined) {
    return null;
  }
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const item of value) {
      if (typeof item === "string") {
        parts.push(item);
      } else if (typeof item === "object" && item !== null) {
        const record = item as Record<string, unknown>;
        if (typeof record.text === "string") {
          parts.push(record.text);
        } else if (typeof record.content === "string") {
          parts.push(record.content);
        } else if (typeof record.value === "string") {
          parts.push(record.value);
        } else {
          parts.push(JSON.stringify(record));
        }
      } else {
        parts.push(String(item));
      }
    }
    return parts.length > 0 ? parts.join("") : null;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.text === "string") {
      return record.text;
    }
    if (typeof record.content === "string") {
      return record.content;
    }
    if (typeof record.value === "string") {
      return record.value;
    }
    return JSON.stringify(record);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return null;
}

/**
 * Get the names of all default tools
 */
export function getDefaultToolNames(): string[] {
  return ["bash", "read", "write", "edit", "grep", "ls", "glob", "mkdir", "rm", "stat"];
}

async function nodeFallbackGrep(pattern: string, searchPath: string, include?: string): Promise<string> {
  const fs = await import("fs/promises");
  const path = await import("path");
  
  const results: string[] = [];
  let regex: RegExp;
  try {
    regex = new RegExp(pattern);
  } catch (e) {
    try {
      regex = new RegExp(pattern.replace(/[.*+?^\\$\\{}()|[\\]\\\\]/g, '\\\\$&'));
    } catch {
      return "Invalid regex pattern";
    }
  }

  let includeRegex: RegExp | undefined;
  if (include) {
    const incPattern = include.replace(/\\./g, '\\\\.').replace(/\\*/g, '.*');
    includeRegex = new RegExp(`^${incPattern}$`);
  }

  async function walk(dir: string) {
    if (results.length >= 100) return;
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (results.length >= 100) return;
        
        const fullPath = path.join(dir, entry.name);
        
        if (entry.isDirectory()) {
          if (!['node_modules', '.git', 'dist', 'build'].includes(entry.name)) {
            await walk(fullPath);
          }
        } else if (entry.isFile()) {
          if (includeRegex && !includeRegex.test(entry.name)) {
            continue;
          }
          
          try {
            const content = await fs.readFile(fullPath, 'utf-8');
            const lines = content.split('\\n');
            for (let i = 0; i < lines.length; i++) {
              if (regex.test(lines[i])) {
                results.push(`${fullPath}:${i + 1}:${lines[i]}`);
                if (results.length >= 100) break;
              }
            }
          } catch {
            // ignore unreadable files
          }
        }
      }
    } catch {
      // ignore
    }
  }

  try {
    const stat = await fs.stat(searchPath);
    if (stat.isFile()) {
      try {
        const content = await fs.readFile(searchPath, 'utf-8');
        const lines = content.split('\\n');
        for (let i = 0; i < lines.length; i++) {
          if (regex.test(lines[i])) {
            results.push(`${searchPath}:${i + 1}:${lines[i]}`);
            if (results.length >= 100) break;
          }
        }
      } catch {}
    } else {
      await walk(searchPath);
    }
  } catch {
    return "Path not found";
  }

  return results.join('\\n') || "No matches found";
}

async function nodeFallbackGlob(pattern: string, searchPath: string): Promise<string> {
  const fs = await import("fs/promises");
  const path = await import("path");
  
  const results: string[] = [];
  
  const isPathPattern = pattern.includes("/");
  let regexPattern = pattern
    .replace(/\\./g, '\\\\.')
    .replace(/\\*\\*/g, '.*')
    .replace(/\\*/g, '[^/]*');
    
  if (!isPathPattern) {
    regexPattern = `^${regexPattern}$`;
  } else if (!regexPattern.startsWith('.*')) {
    regexPattern = `.*${regexPattern}$`;
  }
  
  let regex: RegExp;
  try {
    regex = new RegExp(regexPattern);
  } catch {
    return "Invalid pattern";
  }

  async function walk(dir: string) {
    if (results.length >= 50) return;
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (results.length >= 50) return;
        
        const fullPath = path.join(dir, entry.name);
        
        if (entry.isDirectory()) {
          if (!['node_modules', '.git', 'dist', 'build'].includes(entry.name)) {
            await walk(fullPath);
          }
        } else if (entry.isFile()) {
          const matchTarget = isPathPattern ? fullPath.replace(/\\\\/g, '/') : entry.name;
          if (regex.test(matchTarget)) {
            results.push(fullPath);
          }
        }
      }
    } catch {
      // ignore
    }
  }

  await walk(searchPath);
  return results.join('\\n') || "No files found";
}
