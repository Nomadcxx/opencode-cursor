import stripAnsi from "strip-ansi";
import type { IToolExecutor, ExecutionResult } from "../core/types.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("tools:executor:cli");

export class CliExecutor implements IToolExecutor {
  constructor(private timeoutMs: number) {}

  canExecute(): boolean {
    return true; // last-resort; can gate by env if needed
  }

  async execute(toolId: string, args: Record<string, unknown>): Promise<ExecutionResult> {
    try {
      const { spawn } = await import("node:child_process");
      const child = spawn("opencode", ["tool", "run", toolId, "--json", JSON.stringify(args)], {
        stdio: ["ignore", "pipe", "pipe"],
        shell: process.platform === "win32"
      });

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];

      const exited = new Promise<{ code: number | null }>((resolve) => child.on("close", (code) => resolve({ code })));

      const stdout = new Promise<string>((resolve) => {
        child.stdout?.on("data", (c) => stdoutChunks.push(Buffer.from(c)));
        child.stdout?.on("end", () => resolve(Buffer.concat(stdoutChunks).toString("utf-8")));
      });

      const stderr = new Promise<string>((resolve) => {
        child.stderr?.on("data", (c) => stderrChunks.push(Buffer.from(c)));
        child.stderr?.on("end", () => resolve(Buffer.concat(stderrChunks).toString("utf-8")));
      });

      const { code } = await this.runWithTimeout(exited);
      const out = await stdout;
      const err = await stderr;

      if (code === 0) {
        const clean = stripAnsi(out || "");
        return { status: "success", output: clean || "(no output)" };
      }
      return { status: "error", error: stripAnsi(err || out || `Exit code ${code}`) };
    } catch (err: any) {
      log.warn("CLI tool execution failed", { toolId, error: String(err?.message || err) });
      return { status: "error", error: String(err?.message || err) };
    }
  }

  private async runWithTimeout<T>(p: Promise<T>): Promise<T> {
    if (!this.timeoutMs) return p;
    return await Promise.race([
      p,
      new Promise<T>((_, reject) => setTimeout(() => reject(new Error("tool execution timeout")), this.timeoutMs)),
    ]);
  }
}
