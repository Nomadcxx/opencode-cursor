import spawn from "cross-spawn";
import { resolveCursorAgentBinary } from "./binary.js";
import { buildCursorAgentSpawnCommand } from "./cursor-agent-command.mjs";

export type CursorAgentRunDeps = {
  platform?: NodeJS.Platform;
  spawn?: typeof spawn;
  resolveBinary?: () => string;
  timeoutMs?: number;
};

export type CursorAgentRunResult = { status: number | null; stdout: string; stderr: string };

/**
 * Run a short `cursor-agent` subcommand without blocking the event loop.
 * OpenCode 2 hosts plugins inside its server process, where a sync spawn
 * freezes every other request. Rejects on spawn errors (e.g. ENOENT) and
 * kills the child on timeout; a nonzero exit resolves for the caller to judge.
 */
export function runCursorAgent(args: string[], deps: CursorAgentRunDeps = {}): Promise<CursorAgentRunResult> {
  const platform = deps.platform ?? process.platform;
  const run = deps.spawn ?? spawn;
  const resolveBinary = deps.resolveBinary ?? resolveCursorAgentBinary;
  const timeoutMs = deps.timeoutMs ?? 5000;

  return new Promise((resolve, reject) => {
    const [command, commandArgs] = buildCursorAgentSpawnCommand(resolveBinary(), args, { platform });
    const child = run(command, commandArgs, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      finish();
    };
    const timer = setTimeout(() => {
      settle(() => reject(new Error(`cursor-agent ${args[0]} timed out after ${timeoutMs}ms`)));
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", (error) => settle(() => reject(error)));
    child.on("close", (status) => settle(() => resolve({ status, stdout, stderr })));
  });
}
