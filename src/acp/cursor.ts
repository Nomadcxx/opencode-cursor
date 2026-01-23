import { spawn } from "child_process";
import type { CursorUsageStats, CursorAgentStatus, CursorModel } from "./types.js";
import { createLogger } from "./logger.js";

const log = createLogger("CursorNative");

class CursorNativeWrapperImpl {
  private agentPath: string;

  constructor() {
    this.agentPath = process.env.CURSOR_AGENT_EXECUTABLE || "cursor-agent";
  }

  async execCommand(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const child = spawn(this.agentPath, args, { stdio: ["pipe", "pipe", "pipe"] });

    if (!child.stdout || !child.stderr) {
      throw new Error("Failed to spawn cursor-agent");
    }

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data) => stdout += data);
    child.stderr.on("data", (data) => stderr += data);

    const exitCode = await new Promise<number>((resolve) => {
      child.on("close", resolve);
    });

    return { exitCode, stdout, stderr };
  }

  async getUsage(): Promise<CursorUsageStats> {
    log.info("Querying cursor-agent usage");

    try {
      const result = await this.execCommand(["--usage"]);
      return this.parseUsageOutput(result.stdout);
    } catch (error) {
      log.warn("Failed to query usage, returning empty stats", { error });
      return {
        totalPrompts: 0,
        totalTokens: 0,
        totalDuration: 0,
        modelBreakdown: {}
      };
    }
  }

  async getStatus(): Promise<CursorAgentStatus> {
    log.info("Checking cursor-agent status");

    try {
      const result = await this.execCommand(["--version"]);
      const version = this.extractVersion(result.stdout);

      const whoami = await this.execCommand(["whoami"]);
      const loggedIn = !whoami.stdout.includes("Not logged in");

      return {
        healthy: result.exitCode === 0,
        version,
        logged_in: loggedIn
      };
    } catch (error) {
      log.warn("Failed to check cursor-agent status", { error });
      return {
        healthy: false,
        logged_in: false
      };
    }
  }

  async listModels(): Promise<CursorModel[]> {
    log.info("Listing available cursor-agent models");

    try {
      const result = await this.execCommand(["--list-models"]);
      return this.parseModelList(result.stdout);
    } catch (error) {
      log.warn("Failed to list models, returning defaults", { error });
      return [
        { id: "auto", name: "Default", description: "Cursor's default model" }
      ];
    }
  }

  private parseUsageOutput(stdout: string): CursorUsageStats {
    try {
      const data = JSON.parse(stdout);
      return {
        totalPrompts: data.total_prompts || 0,
        totalTokens: data.total_tokens || 0,
        totalDuration: data.total_duration || 0,
        modelBreakdown: data.model_breakdown || {}
      };
    } catch {
      return {
        totalPrompts: 0,
        totalTokens: 0,
        totalDuration: 0,
        modelBreakdown: {}
      };
    }
  }

  private extractVersion(stdout: string): string | undefined {
    const match = stdout.match(/cursor-agent version (\d+\.\d+\.\d+)/i);
    return match ? match[1] : undefined;
  }

  private parseModelList(stdout: string): CursorModel[] {
    try {
      const data = JSON.parse(stdout);
      if (Array.isArray(data.models)) {
        return data.models.map((m: any) => ({
          id: m.id || m.name,
          name: m.name,
          description: m.description
        }));
      }
      return [];
    } catch {
      return [];
    }
  }
}

// Export as a callable function that works with or without 'new'
// This allows opencode to call it without 'new' keyword
export function CursorNativeWrapper(): CursorNativeWrapperImpl {
  return new CursorNativeWrapperImpl();
}

// Also export the class for type compatibility
export { CursorNativeWrapperImpl };
