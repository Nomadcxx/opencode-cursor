import type {
  Agent,
  InitializeRequest,
  InitializeResponse,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  CancelNotification,
  SetSessionModeRequest,
  SetSessionModeResponse,
  AvailableCommand
} from "@agentclientprotocol/sdk";

import { AgentSideConnection } from "@agentclientprotocol/sdk";
import type { SessionState, RetryContext } from "./types.js";
import { SessionManager } from "./sessions.js";
import { RetryEngine } from "./retry.js";
import { ToolMapper } from "./tools.js";
import { MetricsTracker } from "./metrics.js";
import { CursorNativeWrapper } from "./cursor.js";
import type { CursorNativeWrapperImpl } from "./cursor.js";
import { createLogger } from "./logger.js";
import { spawn } from "child_process";
import * as readline from "node:readline";

const log = createLogger("CursorAcpAgent");

class CursorAcpHybridAgentImpl implements Agent {
  private client: AgentSideConnection;
  private sessions: SessionManager;
  private retry: RetryEngine;
  private tools: ToolMapper;
  private metrics: MetricsTracker;
  private cursor: CursorNativeWrapperImpl;

  constructor(client: AgentSideConnection) {
    this.client = client;
    this.sessions = new SessionManager();
    this.retry = new RetryEngine({ maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 30000 });
    this.tools = new ToolMapper();
    this.metrics = new MetricsTracker();
    this.cursor = CursorNativeWrapper();

    log.info("Agent initialized");
  }

  async initialize(req: InitializeRequest): Promise<InitializeResponse> {
    log.info("Initializing agent", { clientCapabilities: req.clientCapabilities });

    await this.sessions.initialize();

    return {
      protocolVersion: 1,
      agentCapabilities: {
        promptCapabilities: { image: false, embeddedContext: true },
      },
      authMethods: [
        {
          id: "cursor-login",
          name: "Log in with Cursor Agent",
          description: "Run `cursor-agent login` in your terminal",
        },
      ],
    };
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    log.info("Creating new session", { cwd: params.cwd });

    const session = await this.sessions.createSession({
      cwd: params.cwd,
      modeId: "default"
    });

    const models = {
      availableModels: [{ modelId: "default", name: "Default", description: "Cursor default" }],
      currentModelId: "default"
    };

    const availableCommands: AvailableCommand[] = [];

    setTimeout(() => {
      this.client.sessionUpdate({
        sessionId: session.id,
        update: { sessionUpdate: "available_commands_update", availableCommands }
      });
    }, 0);

    const modes = [
      { id: "default", name: "Always Ask", description: "Normal behavior" },
      { id: "plan", name: "Plan Mode", description: "Analyze only; avoid edits and commands" }
    ];

    return { sessionId: session.id, models, modes: { currentModeId: "default", availableModes: modes } };
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    log.info("Handling prompt", { sessionId: params.sessionId });

    const session = await this.sessions.getSession(params.sessionId);
    if (!session) {
      throw new Error(`Session not found: ${params.sessionId}`);
    }

    session.cancelled = false;
    const modeId = session.modeId;

    const planPrefix = modeId === "plan"
      ? "[PLAN MODE] Do not edit files or run commands. Analyze only.\n\n"
      : "";

    const initialPrompt = planPrefix + this.concatPromptChunks(params.prompt);

    const args = [
      "--print",
      "--output-format",
      "stream-json",
      "--stream-partial-output",
      "--model",
      "auto",
      "--workspace",
      session.cwd || process.cwd()
    ];

    if (session.resumeId) {
      args.push("--resume", session.resumeId);
    }

    if (initialPrompt.length > 0) {
      args.push(initialPrompt);
    }

    const stopReason = await this.retry.executeWithRetry<PromptResponse["stopReason"]>(
      () => this.executePromptWithCursor(args, params.sessionId, session),
      { operation: "prompt", sessionId: params.sessionId }
    );

    if (session.resumeId && !session.cancelled) {
      await this.sessions.updateSession(session.id, { lastActivity: Date.now() });
    }

    return { stopReason };
  }

  private async executePromptWithCursor(
    args: string[],
    sessionId: string,
    session: SessionState
  ): Promise<PromptResponse["stopReason"]> {
    const agentPath = process.env.CURSOR_AGENT_EXECUTABLE || "cursor-agent";

    const child = spawn(agentPath, args, {
      cwd: session.cwd || process.cwd(),
      stdio: ["ignore", "pipe", "pipe"]
    });

    if (!child.stdout) {
      throw new Error("Failed to spawn cursor-agent");
    }

    let stopReason: PromptResponse["stopReason"] | undefined;
    const rl = readline.createInterface({ input: child.stdout });

    rl.on("line", async (line) => {
      if (session.cancelled) return;

      try {
        const evt = JSON.parse(line);
        for (const update of await this.tools.mapCursorEventToAcp(evt, sessionId)) {
          this.client.sessionUpdate({
            sessionId,
            update: update as any
          });
        }

        if (evt.session_id && !session.resumeId) {
          await this.sessions.setResumeId(sessionId, evt.session_id);
        }

        if (evt.type === "result") {
          if (evt.subtype === "success") stopReason = "end_turn";
          else if (evt.subtype === "cancelled") stopReason = "cancelled";
          else if (evt.subtype === "error" || evt.subtype === "failure" || evt.subtype === "refused") stopReason = "refusal";
        }
      } catch (e) {
        log.debug("Ignoring non-JSON line");
      }
    });

    const done = new Promise<PromptResponse["stopReason"]>((resolve) => {
      let exited = false;
      let exitCode: number | null = null;

      const finalize = () => {
        if (session.cancelled) return resolve("cancelled");
        if (stopReason) return resolve(stopReason);
        resolve(exitCode === 0 ? "end_turn" : "refusal");
      };

      child.on("exit", (code) => {
        exited = true;
        exitCode = code ?? null;
        finalize();
      });

      setTimeout(() => {
        if (!exited) return;
        finalize();
      }, 300);

      rl.on("close", () => {
        setTimeout(finalize, 100);
      });
    });

    return done;
  }

  async authenticate(): Promise<void> {
    log.info("No authentication required - using cursor-agent");
  }

  async cancel(params: CancelNotification): Promise<void> {
    log.info("Cancelling prompt", { sessionId: params.sessionId });

    const session = await this.sessions.getSession(params.sessionId);
    if (!session) {
      throw new Error(`Session not found: ${params.sessionId}`);
    }

    this.sessions.markCancelled(params.sessionId);
  }

  async setSessionMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse> {
    log.info("Setting session mode", { sessionId: params.sessionId, modeId: params.modeId });

    const session = await this.sessions.getSession(params.sessionId);
    if (!session) {
      throw new Error(`Session not found: ${params.sessionId}`);
    }

    await this.sessions.updateSession(params.sessionId, { modeId: params.modeId as "default" | "plan" });

    this.client.sessionUpdate({
      sessionId: params.sessionId,
      update: { sessionUpdate: "current_mode_update", currentModeId: params.modeId }
    });

    return {};
  }

  private concatPromptChunks(prompt: PromptRequest["prompt"]): string {
    const parts: string[] = [];
    for (const chunk of prompt) {
      if (chunk.type === "text") parts.push(chunk.text);
      else if (chunk.type === "resource" && "text" in chunk.resource) parts.push(chunk.resource.text as string);
      else if (chunk.type === "resource_link") parts.push(chunk.uri);
    }
    return parts.join("\n\n");
  }
}

// Export as a callable function that works with or without 'new'
// This allows opencode to call it without 'new' keyword
export function CursorAcpHybridAgent(client: AgentSideConnection): CursorAcpHybridAgentImpl {
  return new CursorAcpHybridAgentImpl(client);
}

// Also export the class for type compatibility
export { CursorAcpHybridAgentImpl };
