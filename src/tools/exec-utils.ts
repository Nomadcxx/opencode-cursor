import { spawn } from "node:child_process";

const DEFAULT_EXEC_MAX_BUFFER = 16 * 1024 * 1024;
const DEFAULT_GLOB_MAX_LINES = 50;
const DEFAULT_GREP_MAX_LINES = 500;

export function resolveToolExecMaxBuffer(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.CURSOR_KILO_TOOL_EXEC_MAX_BUFFER ?? env.CURSOR_ACP_TOOL_EXEC_MAX_BUFFER;
  if (raw && raw.trim().length > 0) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.round(parsed);
    }
  }
  return DEFAULT_EXEC_MAX_BUFFER;
}

export function resolveGlobMaxLines(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.CURSOR_KILO_GLOB_MAX_LINES ?? env.CURSOR_ACP_GLOB_MAX_LINES;
  if (raw && raw.trim().length > 0) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.round(parsed);
    }
  }
  return DEFAULT_GLOB_MAX_LINES;
}

export function resolveGrepMaxLines(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.CURSOR_KILO_GREP_MAX_LINES ?? env.CURSOR_ACP_GREP_MAX_LINES;
  if (raw && raw.trim().length > 0) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.round(parsed);
    }
  }
  return DEFAULT_GREP_MAX_LINES;
}

/** Run a subprocess and collect up to maxLines stdout lines without buffering unbounded output. */
export async function execFirstStdoutLines(
  command: string,
  args: string[],
  maxLines: number,
  options: { timeoutMs?: number; cwd?: string; treatExitCodeOneAsEmpty?: boolean } = {},
): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd });
    const lines: string[] = [];
    let buffer = "";
    let settled = false;

    const finish = (value: string) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(value);
    };

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(error);
    };

    const timer = options.timeoutMs
      ? setTimeout(() => {
          child.kill("SIGTERM");
          fail(new Error(`${command} timed out after ${options.timeoutMs}ms`));
        }, options.timeoutMs)
      : undefined;

    child.stdout.on("data", (chunk: Buffer | string) => {
      buffer += chunk.toString();
      const parts = buffer.split("\n");
      buffer = parts.pop() ?? "";
      for (const line of parts) {
        if (!line) continue;
        lines.push(line);
        if (lines.length >= maxLines) {
          child.kill("SIGTERM");
          finish(lines.join("\n"));
          return;
        }
      }
    });

    child.on("error", fail);
    child.on("close", (code, signal) => {
      if (settled) return;
      if (buffer.trim()) {
        lines.push(buffer.trim());
      }
      const output = lines.join("\n");
      if (code === 0 || signal === "SIGTERM") {
        finish(output || "No matches found");
        return;
      }
      if (options.treatExitCodeOneAsEmpty && code === 1) {
        finish(output || "No matches found");
        return;
      }
      fail(new Error(`${command} exited with code ${code ?? "unknown"}`));
    });
  });
}
