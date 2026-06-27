import type { Plugin, PluginInput } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin/tool";
import type { Auth } from "@opencode-ai/sdk";
import { spawn, spawnSync } from "child_process";
import { realpathSync } from "fs";
import { mkdir } from "fs/promises";
import { homedir } from "os";
import { isAbsolute, join, relative, resolve } from "path";
import { ToolMapper, type ToolUpdate } from "./acp/tools.js";
import { LineBuffer } from "./streaming/line-buffer.js";
import { MixedDeltaTracker } from "./streaming/delta-tracker.js";
import { StreamToSseConverter, formatSseDone } from "./streaming/openai-sse.js";
import { parseStreamJsonLine } from "./streaming/parser.js";
import {
  extractText,
  extractThinking,
  isAssistantText,
  isResult,
  isThinking,
  type StreamJsonEvent,
} from "./streaming/types.js";
import {
  createChatCompletionUsageChunk,
  extractOpenAiUsageFromResult,
  type OpenAiUsage,
} from "./usage.js";
import { createLogger } from "./utils/logger.js";
import { RequestPerf } from "./utils/perf.js";
import { parseAgentError, formatErrorForUser, stripAnsi, isResumeSpecificFailure } from "./utils/errors.js";
import { buildPromptFromMessages, buildToolFingerprint } from "./proxy/prompt-builder.js";
import { buildIncrementalPrompt, type ProxyMessage } from "./proxy/incremental-prompt.js";
import {
  buildSessionKey,
  clearResumeChatId,
  deriveConversationAnchor,
  deriveConversationResumePrefixes,
  getResumeChatId,
  hasResumeChatId,
  hashForLog,
  isSessionResumeEnabled,
  recordResumeChatId,
  sanitizeSessionKey,
  RESUME_CHAT_ID_SAFE_RE,
} from "./proxy/session-resume.js";
import {
  extractAllowedToolNames,
  type OpenAiToolCall,
} from "./proxy/tool-loop.js";
import { OpenCodeToolDiscovery } from "./tools/discovery.js";
import { toOpenAiParameters, describeTool } from "./tools/schema.js";
import { ToolRouter } from "./tools/router.js";
import { SkillLoader } from "./tools/skills/loader.js";
import { SkillResolver } from "./tools/skills/resolver.js";
import { autoRefreshModels } from "./models/sync.js";
import { readMcpConfigs, readSubagentNames } from "./mcp/config.js";
import { McpClientManager } from "./mcp/client-manager.js";
import {
  MCP_TOOL_PREFIX,
  buildMcpToolHookEntries,
  buildMcpToolDefinitions,
  namespaceMcpTool,
} from "./mcp/tool-bridge.js";
import { createOpencodeClient } from "@opencode-ai/sdk";
import { ToolRegistry as CoreRegistry } from "./tools/core/registry.js";
import { LocalExecutor } from "./tools/executors/local.js";
import { SdkExecutor } from "./tools/executors/sdk.js";
import { McpExecutor } from "./tools/executors/mcp.js";
import { executeWithChain } from "./tools/core/executor.js";
import { registerDefaultTools } from "./tools/defaults.js";
import type { IToolExecutor } from "./tools/core/types.js";
import {
  createProviderBoundary,
  parseProviderBoundaryMode,
  type ProviderBoundary,
  type ToolLoopMode,
  type ToolOptionResolution,
} from "./provider/boundary.js";
import { handleToolLoopEventWithFallback } from "./provider/runtime-interception.js";
import { PassThroughTracker } from "./provider/passthrough-tracker.js";
import { toastService } from "./services/toast-service.js";
import { buildToolSchemaMap } from "./provider/tool-schema-compat.js";
import {
  createToolLoopGuard,
  parseToolLoopMaxRepeat,
  type ToolLoopGuard,
} from "./provider/tool-loop-guard.js";
import { createSdkBunChild, createSdkNodeChild } from "./client/sdk-child.js";
import { createCursorAgentPoolNodeChild, isAgentPoolEnabled } from "./client/cursor-agent-child.js";
import {
  parseCursorBackendPreference,
  resolveSdkApiKey,
  selectBackendForRequest,
  type CursorRuntimeBackend,
} from "./provider/backend.js";
import { formatShellCommandForPlatform, resolveCursorAgentBinary } from "./utils/binary.js";

const log = createLogger("plugin");

interface McpToolSummary {
  serverName: string;
  toolName: string;
  callName?: string;
  description?: string;
  params?: string[];
}

function getMcpToolDefinitionName(mcpToolDefs: any[], index: number): string | undefined {
  const name = mcpToolDefs[index]?.function?.name;
  return typeof name === "string" && name.length > 0 ? name : undefined;
}

export function buildAvailableToolsSystemMessage(
  lastToolNames: string[],
  lastToolMap: Array<{ id: string; name: string }>,
  mcpToolDefs: any[],
  mcpToolSummaries?: McpToolSummary[],
  subagentNames: string[] = [],
): string | null {
  const parts: string[] = [];

  if (lastToolNames.length > 0 || lastToolMap.length > 0) {
    const names = lastToolNames.join(", ");
    const mapping = lastToolMap.map((m) => `${m.id} -> ${m.name}`).join("; ");
    parts.push(`Available OpenCode tools (use via tool calls): ${names}. Original skill ids mapped as: ${mapping}. Aliases include oc_skill_* and oc_superskill_* when applicable.`);
  }

  if (mcpToolSummaries && mcpToolSummaries.length > 0) {
    const summariesWithCallNames = mcpToolSummaries.map((summary, index) => ({
      ...summary,
      callName: summary.callName
        ?? getMcpToolDefinitionName(mcpToolDefs, index)
        ?? namespaceMcpTool(summary.serverName, summary.toolName),
    }));

    const servers = new Map<string, Array<McpToolSummary & { callName: string }>>();
    for (const s of summariesWithCallNames) {
      const list = servers.get(s.serverName) ?? [];
      list.push(s);
      servers.set(s.serverName, list);
    }

    const lines: string[] = [
      `MCP TOOLS — Call these tools by their FULL exact name (e.g. mcp__filesystem__read_file).`,
      `Important: There is NO tool named 'mcp'. Every MCP tool has the format mcp__<server>__<tool>.`,
      "Do NOT call a tool named 'mcp' with parameters. Always use the complete tool name below.",
      "",
    ];

    for (const [server, tools] of servers) {
      lines.push(`Server: ${server}`);
      for (const t of tools) {
        const paramHint = t.params?.length ? ` (params: ${t.params.join(", ")})` : "";
        const sourceHint = t.callName === t.toolName ? "" : ` (server: ${t.serverName}; tool: ${t.toolName})`;
        lines.push(`  - ${t.callName}${paramHint}${t.description ? " — " + t.description : ""}${sourceHint}`);
      }
      lines.push("");
    }

    parts.push(lines.join("\n"));
  }

  if (subagentNames.length > 0) {
    parts.push(
      `When calling the task tool, set subagent_type to one of: ${subagentNames.join(", ")}. Do not omit this parameter.`
    );
  }

  return parts.length > 0 ? parts.join("\n\n") : null;
}

export async function ensurePluginDirectory(): Promise<void> {
  const configHome = process.env.XDG_CONFIG_HOME
    ? resolve(process.env.XDG_CONFIG_HOME)
    : join(homedir(), ".config");
  const pluginDir = join(configHome, "opencode", "plugin");
  try {
    await mkdir(pluginDir, { recursive: true });
    log.debug("Plugin directory ensured", { path: pluginDir });
  } catch (error) {
    log.warn("Failed to create plugin directory", { error: String(error) });
  }
}

const CURSOR_PROVIDER_ID = "cursor-acp";
const CURSOR_PROVIDER_PREFIX = `${CURSOR_PROVIDER_ID}/`;

export function shouldProcessModel(model: string | undefined): boolean {
  if (!model) return false;
  return model.startsWith(CURSOR_PROVIDER_PREFIX);
}

const CURSOR_PROXY_HOST = "127.0.0.1";
const CURSOR_PROXY_DEFAULT_PORT = 32124;
const CURSOR_PROXY_DEFAULT_BASE_URL = `http://${CURSOR_PROXY_HOST}:${CURSOR_PROXY_DEFAULT_PORT}/v1`;
const CURSOR_PROXY_HEALTH_TIMEOUT_MS = 3000;
const REUSE_EXISTING_PROXY = process.env.CURSOR_ACP_REUSE_EXISTING_PROXY !== "false";

// Stored API key from auth loader (OpenCode auth store)
let storedApiKey: string | undefined;
let cursorAgentAvailabilityCache: boolean | undefined;

function getGlobalKey(): string {
  return "__opencode_cursor_proxy_server__";
}

function isCursorAgentAvailable(): boolean {
  if (cursorAgentAvailabilityCache !== undefined) {
    return cursorAgentAvailabilityCache;
  }

  const binary = resolveCursorAgentBinary();
  const result = spawnSync(formatShellCommandForPlatform(binary), ["--version"], {
    stdio: "ignore",
    timeout: 1000,
    shell: process.platform === "win32",
  });
  const error = result.error as NodeJS.ErrnoException | undefined;

  // ENOENT is the one signal that the binary is clearly absent. Other failures
  // mean the command path exists but the probe could not complete cleanly.
  cursorAgentAvailabilityCache = error?.code === "ENOENT" ? false : true;
  return cursorAgentAvailabilityCache;
}

function resolveBackendForRequest(sdkApiKey: string | undefined): CursorRuntimeBackend {
  const parsed = parseCursorBackendPreference(process.env.CURSOR_ACP_BACKEND);
  if (!parsed.valid) {
    log.warn("Invalid CURSOR_ACP_BACKEND value; falling back to auto", {
      value: process.env.CURSOR_ACP_BACKEND,
    });
  }

  return selectBackendForRequest({
    preference: parsed.preference,
    cursorAgentAvailable: isCursorAgentAvailable(),
    sdkApiKey,
  });
}



/**
 * Build the command array for invoking cursor-agent.
 * Appends `--resume <chatId>` only when a chat ID is supplied.
 */
export function buildCursorAgentCommand(
  model: string,
  workspaceDirectory: string,
  resumeChatId?: string,
): string[] {
  const cmd = [
    resolveCursorAgentBinary(),
    "--print",
    "--output-format",
    "stream-json",
    "--stream-partial-output",
    "--workspace",
    workspaceDirectory,
    "--model",
    model,
  ];
  if (resumeChatId) {
    if (RESUME_CHAT_ID_SAFE_RE.test(resumeChatId)) {
      cmd.push("--resume", resumeChatId);
    } else {
      log.warn("Refusing to pass unsafe resume chat ID to cursor-agent; --resume omitted", {
        resumeChatIdHash: hashForLog(resumeChatId),
        model,
      });
    }
  }
  if (FORCE_TOOL_MODE) {
    cmd.push("--force");
  }
  return cmd;
}

/**
 * Resolved prompt metadata returned by {@link resolvePromptForBackend}.
 */
export interface ResolvedPrompt {
  prompt: string;
  resumeChatId?: string;
  sessionKey?: string;
  usedIncremental: boolean;
  contentPrefix?: string;
  recordContentPrefix?: string;
  toolFingerprint?: string;
  subagentFingerprint?: string;
}

/**
 * Resolve the prompt to send to the backend.
 *
 * Only the cursor-agent backend supports `--resume`. When a chatId is available
 * and the last message can be expressed as a safe delta, an incremental prompt
 * is returned; otherwise the full flattened prompt is used. Even when the
 * incremental prompt is unavailable, `--resume` is still passed so cursor-agent
 * conversation state is reused.
 *
 * The returned `sessionKey`/`contentPrefix` are always populated on the
 * cursor-agent + resume-enabled path so the response can seed the cache.
 */
export function resolvePromptForBackend(input: {
  backend: CursorRuntimeBackend;
  messages: Array<ProxyMessage>;
  tools: Array<any>;
  subagentNames: string[];
  model: string;
  workspaceDirectory: string;
}): ResolvedPrompt {
  let fullPrompt: string | undefined;
  const getFullPrompt = () =>
    fullPrompt ??= buildPromptFromMessages(input.messages, input.tools, input.subagentNames);

  if (input.backend !== "cursor-agent" || !isSessionResumeEnabled()) {
    return { prompt: getFullPrompt(), usedIncremental: false };
  }

  const anchorResult = deriveConversationAnchor(input.messages);
  if (!anchorResult) {
    log.warn("Session resume enabled but no usable conversation anchor; skipping resume", {
      model: input.model,
      workspaceDirectoryHash: sanitizeSessionKey(input.workspaceDirectory),
    });
    return { prompt: getFullPrompt(), usedIncremental: false };
  }
  const { anchor, contentPrefix: anchorContentPrefix } = anchorResult;
  const resumePrefixes = deriveConversationResumePrefixes(input.messages);
  const contentPrefix = resumePrefixes?.lookupContentPrefix ?? anchorContentPrefix;
  const recordContentPrefix = resumePrefixes?.recordContentPrefix ?? contentPrefix;
  const sessionKey = buildSessionKey(input.workspaceDirectory, input.model, anchor);
  const sessionKeyHash = sanitizeSessionKey(sessionKey);
  const toolFingerprint = buildToolFingerprint(input.tools);
  const subagentFingerprint = input.subagentNames.slice().sort().join(",");
  const resumeChatId = getResumeChatId(sessionKey, contentPrefix, toolFingerprint, subagentFingerprint);
  const resumeChatIdHash = resumeChatId ? sanitizeSessionKey(resumeChatId) : undefined;
  if (!resumeChatId) {
    const isContinuation = input.messages.some((m: any) => m?.role === "assistant");
    if (isContinuation) {
      log.warn("Session resume enabled but no chatId found for sessionKey; falling back to full prompt", {
        sessionKeyHash,
      });
    }
    return { prompt: getFullPrompt(), sessionKey, usedIncremental: false, contentPrefix, recordContentPrefix, toolFingerprint, subagentFingerprint };
  }

  const incremental = buildIncrementalPrompt(input.messages);
  if (incremental) {
    // Guard the debug log behind isDebugEnabled() so getFullPrompt() is not
    // eagerly evaluated on the incremental hot path. JS evaluates call
    // arguments before log.debug's own level check runs, so without this
    // guard the full prompt would be built on every resumed turn and negate
    // M3's skip-full-flattening optimization. Mirrors buildPromptFromMessages.
    if (log.isDebugEnabled()) {
      log.debug("Using incremental prompt with session resume", {
        sessionKeyHash,
        resumeChatIdHash,
        promptChars: incremental.length,
        fullPromptChars: getFullPrompt().length,
      });
    }
    return { prompt: incremental, resumeChatId, sessionKey, usedIncremental: true, contentPrefix, recordContentPrefix, toolFingerprint, subagentFingerprint };
  }

  log.info("Session resume active but incremental prompt unavailable; using full prompt", {
    sessionKeyHash,
    resumeChatIdHash,
  });
  return { prompt: getFullPrompt(), resumeChatId, sessionKey, usedIncremental: false, contentPrefix, recordContentPrefix, toolFingerprint, subagentFingerprint };
}

/**
 * Capture `session_id` from a cursor-agent NDJSON stream event.
 * cursor-agent stream events may carry `session_id`; when present, that value is
 * what `--resume` accepts, so any such event may seed/refresh the cache.
 */
export function captureResumeChatIdFromEvent(
  event: StreamJsonEvent,
  sessionKey: string | undefined,
  model: string,
  workspaceDirectory: string,
  contentPrefix?: string,
  toolFingerprint?: string,
  subagentFingerprint?: string,
): void {
  if (!sessionKey || !isSessionResumeEnabled()) return;
  const chatId = event.session_id;
  if (chatId == null) return;
  if (typeof chatId === "string" && chatId.trim()) {
    recordResumeChatId(
      sessionKey,
      chatId.trim(),
      contentPrefix ?? "",
      toolFingerprint,
      subagentFingerprint,
    );
    return;
  }
  log.warn("cursor-agent emitted invalid session_id", {
    type: typeof chatId,
    length: String(chatId).length,
    sessionKeyHash: sanitizeSessionKey(sessionKey),
  });
}

/**
 * Scan raw cursor-agent NDJSON output (stdout) and capture the first valid
 * `session_id`. Each line is parsed independently and delegated to the
 * event-level capture. cursor-agent emits `session_id` on stdout; stderr is
 * intentionally not scanned here so error text cannot spoof a session ID.
 */
export function captureResumeChatIdFromOutput(
  output: string,
  sessionKey: string | undefined,
  model: string,
  workspaceDirectory: string,
  contentPrefix?: string,
  toolFingerprint?: string,
  subagentFingerprint?: string,
): void {
  if (!sessionKey || !isSessionResumeEnabled() || !output) return;
  for (const line of output.split(/\r?\n/)) {
    const event = parseStreamJsonLine(line);
    if (event) {
      captureResumeChatIdFromEvent(
        event,
        sessionKey,
        model,
        workspaceDirectory,
        contentPrefix,
        toolFingerprint,
        subagentFingerprint,
      );
    }
  }
}

/**
 * Evict a cached resume chat ID when the cursor-agent error indicates the
 * resumed session itself is gone. Transient errors (network, auth, OOM,
 * signals) are ignored so a valid resume ID survives a flaky turn.
 */
export function maybeEvictResumeChatId(
  errSource: unknown,
  resumeChatId: string | undefined,
  sessionKey: string | undefined,
  logFields: { code?: number | null; spawnError?: boolean; failureTextHash?: string } = {},
): boolean {
  if (!resumeChatId || !sessionKey || !isSessionResumeEnabled() || !isResumeSpecificFailure(errSource)) {
    return false;
  }
  clearResumeChatId(sessionKey);
  log.warn("Evicting resume chatId after resume-specific cursor-agent failure", {
    code: logFields.code,
    spawnError: logFields.spawnError,
    sessionKeyHash: sanitizeSessionKey(sessionKey),
    resumeChatIdHash: sanitizeSessionKey(resumeChatId),
    failureTextHash: logFields.failureTextHash,
    hadResume: true,
  });
  return true;
}

function isSuccessfulResultEvent(event: StreamJsonEvent): boolean {
  return isResult(event) && event.is_error !== true && event.subtype !== "error";
}

function shouldTreatCursorAgentFailureAsDiagnostic(
  errSource: string,
  sawSuccessfulStreamOutput: boolean,
): boolean {
  if (!sawSuccessfulStreamOutput) {
    return false;
  }
  return parseAgentError(errSource).type === "quota";
}

/**
 * Warn once per request when session resume is enabled but cursor-agent did
 * not emit a usable `session_id`. Keeps the warning logic in one place across
 * the Bun/Node stream/non-stream paths.
 */
function warnIfResumeNotCaptured(
  sessionResumeKey: string | undefined,
  sessionResumeKeyHash: string | undefined,
  sessionResumeContentPrefix: string | undefined,
  sessionResumeToolFingerprint: string | undefined,
  sessionResumeSubagentFingerprint: string | undefined,
  model: string,
): void {
  if (
    sessionResumeKey
    && isSessionResumeEnabled()
    && !hasResumeChatId(
      sessionResumeKey,
      sessionResumeContentPrefix,
      sessionResumeToolFingerprint,
      sessionResumeSubagentFingerprint,
    )
  ) {
    log.warn("Session resume enabled but no session_id captured from cursor-agent response; resume will not activate on the next turn", {
      sessionKeyHash: sessionResumeKeyHash,
      model,
    });
  }
}

function createCursorAgentBunChild(
  model: string,
  prompt: string,
  workspaceDirectory: string,
  resumeChatId?: string,
): any {
  const bunAny = globalThis as any;
  if (!bunAny.Bun?.spawn) {
    throw new Error("This provider requires Bun runtime.");
  }

  const child = bunAny.Bun.spawn({
    cmd: buildCursorAgentCommand(model, workspaceDirectory, resumeChatId),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: bunAny.Bun.env,
  });

  child.stdin.write(prompt);
  child.stdin.end();
  return child;
}

function createBunChildForBackend(input: {
  backend: CursorRuntimeBackend;
  sdkApiKey?: string;
  model: string;
  prompt: string;
  workspaceDirectory: string;
  resumeChatId?: string;
}): any {
  if (input.backend === "sdk") {
    if (!input.sdkApiKey) {
      throw new Error("SDK backend requires CURSOR_API_KEY or OpenCode auth.");
    }
    return createSdkBunChild({
      apiKey: input.sdkApiKey,
      model: input.model,
      prompt: input.prompt,
      cwd: input.workspaceDirectory,
    });
  }

  return createCursorAgentBunChild(
    input.model,
    input.prompt,
    input.workspaceDirectory,
    input.resumeChatId,
  );
}

function createCursorAgentNodeChild(
  model: string,
  prompt: string,
  workspaceDirectory: string,
  resumeChatId?: string,
): any {
  const cmd = buildCursorAgentCommand(model, workspaceDirectory, resumeChatId);
  const child = spawn(formatShellCommandForPlatform(cmd[0]), cmd.slice(1), {
    stdio: ["pipe", "pipe", "pipe"],
    shell: process.platform === "win32",
  });

  child.stdin.write(prompt);
  child.stdin.end();
  return child;
}

function createNodeChildForBackend(input: {
  backend: CursorRuntimeBackend;
  sdkApiKey?: string;
  model: string;
  prompt: string;
  workspaceDirectory: string;
  resumeChatId?: string;
}): any {
  if (input.backend === "sdk") {
    if (!input.sdkApiKey) {
      throw new Error("SDK backend requires CURSOR_API_KEY or OpenCode auth.");
    }
    return createSdkNodeChild({
      apiKey: input.sdkApiKey,
      model: input.model,
      prompt: input.prompt,
      cwd: input.workspaceDirectory,
    });
  }

  if (isAgentPoolEnabled()) {
    log.debug("Using cursor-agent pool for request", {
      model: input.model,
      resume: !!input.resumeChatId,
    });
    return createCursorAgentPoolNodeChild({
      model: input.model,
      prompt: input.prompt,
      cwd: input.workspaceDirectory,
      resumeChatId: input.resumeChatId,
      force: FORCE_TOOL_MODE,
    });
  }

  return createCursorAgentNodeChild(
    input.model,
    input.prompt,
    input.workspaceDirectory,
    input.resumeChatId,
  );
}

function getOpenCodeConfigPrefix(): string {
  const configHome = process.env.XDG_CONFIG_HOME
    ? resolve(process.env.XDG_CONFIG_HOME)
    : join(homedir(), ".config");
  return join(configHome, "opencode");
}

function canonicalizePathForCompare(pathValue: string): string {
  const resolvedPath = resolve(pathValue);
  let normalizedPath = resolvedPath;

  try {
    normalizedPath = typeof realpathSync.native === "function"
      ? realpathSync.native(resolvedPath)
      : realpathSync(resolvedPath);
  } catch {
    normalizedPath = resolvedPath;
  }

  if (process.platform === "darwin" || process.platform === "win32") {
    return normalizedPath.toLowerCase();
  }

  return normalizedPath;
}

function isWithinPath(root: string, candidate: string): boolean {
  const normalizedRoot = canonicalizePathForCompare(root);
  const normalizedCandidate = canonicalizePathForCompare(candidate);
  const rel = relative(normalizedRoot, normalizedCandidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function resolveCandidate(value: string | undefined): string {
  if (!value || value.trim().length === 0) {
    return "";
  }
  return resolve(value);
}

function isNonConfigPath(pathValue: string): boolean {
  if (!pathValue) {
    return false;
  }
  return !isWithinPath(getOpenCodeConfigPrefix(), pathValue);
}

// Filesystem roots are never a meaningful workspace: accepting "/" (or a bare
// Windows drive root like "C:\") makes every tool treat the whole machine as
// the project, which is both unsafe and a common symptom of a daemon that
// was launched without a real cwd (e.g. systemd unit without WorkingDirectory).
export function isRootPath(pathValue: string): boolean {
  if (!pathValue) {
    return false;
  }
  const resolved = resolve(pathValue);
  if (resolved === "/") {
    return true;
  }
  return /^[A-Za-z]:[\\/]?$/.test(resolved);
}

function isAcceptableWorkspace(pathValue: string, configPrefix: string): boolean {
  if (!pathValue) {
    return false;
  }
  if (isRootPath(pathValue)) {
    return false;
  }
  if (isWithinPath(configPrefix, pathValue)) {
    return false;
  }
  return true;
}

const SESSION_WORKSPACE_CACHE_LIMIT = 200;

export function resolveWorkspaceDirectory(
  worktree: string | undefined,
  directory: string | undefined,
): string {
  const configPrefix = getOpenCodeConfigPrefix();

  const envWorkspace = resolveCandidate(process.env.CURSOR_ACP_WORKSPACE);
  if (envWorkspace && !isRootPath(envWorkspace)) {
    return envWorkspace;
  }

  const envProjectDir = resolveCandidate(process.env.OPENCODE_CURSOR_PROJECT_DIR);
  if (envProjectDir && !isRootPath(envProjectDir)) {
    return envProjectDir;
  }

  const worktreeCandidate = resolveCandidate(worktree);
  if (isAcceptableWorkspace(worktreeCandidate, configPrefix)) {
    return worktreeCandidate;
  }

  const dirCandidate = resolveCandidate(directory);
  if (isAcceptableWorkspace(dirCandidate, configPrefix)) {
    return dirCandidate;
  }

  const cwd = resolve(process.cwd());
  if (isAcceptableWorkspace(cwd, configPrefix)) {
    return cwd;
  }

  // Fall back to the user's home directory rather than "/" when every other
  // signal is unusable. $HOME is always writable for the current user and
  // keeps tool scopes sane even when the daemon was spawned from root.
  const home = resolveCandidate(homedir());
  if (home && !isRootPath(home)) {
    return home;
  }

  return configPrefix;
}

type ProxyRuntimeState = {
  baseURL?: string;
  baseURLByWorkspace?: Record<string, string>;
};

export function normalizeWorkspaceForCompare(pathValue: string): string {
  const resolved = resolve(pathValue);
  if (process.platform === "darwin" || process.platform === "win32") {
    return resolved.toLowerCase();
  }
  return resolved;
}

export function isReusableProxyHealthPayload(payload: any, workspaceDirectory: string): boolean {
  if (!payload || payload.ok !== true) {
    return false;
  }
  if (typeof payload.workspaceDirectory !== "string" || payload.workspaceDirectory.length === 0) {
    // Legacy proxies that do not expose workspace cannot be safely reused.
    return false;
  }
  return normalizeWorkspaceForCompare(payload.workspaceDirectory) === normalizeWorkspaceForCompare(workspaceDirectory);
}

export async function fetchProxyHealthWithTimeout(
  url: string,
  timeoutMs: number = CURSOR_PROXY_HEALTH_TIMEOUT_MS,
): Promise<Response | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  if (typeof (timeout as any).unref === "function") {
    (timeout as any).unref();
  }

  try {
    return await fetch(url, { signal: controller.signal }).catch(() => null);
  } finally {
    clearTimeout(timeout);
  }
}

const FORCE_TOOL_MODE = process.env.CURSOR_ACP_FORCE !== "false";
const EMIT_TOOL_UPDATES = process.env.CURSOR_ACP_EMIT_TOOL_UPDATES === "true";
const FORWARD_TOOL_CALLS = process.env.CURSOR_ACP_FORWARD_TOOL_CALLS !== "false";

function parseToolLoopMode(value: string | undefined): { mode: ToolLoopMode; valid: boolean } {
  const normalized = (value ?? "opencode").trim().toLowerCase();
  if (normalized === "opencode" || normalized === "proxy-exec" || normalized === "off") {
    return { mode: normalized, valid: true };
  }
  return { mode: "opencode", valid: false };
}

const TOOL_LOOP_MODE_RAW = process.env.CURSOR_ACP_TOOL_LOOP_MODE;
const { mode: TOOL_LOOP_MODE, valid: TOOL_LOOP_MODE_VALID } = parseToolLoopMode(TOOL_LOOP_MODE_RAW);
const PROVIDER_BOUNDARY_MODE_RAW = process.env.CURSOR_ACP_PROVIDER_BOUNDARY;
const {
  mode: PROVIDER_BOUNDARY_MODE,
  valid: PROVIDER_BOUNDARY_MODE_VALID,
} = parseProviderBoundaryMode(PROVIDER_BOUNDARY_MODE_RAW);
const LEGACY_PROVIDER_BOUNDARY = createProviderBoundary("legacy", CURSOR_PROVIDER_ID);
const PROVIDER_BOUNDARY =
  PROVIDER_BOUNDARY_MODE === "legacy"
    ? LEGACY_PROVIDER_BOUNDARY
    : createProviderBoundary(PROVIDER_BOUNDARY_MODE, CURSOR_PROVIDER_ID);
const ENABLE_PROVIDER_BOUNDARY_AUTOFALLBACK =
  process.env.CURSOR_ACP_PROVIDER_BOUNDARY_AUTOFALLBACK !== "false";
const TOOL_LOOP_MAX_REPEAT_RAW = process.env.CURSOR_ACP_TOOL_LOOP_MAX_REPEAT;
const {
  value: TOOL_LOOP_MAX_REPEAT,
  valid: TOOL_LOOP_MAX_REPEAT_VALID,
} = parseToolLoopMaxRepeat(TOOL_LOOP_MAX_REPEAT_RAW);
const {
  proxyExecuteToolCalls: PROXY_EXECUTE_TOOL_CALLS,
  suppressConverterToolEvents: SUPPRESS_CONVERTER_TOOL_EVENTS,
  shouldEmitToolUpdates: SHOULD_EMIT_TOOL_UPDATES,
} = PROVIDER_BOUNDARY.computeToolLoopFlags(
  TOOL_LOOP_MODE,
  FORWARD_TOOL_CALLS,
  EMIT_TOOL_UPDATES,
);

export function resolveChatParamTools(
  mode: ToolLoopMode,
  existingTools: unknown,
  refreshedTools: Array<any>,
): ToolOptionResolution {
  return PROVIDER_BOUNDARY.resolveChatParamTools(mode, existingTools, refreshedTools);
}

function createChatCompletionResponse(
  model: string,
  content: string,
  reasoningContent?: string,
  usage?: OpenAiUsage,
) {
  const message: { role: "assistant"; content: string; reasoning_content?: string } = {
    role: "assistant",
    content,
  };

  if (reasoningContent && reasoningContent.length > 0) {
    message.reasoning_content = reasoningContent;
  }

  const response: {
    id: string;
    object: string;
    created: number;
    model: string;
    choices: Array<{
      index: number;
      message: typeof message;
      finish_reason: string;
    }>;
    usage?: OpenAiUsage;
  } = {
    id: `cursor-acp-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: "stop",
      },
    ],
  };

  if (usage) {
    response.usage = usage;
  }

  return response;
}

function createChatCompletionChunk(id: string, created: number, model: string, deltaContent: string, done = false) {
  return {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [
      {
        index: 0,
        delta: deltaContent ? { content: deltaContent } : {},
        finish_reason: done ? "stop" : null,
      },
    ],
  };
}

export function extractCompletionFromStream(output: string): {
  assistantText: string;
  reasoningText: string;
  usage?: OpenAiUsage;
} {
  const lines = output.split("\n");
  let assistantText = "";
  let reasoningText = "";
  let usage: OpenAiUsage | undefined;
  let sawAssistantPartials = false;
  let sawThinkingPartials = false;
  const tracker = new MixedDeltaTracker();

  for (const line of lines) {
    const event = parseStreamJsonLine(line);
    if (!event) {
      continue;
    }

    if (isAssistantText(event)) {
      const text = extractText(event);
      if (!text) continue;

      const isPartial = typeof (event as any).timestamp_ms === "number";
      if (isPartial) {
        sawAssistantPartials = true;
        assistantText += tracker.nextText(text);
      } else if (!sawAssistantPartials) {
        assistantText = text;
      }
    }

    if (isThinking(event)) {
      const thinking = extractThinking(event);
      if (thinking) {
        const isPartial = typeof (event as any).timestamp_ms === "number";
        if (isPartial) {
          sawThinkingPartials = true;
          reasoningText += tracker.nextThinking(thinking);
        } else if (!sawThinkingPartials) {
          reasoningText = thinking;
        }
      }
    }

    if (isResult(event)) {
      usage = extractOpenAiUsageFromResult(event) ?? usage;
    }
  }

  return { assistantText, reasoningText, usage };
}

function formatToolUpdateEvent(update: ToolUpdate): string {
  return `event: tool_update\ndata: ${JSON.stringify(update)}\n\n`;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function createBoundaryRuntimeContext(scope: string) {
  let activeBoundary = PROVIDER_BOUNDARY;
  let fallbackActive = false;

  const canAutoFallback = ENABLE_PROVIDER_BOUNDARY_AUTOFALLBACK && PROVIDER_BOUNDARY.mode === "v1";

  const activateLegacyFallback = (operation: string, error: unknown): boolean => {
    if (!canAutoFallback || activeBoundary.mode === "legacy") {
      return false;
    }

    activeBoundary = LEGACY_PROVIDER_BOUNDARY;
    const details = {
      scope,
      operation,
      error: toErrorMessage(error),
    };
    if (!fallbackActive) {
      log.warn("Provider boundary v1 failed; switching to legacy for this request", details);
    } else {
      log.debug("Provider boundary fallback already active", details);
    }
    fallbackActive = true;
    return true;
  };

  return {
    getBoundary(): ProviderBoundary {
      return activeBoundary;
    },

    run<T>(operation: string, fn: (boundary: ProviderBoundary) => T): T {
      try {
        return fn(activeBoundary);
      } catch (error) {
        if (!activateLegacyFallback(operation, error)) {
          throw error;
        }
        return fn(activeBoundary);
      }
    },

    async runAsync<T>(operation: string, fn: (boundary: ProviderBoundary) => Promise<T>): Promise<T> {
      try {
        return await fn(activeBoundary);
      } catch (error) {
        if (!activateLegacyFallback(operation, error)) {
          throw error;
        }
        return fn(activeBoundary);
      }
    },

    activateLegacyFallback(operation: string, error: unknown) {
      activateLegacyFallback(operation, error);
    },

    isFallbackActive(): boolean {
      return fallbackActive;
    },
  };
}

async function findFirstAllowedToolCallInOutput(
  output: string,
  options: {
    toolLoopMode: ToolLoopMode;
    allowedToolNames: Set<string>;
    toolSchemaMap: Map<string, unknown>;
    toolLoopGuard: ToolLoopGuard;
    boundaryContext: ReturnType<typeof createBoundaryRuntimeContext>;
    responseMeta: { id: string; created: number; model: string };
  },
): Promise<{ toolCall: OpenAiToolCall | null; terminationMessage: string | null }> {
  if (options.allowedToolNames.size === 0 || !output) {
    return { toolCall: null, terminationMessage: null };
  }

  const toolMapper = new ToolMapper();
  const toolSessionId = options.responseMeta.id;

  for (const line of output.split("\n")) {
    const event = parseStreamJsonLine(line);
    if (!event || event.type !== "tool_call") {
      continue;
    }

    let interceptedToolCall: OpenAiToolCall | null = null;
    const result = await handleToolLoopEventWithFallback({
      event: event as any,
      boundary: options.boundaryContext.getBoundary(),
      boundaryMode: options.boundaryContext.getBoundary().mode,
      autoFallbackToLegacy: ENABLE_PROVIDER_BOUNDARY_AUTOFALLBACK,
      toolLoopMode: options.toolLoopMode,
      allowedToolNames: options.allowedToolNames,
      toolSchemaMap: options.toolSchemaMap,
      toolLoopGuard: options.toolLoopGuard,
      toolMapper,
      toolSessionId,
      shouldEmitToolUpdates: false,
      proxyExecuteToolCalls: false,
      suppressConverterToolEvents: false,
      responseMeta: options.responseMeta,
      onToolUpdate: () => {},
      onToolResult: () => {},
      onInterceptedToolCall: (toolCall) => {
        interceptedToolCall = toolCall;
      },
      onFallbackToLegacy: (error) => {
        options.boundaryContext.activateLegacyFallback("findFirstAllowedToolCallInOutput", error);
      },
    });

    if (result.terminate) {
      return {
        toolCall: null,
        terminationMessage: result.terminate.silent ? null : result.terminate.message,
      };
    }
    if (result.intercepted && interceptedToolCall) {
      return {
        toolCall: interceptedToolCall,
        terminationMessage: null,
      };
    }
  }

  return { toolCall: null, terminationMessage: null };
}

async function ensureCursorProxyServer(workspaceDirectory: string, toolRouter?: ToolRouter): Promise<string> {
  const key = getGlobalKey();
  const g = globalThis as any;
  const normalizedWorkspace = normalizeWorkspaceForCompare(workspaceDirectory);
  const state: ProxyRuntimeState = g[key] ?? { baseURL: "", baseURLByWorkspace: {} };
  state.baseURLByWorkspace = state.baseURLByWorkspace ?? {};
  g[key] = state;

  const existingBaseURL = state.baseURLByWorkspace[normalizedWorkspace] ?? state.baseURL;
  if (typeof existingBaseURL === "string" && existingBaseURL.length > 0) {
    return existingBaseURL;
  }

  // Mark as starting to avoid duplicate starts in-process.
  state.baseURL = "";

  const resolveRequestSdkApiKey = (authHeader?: string | null): string | undefined =>
    resolveSdkApiKey({
      env: process.env,
      storedApiKey,
      authorizationHeader: authHeader,
    });

      const handler = async (req: Request): Promise<Response> => {
        try {
          const url = new URL(req.url);

      if (url.pathname === "/health") {
        return new Response(JSON.stringify({ ok: true, workspaceDirectory }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      // Model list via ModelDiscoveryService (has built-in fallback models)
      if (url.pathname === "/v1/models" || url.pathname === "/models") {
        try {
          const { ModelDiscoveryService } = await import("./models/discovery.js");
          const discovery = new ModelDiscoveryService();
          const modelList = await discovery.discover(resolveRequestSdkApiKey());
          const models = modelList.map((m: any) => ({
            id: typeof m === "string" ? m : m.id,
            object: "model",
            created: Math.floor(Date.now() / 1000),
            owned_by: "cursor",
          }));
          return new Response(JSON.stringify({ object: "list", data: models }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        } catch (err) {
          log.error("Failed to list models", { error: String(err) });
          return new Response(JSON.stringify({ error: "Failed to fetch models" }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }
      }

      if (url.pathname !== "/v1/chat/completions" && url.pathname !== "/chat/completions") {
        return new Response(JSON.stringify({ error: `Unsupported path: ${url.pathname}` }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }

      log.debug("Proxy request (bun)", { method: req.method, path: url.pathname });
      const reqPerf = new RequestPerf(`bun-${Date.now()}`);
      const body: any = await req.json().catch(() => ({}));
      reqPerf.mark("body-read");
      reqPerf.mark("body-parsed");
      const messages: Array<any> = Array.isArray(body?.messages) ? body.messages : [];
      const stream = body?.stream === true;
      const tools = Array.isArray(body?.tools) ? body.tools : [];

      log.debug("raw request body", {
        model: body?.model,
        cursorModel: body?.cursorModel,
        stream,
        toolCount: tools.length,
        toolNames: tools.map((t: any) => t?.function?.name ?? t?.name ?? "unknown"),
        messageCount: messages.length,
        messageRoles: messages.map((m: any) => m?.role),
        hasMessagesWithToolCalls: messages.some((m: any) => Array.isArray(m?.tool_calls) && m.tool_calls.length > 0),
        hasToolResultMessages: messages.some((m: any) => m?.role === "tool"),
      });

      const allowedToolNames = extractAllowedToolNames(tools);
      const toolSchemaMap = buildToolSchemaMap(tools);
      const toolLoopGuard = createToolLoopGuard(messages, TOOL_LOOP_MAX_REPEAT);
      const boundaryContext = createBoundaryRuntimeContext("bun-handler");

      const subagentNames = readSubagentNames();
      const model = boundaryContext.run("resolveRuntimeModel", (boundary) =>
        boundary.resolveRuntimeModel(body?.model, body?.cursorModel),
      );
      const authHeader = req.headers.get("authorization");
      const sdkApiKey = resolveRequestSdkApiKey(authHeader);
      const backend = resolveBackendForRequest(sdkApiKey);
      reqPerf.mark("backend-resolved");
      const {
        prompt,
        resumeChatId,
        sessionKey: sessionResumeKey,
        usedIncremental,
        contentPrefix: sessionResumeContentPrefix,
        recordContentPrefix: sessionResumeRecordContentPrefix,
        toolFingerprint: sessionResumeToolFingerprint,
        subagentFingerprint: sessionResumeSubagentFingerprint,
      } = resolvePromptForBackend({
        backend,
        messages,
        tools,
        subagentNames,
        model,
        workspaceDirectory,
      });
      reqPerf.mark("prompt-built");
      const sessionResumeKeyHash = sessionResumeKey ? sanitizeSessionKey(sessionResumeKey) : undefined;
      const resumeChatIdHash = resumeChatId ? sanitizeSessionKey(resumeChatId) : undefined;
      const msgSummaryBun = messages.map((m: any, i: number) => {
        const role = m?.role ?? "?";
        const hasTc = Array.isArray(m?.tool_calls) ? m.tool_calls.length : 0;
        const clen = typeof m?.content === "string" ? m.content.length : Array.isArray(m?.content) ? `arr${(m.content as any[]).length}` : typeof m?.content;
        return `${i}:${role}${hasTc ? `(tc:${hasTc})` : ""}(clen:${clen})`;
      });
      log.debug("Proxy chat request (bun)", {
        stream,
        model,
        messages: messages.length,
        tools: tools.length,
        promptChars: prompt.length,
        msgRoles: msgSummaryBun.join(","),
        sessionResume: resumeChatId ? { chatIdHash: resumeChatIdHash, incremental: usedIncremental } : undefined,
      });

      if (backend === "sdk" && !sdkApiKey) {
        return new Response(
          JSON.stringify({ error: "Cursor SDK backend requires a real Cursor API key. Set CURSOR_API_KEY or run `opencode auth login`; the legacy `cursor-agent` placeholder is not valid SDK auth." }),
          { status: 401, headers: { "Content-Type": "application/json" } },
        );
      }

      reqPerf.mark("child-create-start");
      const child = createBunChildForBackend({
        backend,
        sdkApiKey,
        model,
        prompt,
        workspaceDirectory,
        resumeChatId,
      });
      reqPerf.mark("child-created");

      if (!stream) {
        const [stdoutText, stderrText] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);

        const stdout = (stdoutText || "").trim();
        const stderr = (stderrText || "").trim();
        const exitCode = await child.exited;
        log.debug("cursor-agent completed (bun non-stream)", {
          exitCode,
          stdoutChars: stdout.length,
          stderrChars: stderr.length,
        });
        captureResumeChatIdFromOutput(
          stdout,
          sessionResumeKey,
          model,
          workspaceDirectory,
          sessionResumeRecordContentPrefix,
          sessionResumeToolFingerprint,
          sessionResumeSubagentFingerprint,
        );
        warnIfResumeNotCaptured(
          sessionResumeKey,
          sessionResumeKeyHash,
          sessionResumeRecordContentPrefix,
          sessionResumeToolFingerprint,
          sessionResumeSubagentFingerprint,
          model,
        );
        const meta = {
          id: `cursor-acp-${Date.now()}`,
          created: Math.floor(Date.now() / 1000),
          model,
        };
        const intercepted = await findFirstAllowedToolCallInOutput(stdout, {
          toolLoopMode: TOOL_LOOP_MODE,
          allowedToolNames,
          toolSchemaMap,
          toolLoopGuard,
          boundaryContext,
          responseMeta: meta,
        });
        if (intercepted.terminationMessage) {
          const payload = createChatCompletionResponse(model, intercepted.terminationMessage);
          return new Response(JSON.stringify(payload), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        if (intercepted.toolCall) {
          log.debug("Intercepted OpenCode tool call (non-stream)", {
            name: intercepted.toolCall.function.name,
            callId: intercepted.toolCall.id,
          });
          const payload = boundaryContext.run(
            "createNonStreamToolCallResponse",
            (boundary) => boundary.createNonStreamToolCallResponse(meta, intercepted.toolCall),
          );
          return new Response(JSON.stringify(payload), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        if (exitCode !== 0) {
          const errSource =
            stderr
            || stdout
            || `cursor-agent exited with code ${String(exitCode ?? "unknown")} and no output`;
          // Only evict the cached chat ID when the failure indicates the resumed
          // session itself is gone. Transient errors (network/auth/OOM/signals)
          // should not discard a valid resume ID.
          maybeEvictResumeChatId(errSource, resumeChatId, sessionResumeKey, {
            code: exitCode,
            failureTextHash: hashForLog(errSource),
          });
          const parsed = parseAgentError(errSource);
          const userError = formatErrorForUser(parsed);
          log.error("cursor-cli failed", {
            type: parsed.type,
            failureTextHash: hashForLog(parsed.message),
            code: exitCode,
          });
          // Return error as chat completion so user always sees it
          const errorPayload = createChatCompletionResponse(model, userError);
          return new Response(JSON.stringify(errorPayload), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        const completion = extractCompletionFromStream(stdout);
        const payload = createChatCompletionResponse(
          model,
          completion.assistantText || stdout || stderr,
          completion.reasoningText || undefined,
          completion.usage,
        );
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      // Streaming.
      const encoder = new TextEncoder();
      const id = `cursor-acp-${Date.now()}`;
      const created = Math.floor(Date.now() / 1000);
      const perf = reqPerf;
      const toolMapper = new ToolMapper();
      const toolSessionId = id;
      const passThroughTracker = new PassThroughTracker();

      perf.mark("child-dispatched");
      const sse = new ReadableStream({
        async start(controller) {
          let streamTerminated = false;
          let firstTokenReceived = false;
          let firstStdoutByteReceived = false;
          let firstSseWritten = false;
          let sawSuccessfulStreamOutput = false;
          let usage: OpenAiUsage | undefined;
          const enqueueSse = (payload: string) => {
            if (!firstSseWritten) {
              perf.mark("first-sse-write");
              firstSseWritten = true;
            }
            controller.enqueue(encoder.encode(payload));
          };
          try {
            const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
            const converter = new StreamToSseConverter(model, { id, created });
            const lineBuffer = new LineBuffer();
            const emitToolCallAndTerminate = (toolCall: OpenAiToolCall) => {
              log.debug("Intercepted OpenCode tool call (stream)", {
                name: toolCall.function.name,
                callId: toolCall.id,
              });
              const streamChunks = boundaryContext.run(
                "createStreamToolCallChunks",
                (boundary) =>
                  boundary.createStreamToolCallChunks({ id, created, model }, toolCall),
              );
              for (const chunk of streamChunks) {
                enqueueSse(`data: ${JSON.stringify(chunk)}\n\n`);
              }
              enqueueSse(formatSseDone());
              streamTerminated = true;
              try {
                child.kill();
              } catch {
                // ignore
              }
            };
            const emitTerminalAssistantErrorAndTerminate = (message: string) => {
              if (streamTerminated) {
                return;
              }
              const errChunk = createChatCompletionChunk(id, created, model, message, true);
              enqueueSse(`data: ${JSON.stringify(errChunk)}\n\n`);
              enqueueSse(formatSseDone());
              streamTerminated = true;
              try {
                child.kill();
              } catch {
                // ignore
              }
            };

            while (true) {
              if (streamTerminated) break;
              const { value, done } = await reader.read();
              if (done) break;
              if (!value || value.length === 0) continue;
              if (!firstStdoutByteReceived) { perf.mark("first-stdout-byte"); firstStdoutByteReceived = true; }
              if (!firstTokenReceived) { perf.mark("first-token"); firstTokenReceived = true; }

              for (const line of lineBuffer.push(value)) {
                if (streamTerminated) break;
                const event = parseStreamJsonLine(line);
                if (!event) {
                  continue;
                }
                captureResumeChatIdFromEvent(
                  event,
                  sessionResumeKey,
                  model,
                  workspaceDirectory,
                  sessionResumeRecordContentPrefix,
                  sessionResumeToolFingerprint,
                  sessionResumeSubagentFingerprint,
                );

                if (isResult(event)) {
                  usage = extractOpenAiUsageFromResult(event) ?? usage;
                  if (isSuccessfulResultEvent(event)) {
                    sawSuccessfulStreamOutput = true;
                  }
                }

                if (event.type === "tool_call") {
                  perf.mark("tool-call");
                  const result = await handleToolLoopEventWithFallback({
                    event: event as any,
                    boundary: boundaryContext.getBoundary(),
                    boundaryMode: boundaryContext.getBoundary().mode,
                    autoFallbackToLegacy: ENABLE_PROVIDER_BOUNDARY_AUTOFALLBACK,
                    toolLoopMode: TOOL_LOOP_MODE,
                    allowedToolNames,
                    toolSchemaMap,
                    toolLoopGuard,
                    toolMapper,
                    toolSessionId,
                    shouldEmitToolUpdates: SHOULD_EMIT_TOOL_UPDATES,
                    proxyExecuteToolCalls: PROXY_EXECUTE_TOOL_CALLS,
                    suppressConverterToolEvents: SUPPRESS_CONVERTER_TOOL_EVENTS,
                    toolRouter,
                    responseMeta: { id, created, model },
                    passThroughTracker,
                    onToolUpdate: (update) => {
                      enqueueSse(formatToolUpdateEvent(update));
                    },
                    onToolResult: (toolResult) => {
                      enqueueSse(`data: ${JSON.stringify(toolResult)}\n\n`);
                    },
                    onInterceptedToolCall: (toolCall) => {
                      emitToolCallAndTerminate(toolCall);
                    },
                    onFallbackToLegacy: (error) => {
                      boundaryContext.activateLegacyFallback("handleToolLoopEvent", error);
                    },
                  });
                  if (result.terminate) {
                    if (!result.terminate.silent) {
                      emitTerminalAssistantErrorAndTerminate(result.terminate.message);
                    } else {
                      // Silent termination: just end the stream without an error message
                      enqueueSse(formatSseDone());
                      streamTerminated = true;
                      try { child.kill(); } catch { /* ignore */ }
                    }
                    break;
                  }
                  if (result.intercepted) {
                    break;
                  }
                  if (result.skipConverter) {
                    continue;
                  }
                }

                const sseChunks = converter.handleEvent(event);
                if (sseChunks.length > 0 && (isAssistantText(event) || isThinking(event))) {
                  sawSuccessfulStreamOutput = true;
                }
                for (const sse of sseChunks) {
                  enqueueSse(sse);
                }
              }
            }
            if (streamTerminated) {
              return;
            }

            for (const line of lineBuffer.flush()) {
              if (streamTerminated) break;
              const event = parseStreamJsonLine(line);
              if (!event) {
                continue;
              }
              captureResumeChatIdFromEvent(
                event,
                sessionResumeKey,
                model,
                workspaceDirectory,
                sessionResumeRecordContentPrefix,
                sessionResumeToolFingerprint,
                sessionResumeSubagentFingerprint,
              );
              if (isResult(event)) {
                usage = extractOpenAiUsageFromResult(event) ?? usage;
                if (isSuccessfulResultEvent(event)) {
                  sawSuccessfulStreamOutput = true;
                }
              }
              if (event.type === "tool_call") {
                const result = await handleToolLoopEventWithFallback({
                  event: event as any,
                  boundary: boundaryContext.getBoundary(),
                  boundaryMode: boundaryContext.getBoundary().mode,
                  autoFallbackToLegacy: ENABLE_PROVIDER_BOUNDARY_AUTOFALLBACK,
                  toolLoopMode: TOOL_LOOP_MODE,
                  allowedToolNames,
                  toolSchemaMap,
                  toolLoopGuard,
                  toolMapper,
                  toolSessionId,
                  shouldEmitToolUpdates: SHOULD_EMIT_TOOL_UPDATES,
                  proxyExecuteToolCalls: PROXY_EXECUTE_TOOL_CALLS,
                  suppressConverterToolEvents: SUPPRESS_CONVERTER_TOOL_EVENTS,
                  toolRouter,
                  responseMeta: { id, created, model },
                  passThroughTracker,
                  onToolUpdate: (update) => {
                    enqueueSse(formatToolUpdateEvent(update));
                  },
                  onToolResult: (toolResult) => {
                    enqueueSse(`data: ${JSON.stringify(toolResult)}\n\n`);
                  },
                  onInterceptedToolCall: (toolCall) => {
                    emitToolCallAndTerminate(toolCall);
                  },
                  onFallbackToLegacy: (error) => {
                    boundaryContext.activateLegacyFallback("handleToolLoopEvent.flush", error);
                  },
                });
                if (result.terminate) {
                  if (!result.terminate.silent) {
                    emitTerminalAssistantErrorAndTerminate(result.terminate.message);
                  } else {
                    enqueueSse(formatSseDone());
                    streamTerminated = true;
                    try { child.kill(); } catch { /* ignore */ }
                  }
                  break;
                }
                if (result.intercepted) {
                  break;
                }
                if (result.skipConverter) {
                  continue;
                }
              }
              const sseChunks = converter.handleEvent(event);
              if (sseChunks.length > 0 && (isAssistantText(event) || isThinking(event))) {
                sawSuccessfulStreamOutput = true;
              }
              for (const sse of sseChunks) {
                enqueueSse(sse);
              }
            }
            if (streamTerminated) {
              return;
            }

            const exitCode = await child.exited;
            if (exitCode !== 0) {
              const stderrText = await new Response(child.stderr).text();
              const errSource = (stderrText || "").trim()
                || `cursor-agent exited with code ${String(exitCode ?? "unknown")} and no output`;
              if (shouldTreatCursorAgentFailureAsDiagnostic(errSource, sawSuccessfulStreamOutput)) {
                log.warn("cursor-agent exited non-zero after successful streamed output; treating quota text as diagnostic", {
                  code: exitCode,
                  failureTextHash: hashForLog(errSource),
                });
              } else {
                // Only evict the cached chat ID when the failure indicates the resumed
                // session itself is gone. Transient errors (network/auth/OOM/signals)
                // should not discard a valid resume ID.
                maybeEvictResumeChatId(errSource, resumeChatId, sessionResumeKey, {
                  code: exitCode,
                  failureTextHash: hashForLog(errSource),
                });
                const parsed = parseAgentError(errSource);
                const msg = formatErrorForUser(parsed);
                log.error("cursor-cli streaming failed", {
                  type: parsed.type,
                  code: exitCode,
                  failureTextHash: hashForLog(parsed.message),
                });
                const errChunk = createChatCompletionChunk(id, created, model, msg, true);
                enqueueSse(`data: ${JSON.stringify(errChunk)}\n\n`);
                enqueueSse(formatSseDone());
                return;
              }
            }

            log.debug("cursor-agent completed (bun stream)", {
              exitCode,
            });
            warnIfResumeNotCaptured(
              sessionResumeKey,
              sessionResumeKeyHash,
              sessionResumeRecordContentPrefix,
              sessionResumeToolFingerprint,
              sessionResumeSubagentFingerprint,
              model,
            );

            // Emit toast for passed-through MCP tools
            const passThroughSummary = passThroughTracker.getSummary();
            if (passThroughSummary.hasActivity) {
              await toastService.showPassThroughSummary(passThroughSummary.tools);
            }
            if (passThroughSummary.errors.length > 0) {
              await toastService.showErrorSummary(passThroughSummary.errors);
            }

            const doneChunk = createChatCompletionChunk(id, created, model, "", true);
            enqueueSse(`data: ${JSON.stringify(doneChunk)}\n\n`);
            if (usage) {
              const usageChunk = createChatCompletionUsageChunk(id, created, model, usage);
              enqueueSse(`data: ${JSON.stringify(usageChunk)}\n\n`);
            }
            enqueueSse(formatSseDone());
          } finally {
            perf.mark("request:done");
            perf.summarize();
            controller.close();
          }
        },
      });

      return new Response(sse, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return new Response(JSON.stringify({ error: message }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  };

  if (REUSE_EXISTING_PROXY) {
    // Check if another process already started a proxy on the default port
    try {
      const res = await fetchProxyHealthWithTimeout(`http://${CURSOR_PROXY_HOST}:${CURSOR_PROXY_DEFAULT_PORT}/health`);
      if (res && res.ok) {
        const payload = await res.json().catch(() => null);
        if (isReusableProxyHealthPayload(payload, workspaceDirectory)) {
          state.baseURL = CURSOR_PROXY_DEFAULT_BASE_URL;
          state.baseURLByWorkspace![normalizedWorkspace] = CURSOR_PROXY_DEFAULT_BASE_URL;
          return CURSOR_PROXY_DEFAULT_BASE_URL;
        }
      }
    } catch {
      // ignore
    }
  }

  // Use Node.js http server (works in both Node and Bun)
  const http = await import("http");

  const requestHandler = async (req: any, res: any) => {
    try{
      const url = new URL(req.url || "/", `http://${req.headers.host}`);

      if (url.pathname === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, workspaceDirectory }));
        return;
      }

      // Model list via ModelDiscoveryService (has built-in fallback models)
      if (url.pathname === "/v1/models" || url.pathname === "/models") {
        try {
          const { ModelDiscoveryService } = await import("./models/discovery.js");
          const discovery = new ModelDiscoveryService();
          const modelList = await discovery.discover(resolveRequestSdkApiKey());
          const models = modelList.map((m: any) => ({
            id: typeof m === "string" ? m : m.id,
            object: "model",
            created: Math.floor(Date.now() / 1000),
            owned_by: "cursor",
          }));
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ object: "list", data: models }));
        } catch (err) {
          log.error("Failed to list models", { error: String(err) });
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Failed to fetch models" }));
        }
        return;
      }

      if (url.pathname !== "/v1/chat/completions" && url.pathname !== "/chat/completions") {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `Unsupported path: ${url.pathname}` }));
        return;
      }

      log.debug("Proxy request (node)", { method: req.method, path: url.pathname });
      const reqPerf = new RequestPerf(`node-${Date.now()}`);
      const bodyChunks: Buffer[] = [];
      for await (const chunk of req) {
        bodyChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      reqPerf.mark("body-read");
      const body = Buffer.concat(bodyChunks).toString("utf8");

      const bodyData: any = JSON.parse(body || "{}");
      reqPerf.mark("body-parsed");
      const messages: Array<any> = Array.isArray(bodyData?.messages) ? bodyData.messages : [];
      const stream = bodyData?.stream === true;
      const tools = Array.isArray(bodyData?.tools) ? bodyData.tools : [];
      const allowedToolNames = extractAllowedToolNames(tools);
      const toolSchemaMap = buildToolSchemaMap(tools);
      const toolLoopGuard = createToolLoopGuard(messages, TOOL_LOOP_MAX_REPEAT);
      const boundaryContext = createBoundaryRuntimeContext("node-handler");

      const subagentNames = readSubagentNames();
      const model = boundaryContext.run("resolveRuntimeModel", (boundary) =>
        boundary.resolveRuntimeModel(bodyData?.model, bodyData?.cursorModel),
      );
      const authHeaderNode = req.headers["authorization"] as string | undefined;
      const sdkApiKeyNode = resolveRequestSdkApiKey(authHeaderNode);
      const backend = resolveBackendForRequest(sdkApiKeyNode);
      reqPerf.mark("backend-resolved");
      const {
        prompt,
        resumeChatId,
        sessionKey: sessionResumeKey,
        usedIncremental,
        contentPrefix: sessionResumeContentPrefix,
        recordContentPrefix: sessionResumeRecordContentPrefix,
        toolFingerprint: sessionResumeToolFingerprint,
        subagentFingerprint: sessionResumeSubagentFingerprint,
      } = resolvePromptForBackend({
        backend,
        messages,
        tools,
        subagentNames,
        model,
        workspaceDirectory,
      });
      reqPerf.mark("prompt-built");
      const sessionResumeKeyHashNode = sessionResumeKey ? sanitizeSessionKey(sessionResumeKey) : undefined;
      const resumeChatIdHashNode = resumeChatId ? sanitizeSessionKey(resumeChatId) : undefined;
      const msgSummary = messages.map((m: any, i: number) => {
        const role = m?.role ?? "?";
        const hasTc = Array.isArray(m?.tool_calls) ? m.tool_calls.length : 0;
        const tcId = m?.tool_call_id ? "yes" : "no";
        const tcName = m?.name ?? "";
        const contentLen = typeof m?.content === "string" ? m.content.length : Array.isArray(m?.content) ? `arr${m.content.length}` : typeof m?.content;
        return `${i}:${role}${hasTc ? `(tc:${hasTc})` : ""}${role === "tool" ? `(tcid:${tcId},name:${tcName},clen:${contentLen})` : `(clen:${contentLen})`}`;
      });
      log.debug("Proxy chat request (node)", {
        stream,
        model,
        messages: messages.length,
        tools: tools.length,
        promptChars: prompt.length,
        msgRoles: msgSummary.join(","),
        sessionResume: resumeChatId ? { chatIdHash: resumeChatIdHashNode, incremental: usedIncremental } : undefined,
      });

      if (backend === "sdk" && !sdkApiKeyNode) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Cursor SDK backend requires a real Cursor API key. Set CURSOR_API_KEY or run `opencode auth login`; the legacy `cursor-agent` placeholder is not valid SDK auth." }));
        return;
      }

      reqPerf.mark("child-create-start");
      const child = createNodeChildForBackend({
        backend,
        sdkApiKey: sdkApiKeyNode,
        model,
        prompt,
        workspaceDirectory,
        resumeChatId,
      });
      reqPerf.mark("child-created");

      if (!stream) {
        const stdoutChunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];
        let spawnErrorText: string | null = null;

        child.on("error", (error: any) => {
          spawnErrorText = String(error?.message || error);
          log.error("Failed to spawn cursor-agent", { errorHash: hashForLog(spawnErrorText), model });
        });

        child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
        child.stderr.on("data", (chunk) => stderrChunks.push(chunk));

        child.on("close", async (code) => {
          const stdout = Buffer.concat(stdoutChunks).toString().trim();
          const stderr = Buffer.concat(stderrChunks).toString().trim();
          log.debug("cursor-agent completed (node non-stream)", {
            code,
            stdoutChars: stdout.length,
            stderrChars: stderr.length,
            spawnError: spawnErrorText != null,
          });
          captureResumeChatIdFromOutput(
            stdout,
            sessionResumeKey,
            model,
            workspaceDirectory,
            sessionResumeRecordContentPrefix,
            sessionResumeToolFingerprint,
            sessionResumeSubagentFingerprint,
          );
          warnIfResumeNotCaptured(
            sessionResumeKey,
            sessionResumeKeyHashNode,
            sessionResumeRecordContentPrefix,
            sessionResumeToolFingerprint,
            sessionResumeSubagentFingerprint,
            model,
          );
          const meta = {
            id: `cursor-acp-${Date.now()}`,
            created: Math.floor(Date.now() / 1000),
            model,
          };
          const intercepted = await findFirstAllowedToolCallInOutput(stdout, {
            toolLoopMode: TOOL_LOOP_MODE,
            allowedToolNames,
            toolSchemaMap,
            toolLoopGuard,
            boundaryContext,
            responseMeta: meta,
          });
          if (intercepted.terminationMessage) {
            const terminationResponse = createChatCompletionResponse(model, intercepted.terminationMessage);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(terminationResponse));
            return;
          }

          if (intercepted.toolCall) {
            log.debug("Intercepted OpenCode tool call (non-stream)", {
              name: intercepted.toolCall.function.name,
              callId: intercepted.toolCall.id,
            });
            const payload = boundaryContext.run(
              "createNonStreamToolCallResponse",
              (boundary) => boundary.createNonStreamToolCallResponse(meta, intercepted.toolCall),
            );
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(payload));
            return;
          }

          const completion = extractCompletionFromStream(stdout);

          if (code !== 0 || spawnErrorText) {
            const errSource =
              stderr
              || stdout
              || spawnErrorText
              || `cursor-agent exited with code ${String(code ?? "unknown")} and no output`;
            // Only evict the cached chat ID when the failure indicates the resumed
            // session itself is gone. Transient errors (network/auth/OOM/signals)
            // should not discard a valid resume ID.
            maybeEvictResumeChatId(errSource, resumeChatId, sessionResumeKey, {
              code,
              spawnError: spawnErrorText != null,
              failureTextHash: hashForLog(errSource),
            });
            const parsed = parseAgentError(errSource);
            const userError = formatErrorForUser(parsed);
            log.error("cursor-cli failed", {
              type: parsed.type,
              failureTextHash: hashForLog(parsed.message),
              code,
            });
            // Return error as chat completion so user always sees it
            const errorResponse = createChatCompletionResponse(model, userError);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(errorResponse));
            return;
          }

          const response = createChatCompletionResponse(
            model,
            completion.assistantText || stdout || stderr,
            completion.reasoningText || undefined,
            completion.usage,
          );

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(response));
        });
      } else {
        // Streaming
        if (res.socket) res.socket.setNoDelay(true);
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.flushHeaders();

        const id = `cursor-acp-${Date.now()}`;
        const created = Math.floor(Date.now() / 1000);
        const perf = reqPerf;
        perf.mark("child-dispatched");

        const converter = new StreamToSseConverter(model, { id, created });
        const lineBuffer = new LineBuffer();
        const toolMapper = new ToolMapper();
        const toolSessionId = id;
        const passThroughTracker = new PassThroughTracker();
        const stderrChunks: Buffer[] = [];
        let streamTerminated = false;
        let firstTokenReceived = false;
        let firstStdoutByteReceived = false;
        let firstSseWritten = false;
        let sawSuccessfulStreamOutput = false;
        let usage: OpenAiUsage | undefined;
        const writeSse = (payload: string) => {
          if (!firstSseWritten) {
            perf.mark("first-sse-write");
            firstSseWritten = true;
          }
          res.write(payload);
        };
        child.stderr.on("data", (chunk) => {
          stderrChunks.push(Buffer.from(chunk));
        });
        child.on("error", (error: any) => {
          if (streamTerminated || res.writableEnded) {
            return;
          }
          const errSource = String(error?.message || error);
          log.error("Failed to spawn cursor-agent (stream)", { errorHash: hashForLog(errSource), model });
          const parsed = parseAgentError(errSource);
          const msg = formatErrorForUser(parsed);
          const errChunk = createChatCompletionChunk(id, created, model, msg, true);
          writeSse(`data: ${JSON.stringify(errChunk)}\n\n`);
          writeSse(formatSseDone());
          streamTerminated = true;
          res.end();
        });
        const emitToolCallAndTerminate = (toolCall: OpenAiToolCall) => {
          if (streamTerminated || res.writableEnded) {
            return;
          }
          log.debug("Intercepted OpenCode tool call (stream)", {
            name: toolCall.function.name,
            callId: toolCall.id,
          });
          const streamChunks = boundaryContext.run(
            "createStreamToolCallChunks",
            (boundary) =>
              boundary.createStreamToolCallChunks({ id, created, model }, toolCall),
          );
          for (const chunk of streamChunks) {
            writeSse(`data: ${JSON.stringify(chunk)}\n\n`);
          }
          writeSse(formatSseDone());
          streamTerminated = true;
          res.end();
          try {
            child.kill();
          } catch {
            // ignore
          }
        };
        const emitTerminalAssistantErrorAndTerminate = (message: string) => {
          if (streamTerminated || res.writableEnded) {
            return;
          }
          const errChunk = createChatCompletionChunk(id, created, model, message, true);
          writeSse(`data: ${JSON.stringify(errChunk)}\n\n`);
          writeSse(formatSseDone());
          streamTerminated = true;
          res.end();
          try {
            child.kill();
          } catch {
            // ignore
          }
        };

        const chunkQueue: Buffer[] = [];
        let draining = false;
        let childClosed = false;
        let childCloseHandled = false;
        let childExitCode: number | null = null;

        const processLines = async (lines: string[]) => {
          for (const line of lines) {
            if (streamTerminated || res.writableEnded) break;
            const event = parseStreamJsonLine(line);
            if (!event) continue;
            captureResumeChatIdFromEvent(
              event,
              sessionResumeKey,
              model,
              workspaceDirectory,
              sessionResumeRecordContentPrefix,
              sessionResumeToolFingerprint,
              sessionResumeSubagentFingerprint,
            );

            if (isResult(event)) {
              usage = extractOpenAiUsageFromResult(event) ?? usage;
              if (isSuccessfulResultEvent(event)) {
                sawSuccessfulStreamOutput = true;
              }
            }

            if (event.type === "tool_call") {
              perf.mark("tool-call");
              const result = await handleToolLoopEventWithFallback({
                event: event as any,
                boundary: boundaryContext.getBoundary(),
                boundaryMode: boundaryContext.getBoundary().mode,
                autoFallbackToLegacy: ENABLE_PROVIDER_BOUNDARY_AUTOFALLBACK,
                toolLoopMode: TOOL_LOOP_MODE,
                allowedToolNames,
                toolSchemaMap,
                toolLoopGuard,
                toolMapper,
                toolSessionId,
                shouldEmitToolUpdates: SHOULD_EMIT_TOOL_UPDATES,
                proxyExecuteToolCalls: PROXY_EXECUTE_TOOL_CALLS,
                suppressConverterToolEvents: SUPPRESS_CONVERTER_TOOL_EVENTS,
                toolRouter,
                responseMeta: { id, created, model },
                passThroughTracker,
                onToolUpdate: (update) => {
                  writeSse(formatToolUpdateEvent(update));
                },
                onToolResult: (toolResult) => {
                  writeSse(`data: ${JSON.stringify(toolResult)}\n\n`);
                },
                onInterceptedToolCall: (toolCall) => {
                  emitToolCallAndTerminate(toolCall);
                },
                onFallbackToLegacy: (error) => {
                  boundaryContext.activateLegacyFallback("handleToolLoopEvent", error);
                },
              });
              if (result.terminate) {
                if (!result.terminate.silent) {
                  emitTerminalAssistantErrorAndTerminate(result.terminate.message);
                } else {
                  streamTerminated = true;
                  try { child.kill(); } catch { /* ignore */ }
                }
                break;
              }
              if (result.intercepted) break;
              if (result.skipConverter) continue;
            }

            if (streamTerminated || res.writableEnded) break;
            const sseChunks = converter.handleEvent(event);
            if (sseChunks.length > 0 && (isAssistantText(event) || isThinking(event))) {
              sawSuccessfulStreamOutput = true;
            }
            for (const sse of sseChunks) {
              writeSse(sse);
            }
          }
        };

        const drainQueue = async () => {
          if (draining) return;
          draining = true;
          try {
            while (chunkQueue.length > 0) {
              if (streamTerminated || res.writableEnded) break;
              const chunk = chunkQueue.shift()!;
              if (!firstStdoutByteReceived) { perf.mark("first-stdout-byte"); firstStdoutByteReceived = true; }
              if (!firstTokenReceived) { perf.mark("first-token"); firstTokenReceived = true; }
              await processLines(lineBuffer.push(chunk));
            }

            if (childClosed && !childCloseHandled && !streamTerminated && !res.writableEnded) {
              childCloseHandled = true;
              await processLines(lineBuffer.flush());
              if (streamTerminated || res.writableEnded) return;

              perf.mark("request:done");
              perf.summarize();
              const stderrText = Buffer.concat(stderrChunks).toString().trim();
              log.debug("cursor-agent completed (node stream)", {
                code: childExitCode,
                stderrChars: stderrText.length,
              });
              if (childExitCode !== 0) {
                const errSource =
                  stderrText
                  || `cursor-agent exited with code ${String(childExitCode ?? "unknown")} and no output`;
                if (shouldTreatCursorAgentFailureAsDiagnostic(errSource, sawSuccessfulStreamOutput)) {
                  log.warn("cursor-agent exited non-zero after successful streamed output; treating quota text as diagnostic", {
                    code: childExitCode,
                    failureTextHash: hashForLog(errSource),
                  });
                } else {
                  // Only evict the cached chat ID when the failure indicates the resumed
                  // session itself is gone. Transient errors (network/auth/OOM/signals)
                  // should not discard a valid resume ID.
                  maybeEvictResumeChatId(errSource, resumeChatId, sessionResumeKey, {
                    code: childExitCode,
                    failureTextHash: hashForLog(errSource),
                  });
                  const parsed = parseAgentError(errSource);
                  const msg = formatErrorForUser(parsed);
                  const errChunk = createChatCompletionChunk(id, created, model, msg, true);
                  writeSse(`data: ${JSON.stringify(errChunk)}\n\n`);
                  writeSse(formatSseDone());
                  streamTerminated = true;
                  res.end();
                  return;
                }
              }

              warnIfResumeNotCaptured(
                sessionResumeKey,
                sessionResumeKeyHashNode,
                sessionResumeRecordContentPrefix,
                sessionResumeToolFingerprint,
                sessionResumeSubagentFingerprint,
                model,
              );

              const passThroughSummary = passThroughTracker.getSummary();
              if (passThroughSummary.hasActivity) {
                await toastService.showPassThroughSummary(passThroughSummary.tools);
              }
              if (passThroughSummary.errors.length > 0) {
                await toastService.showErrorSummary(passThroughSummary.errors);
              }

              const doneChunk = {
                id,
                object: "chat.completion.chunk",
                created,
                model,
                choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
              };
              writeSse(`data: ${JSON.stringify(doneChunk)}\n\n`);
              if (usage) {
                const usageChunk = createChatCompletionUsageChunk(id, created, model, usage);
                writeSse(`data: ${JSON.stringify(usageChunk)}\n\n`);
              }
              writeSse(formatSseDone());
              streamTerminated = true;
              res.end();
            }
          } finally {
            draining = false;
            if (
              !streamTerminated
              && !res.writableEnded
              && (chunkQueue.length > 0 || (childClosed && !childCloseHandled))
            ) {
              drainQueue();
            }
          }
        };

        child.stdout.on("data", (chunk) => {
          chunkQueue.push(Buffer.from(chunk));
          drainQueue();
        });

        child.on("close", (code) => {
          childClosed = true;
          childExitCode = code;
          drainQueue();
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: message }));
    }
  };

  let server = http.createServer(requestHandler);

  // Try to start on default port
  try {
    await new Promise<void>((resolve, reject) => {
      server.listen(CURSOR_PROXY_DEFAULT_PORT, CURSOR_PROXY_HOST, () => resolve());
      server.once("error", reject);
    });

    const baseURL = `http://${CURSOR_PROXY_HOST}:${CURSOR_PROXY_DEFAULT_PORT}/v1`;
    state.baseURL = baseURL;
    state.baseURLByWorkspace![normalizedWorkspace] = baseURL;
    return baseURL;
  } catch (error: any) {
    if (error?.code !== "EADDRINUSE") {
      throw error;
    }

    if (REUSE_EXISTING_PROXY) {
      // Port in use - check if it's our proxy
      try {
        const res = await fetchProxyHealthWithTimeout(`http://${CURSOR_PROXY_HOST}:${CURSOR_PROXY_DEFAULT_PORT}/health`);
        if (res && res.ok) {
          const payload = await res.json().catch(() => null);
          if (isReusableProxyHealthPayload(payload, workspaceDirectory)) {
            state.baseURL = CURSOR_PROXY_DEFAULT_BASE_URL;
            state.baseURLByWorkspace![normalizedWorkspace] = CURSOR_PROXY_DEFAULT_BASE_URL;
            return CURSOR_PROXY_DEFAULT_BASE_URL;
          }
        }
      } catch {
        // ignore
      }
    }

    // Start on random port
    server = http.createServer(requestHandler);
    await new Promise<void>((resolve, reject) => {
      server.listen(0, CURSOR_PROXY_HOST, () => resolve());
      server.once("error", reject);
    });

    const addr = server.address() as any;
    const baseURL = `http://${CURSOR_PROXY_HOST}:${addr.port}/v1`;
    state.baseURL = baseURL;
    state.baseURLByWorkspace![normalizedWorkspace] = baseURL;
    return baseURL;
  }
}

/**
 * Convert JSON Schema parameters to Zod schemas for plugin tool hook
 */
function jsonSchemaToZod(jsonSchema: any): any {
  const z = tool.schema;
  const properties = jsonSchema.properties || {};
  const required = jsonSchema.required || [];

  const zodShape: any = {};

  for (const [key, prop] of Object.entries(properties)) {
    const p = prop as any;
    let zodType: any;

    switch (p.type) {
      case "string":
        zodType = z.string();
        if (p.description) {
          zodType = zodType.describe(p.description);
        }
        break;
      case "number":
        zodType = z.number();
        if (p.description) {
          zodType = zodType.describe(p.description);
        }
        break;
      case "boolean":
        zodType = z.boolean();
        if (p.description) {
          zodType = zodType.describe(p.description);
        }
        break;
      case "object":
        zodType = z.record(z.string(), z.any());
        if (p.description) {
          zodType = zodType.describe(p.description);
        }
        break;
      case "array":
        zodType = z.array(z.any());
        if (p.description) {
          zodType = zodType.describe(p.description);
        }
        break;
      default:
        zodType = z.any();
        break;
    }

    // Make optional if not in required array
    if (!required.includes(key)) {
      zodType = zodType.optional();
    }

    zodShape[key] = zodType;
  }

  return zodShape;
}

function resolveToolContextBaseDirWithSession(
  context: any,
  fallbackBaseDir?: string,
  sessionWorkspaceBySession?: Map<string, string>,
): string | null {
  const sessionID = typeof context?.sessionID === "string" && context.sessionID.trim().length > 0
    ? context.sessionID.trim()
    : "";

  const worktree = resolveCandidate(typeof context?.worktree === "string" ? context.worktree : undefined);
  const directory = resolveCandidate(typeof context?.directory === "string" ? context.directory : undefined);
  const fallback = resolveCandidate(fallbackBaseDir);
  const pinned = sessionID && sessionWorkspaceBySession
    ? resolveCandidate(sessionWorkspaceBySession.get(sessionID))
    : "";

  const pinSession = (candidate: string) => {
    if (sessionID && sessionWorkspaceBySession && isNonConfigPath(candidate)) {
      if (!sessionWorkspaceBySession.has(sessionID) && sessionWorkspaceBySession.size >= SESSION_WORKSPACE_CACHE_LIMIT) {
        const oldestSession = sessionWorkspaceBySession.keys().next().value;
        if (typeof oldestSession === "string") {
          sessionWorkspaceBySession.delete(oldestSession);
        }
      }
      sessionWorkspaceBySession.set(sessionID, candidate);
    }
  };

  if (isNonConfigPath(worktree)) {
    pinSession(worktree);
    return worktree;
  }

  if (isNonConfigPath(pinned)) {
    return pinned;
  }

  if (isNonConfigPath(directory)) {
    pinSession(directory);
    return directory;
  }

  if (isNonConfigPath(fallback)) {
    pinSession(fallback);
    return fallback;
  }

  return null;
}

function toAbsoluteWithBase(value: unknown, baseDir: string): unknown {
  if (typeof value !== "string") {
    return value;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || isAbsolute(trimmed)) {
    return value;
  }
  return resolve(baseDir, trimmed);
}

function applyToolContextDefaults(
  toolName: string,
  rawArgs: Record<string, unknown>,
  context: any,
  fallbackBaseDir?: string,
  sessionWorkspaceBySession?: Map<string, string>,
): Record<string, unknown> {
  const baseDir = resolveToolContextBaseDirWithSession(context, fallbackBaseDir, sessionWorkspaceBySession);
  if (!baseDir) {
    return rawArgs;
  }

  const args: Record<string, unknown> = { ...rawArgs };

  for (const key of [
    "path",
    "filePath",
    "targetPath",
    "directory",
    "dir",
    "folder",
    "targetDirectory",
    "targetFile",
    "cwd",
    "workdir",
  ]) {
    args[key] = toAbsoluteWithBase(args[key], baseDir);
  }

  const baseName = toolName.startsWith("oc_") ? toolName.slice(3) : toolName;

  if ((baseName === "bash" || baseName === "shell") && args.cwd === undefined && args.workdir === undefined) {
    args.cwd = baseDir;
  }

  if ((baseName === "grep" || baseName === "glob" || baseName === "ls") && args.path === undefined) {
    args.path = baseDir;
  }

  return args;
}

/**
 * Build tool hook entries from local registry
 */
const NATIVE_TOOL_HOOK_EXCLUSIONS = new Set(["grep"]);

function buildToolHookEntries(registry: CoreRegistry, fallbackBaseDir?: string): Record<string, any> {
  const entries: Record<string, any> = {};
  const sessionWorkspaceBySession = new Map<string, string>();
  const tools = registry.list();
  for (const t of tools) {
    if (NATIVE_TOOL_HOOK_EXCLUSIONS.has(t.name)) continue;

    const handler = registry.getHandler(t.name);
    if (!handler) continue;

    const zodArgs = jsonSchemaToZod(t.parameters);
    const createEntry = (toolName: string) =>
      tool({
        description: t.description,
        args: zodArgs,
        async execute(args: any, context: any) {
          try {
            const normalizedArgs = applyToolContextDefaults(
              toolName,
              args,
              context,
              fallbackBaseDir,
              sessionWorkspaceBySession,
            );
            return await handler(normalizedArgs);
          } catch (error: any) {
            log.debug("Tool hook execution failed", { tool: toolName, error: String(error?.message || error) });
            throw error;
          }
        },
      });

    entries[t.name] = createEntry(t.name);

    const ocAlias = `oc_${t.id}`;
    if (!entries[ocAlias]) {
      entries[ocAlias] = createEntry(ocAlias);
    }

    // Some agent variants emit "shell" instead of "bash".
    if (t.name === "bash" && !entries.shell) {
      entries.shell = createEntry("shell");
    }
  }

  return entries;
}

/**
 * OpenCode plugin for Cursor Agent
 */
export const CursorPlugin: Plugin = async ({ $, directory, worktree, client, serverUrl }: PluginInput) => {
  const workspaceDirectory = resolveWorkspaceDirectory(worktree, directory);
  log.debug("Plugin initializing", {
    directory,
    worktree,
    workspaceDirectory,
    cwd: process.cwd(),
    serverUrl: serverUrl?.toString(),
  });
  if (!TOOL_LOOP_MODE_VALID) {
    log.warn("Invalid CURSOR_ACP_TOOL_LOOP_MODE; defaulting to opencode", { value: TOOL_LOOP_MODE_RAW });
  }
  if (!PROVIDER_BOUNDARY_MODE_VALID) {
    log.warn("Invalid CURSOR_ACP_PROVIDER_BOUNDARY; defaulting to v1", {
      value: PROVIDER_BOUNDARY_MODE_RAW,
    });
  }
  if (!TOOL_LOOP_MAX_REPEAT_VALID) {
    log.warn("Invalid CURSOR_ACP_TOOL_LOOP_MAX_REPEAT; defaulting to 3", {
      value: TOOL_LOOP_MAX_REPEAT_RAW,
    });
  }
  if (ENABLE_PROVIDER_BOUNDARY_AUTOFALLBACK && PROVIDER_BOUNDARY.mode !== "v1") {
    log.debug("Provider boundary auto-fallback is enabled but inactive unless mode=v1");
  }
  log.info("Tool loop mode configured", {
    mode: TOOL_LOOP_MODE,
    providerBoundary: PROVIDER_BOUNDARY.mode,
    proxyExecToolCalls: PROXY_EXECUTE_TOOL_CALLS,
    providerBoundaryAutoFallback: ENABLE_PROVIDER_BOUNDARY_AUTOFALLBACK,
    toolLoopMaxRepeat: TOOL_LOOP_MAX_REPEAT,
  });
  await ensurePluginDirectory();

  // Auto-refresh model list from cursor-agent (non-blocking, fire-and-forget)
  autoRefreshModels().catch(() => {});

  // MCP tool bridge: connect to MCP servers and register their tools.
  // We await init so tools are available before the plugin returns its tool hook.
  const mcpManager = new McpClientManager();
  let mcpToolEntries: Record<string, any> = {};
  let mcpToolDefs: any[] = [];
  let mcpToolSummaries: McpToolSummary[] = [];
  const mcpEnabled = process.env.CURSOR_ACP_MCP_BRIDGE !== "false"; // default ON

  if (mcpEnabled) {
    try {
      const configs = readMcpConfigs();
      if (configs.length === 0) {
        log.debug("No MCP servers configured, skipping MCP bridge");
      } else {
        log.debug("MCP bridge: connecting to servers", { count: configs.length });

        await Promise.allSettled(configs.map((c) => mcpManager.connectServer(c)));

        const tools = mcpManager.listTools();
        if (tools.length === 0) {
          log.debug("MCP bridge: no tools discovered");
        } else {
          mcpToolEntries = buildMcpToolHookEntries(tools, mcpManager);
          mcpToolDefs = buildMcpToolDefinitions(tools);
          mcpToolSummaries = tools.map((t) => ({
            serverName: t.serverName,
            toolName: t.name,
            callName: namespaceMcpTool(t.serverName, t.name),
            description: t.description,
            params: t.inputSchema
              ? Object.keys((t.inputSchema as any).properties ?? {})
              : undefined,
          }));
          log.info("MCP bridge: registered tools", {
            servers: mcpManager.connectedServers.length,
            tools: Object.keys(mcpToolEntries).length,
          });
        }
      }
    } catch (err) {
      log.debug("MCP bridge init failed", { error: String(err) });
    }
  }

  // Initialize toast service for MCP pass-through notifications
  toastService.setClient(client);

  // Tools (skills) discovery/execution wiring
  const toolsEnabled = process.env.CURSOR_ACP_ENABLE_OPENCODE_TOOLS !== "false"; // default ON
  const legacyProxyToolPathsEnabled = toolsEnabled && TOOL_LOOP_MODE === "proxy-exec";
  if (toolsEnabled && TOOL_LOOP_MODE === "opencode") {
    log.debug("OpenCode mode active; skipping legacy SDK/MCP discovery and proxy-side tool execution");
  } else if (toolsEnabled && TOOL_LOOP_MODE === "off") {
    log.debug("Tool loop mode off; proxy-side tool execution disabled");
  }
  // FORWARD_TOOL_CALLS is only used when TOOL_LOOP_MODE=proxy-exec.
  // Build a client with serverUrl so SDK tool.list works even if the injected client isn't fully configured.
  const serverClient = legacyProxyToolPathsEnabled
    ? createOpencodeClient({ baseUrl: serverUrl.toString(), directory: workspaceDirectory })
    : null;
  const discovery = legacyProxyToolPathsEnabled ? new OpenCodeToolDiscovery(serverClient ?? client) : null;

  // Build executor chain: Local -> SDK -> MCP
  const localRegistry = new CoreRegistry();
  registerDefaultTools(localRegistry);

  const timeoutMs = Number(process.env.CURSOR_ACP_TOOL_TIMEOUT_MS || 30000);
  const localExec = new LocalExecutor(localRegistry);
  const sdkExec = legacyProxyToolPathsEnabled ? new SdkExecutor(serverClient ?? client, timeoutMs) : null;
  const mcpExec = legacyProxyToolPathsEnabled ? new McpExecutor(serverClient ?? client, timeoutMs) : null;

  const executorChain: IToolExecutor[] = [localExec];
  if (sdkExec) executorChain.push(sdkExec);
  if (mcpExec) executorChain.push(mcpExec);

  const toolsByName = new Map<string, any>();
  const skillLoader = new SkillLoader();
  let skillResolver: SkillResolver | null = null;

  const router = legacyProxyToolPathsEnabled
    ? new ToolRouter({
        execute: (toolId, args) => executeWithChain(executorChain, toolId, args),
        toolsByName,
        resolveName: (name) => skillResolver?.resolve(name),
      })
    : null;
  let lastToolNames: string[] = [];
  let lastToolMap: Array<{ id: string; name: string }> = [];

  async function refreshTools() {
    toolsByName.clear();

    const toolEntries: any[] = [];
    const add = (name: string, t: any) => {
      if (!toolsByName.has(name)) {
        toolsByName.set(name, t);
      }
      toolEntries.push({
        type: "function" as const,
        function: {
          name,
          description: `${describeTool(t)} (skill id: ${t.id})`,
          parameters: toOpenAiParameters(t.parameters),
        },
      });
    };

    // Always include local tools — these work regardless of SDK connectivity
    const localTools = localRegistry.list().map((t) => ({ ...t, name: `oc_${t.id}` }));
    for (const asTool of localTools) {
      const nsName = asTool.name;
      add(nsName, asTool);
    }

    // Layer SDK/MCP-discovered tools on top (best-effort)
    let discoveredList: any[] = [];
    if (discovery) {
      try {
        discoveredList = await discovery.listTools();
        discoveredList.forEach((t) => toolsByName.set(t.name, t));
      } catch (err) {
        log.debug("Tool discovery failed, using local tools only", { error: String(err) });
      }
    }

    // Load skills and initialize resolver for alias resolution
    const allTools = [...localTools, ...discoveredList];
    const skills = skillLoader.load(allTools);
    skillResolver = new SkillResolver(skills);

    // Populate executors with their respective tool IDs
    if (sdkExec) {
      sdkExec.setToolIds(discoveredList.filter((t) => t.source === "sdk").map((t) => t.id));
    }
    if (mcpExec) {
      mcpExec.setToolIds(discoveredList.filter((t) => t.source === "mcp").map((t) => t.id));
    }

    for (const t of discoveredList) {
      add(t.name, t);

      if (t.name === "bash" && !toolsByName.has("shell")) {
        add("shell", t);
      }

      const baseId = t.id.replace(/[^a-zA-Z0-9_\\-]/g, "_");
      const skillAlias = `oc_skill_${baseId}`.slice(0, 64);
      if (!toolsByName.has(skillAlias)) add(skillAlias, t);
      const superAlias = `oc_superskill_${baseId}`.slice(0, 64);
      if (!toolsByName.has(superAlias)) add(superAlias, t);
      const spAlias = `oc_superpowers_${baseId}`.slice(0, 64);
      if (!toolsByName.has(spAlias)) add(spAlias, t);
    }

    lastToolNames = toolEntries.map((e) => e.function.name);
    lastToolMap = allTools.map((t) => ({ id: t.id, name: t.name }));
    log.debug("Tools refreshed", { local: localTools.length, discovered: discoveredList.length, total: toolEntries.length });
    return toolEntries;
  }

  const proxyBaseURL = await ensureCursorProxyServer(workspaceDirectory, router);
  log.debug("Proxy server started", { baseURL: proxyBaseURL });

  // Build tool hook entries from local registry
  const toolHookEntries = buildToolHookEntries(localRegistry, workspaceDirectory);

  return {
    tool: { ...toolHookEntries, ...mcpToolEntries },
    auth: {
      provider: CURSOR_PROVIDER_ID,
      async loader(getAuth: () => Promise<Auth>) {
        // Load API key from OpenCode auth store and cache it.
        // Never throw: a missing/unreadable auth entry must not break plugin load.
        try {
          const auth = await getAuth();
          if (auth?.type === "api" && auth.key) {
            storedApiKey = auth.key;
            log.debug("Stored API key from auth loader");
          }
        } catch (err) {
          log.debug("No stored auth available", { error: String(err) });
        }
        return {};
      },
      methods: [
        {
          type: "api" as const,
          label: "Cursor API Key (cursor.com/settings)",
        },
      ],
    },

    async "chat.params"(input: any, output: any) {
      const boundaryContext = createBoundaryRuntimeContext("chat.params");

      const providerMatch = boundaryContext.run("matchesProvider", (boundary) =>
        boundary.matchesProvider(input.model),
      );
      if (!providerMatch) {
        return;
      }

      boundaryContext.run("applyChatParamDefaults", (boundary) =>
        boundary.applyChatParamDefaults(
          output,
          proxyBaseURL,
          CURSOR_PROXY_DEFAULT_BASE_URL,
          "cursor-agent",
        ),
      );

      // Tool definitions handling:
      // - proxy-exec mode: provider injects tool definitions directly.
      // - opencode mode: preserve OpenCode-provided tools, fallback only when absent.
      if (toolsEnabled) {
        try {
          const existingTools = output.options.tools;
          const shouldRefresh =
            TOOL_LOOP_MODE === "proxy-exec"
            || (TOOL_LOOP_MODE === "opencode" && existingTools == null);
          const refreshedTools = shouldRefresh ? await refreshTools() : [];
          const resolved = boundaryContext.run("resolveChatParamTools", (boundary) =>
            boundary.resolveChatParamTools(TOOL_LOOP_MODE, existingTools, refreshedTools),
          );

          if (resolved.action === "override" || resolved.action === "fallback") {
            output.options.tools = resolved.tools;
          } else if (resolved.action === "preserve") {
            const count = Array.isArray(existingTools) ? existingTools.length : 0;
            log.debug("Using OpenCode-provided tools from chat.params", { count });
          }
        } catch (err) {
          log.debug("Failed to refresh tools", { error: String(err) });
        }
      }

      // Append MCP bridge tool definitions so the model can call them
      if (mcpToolDefs.length > 0) {
        const beforeTools = Array.isArray(output.options.tools) ? output.options.tools : [];
        if (Array.isArray(output.options.tools)) {
          output.options.tools = [...output.options.tools, ...mcpToolDefs];
        } else {
          output.options.tools = mcpToolDefs;
        }
        const afterTools = Array.isArray(output.options.tools) ? output.options.tools : [];
        log.debug("Injected MCP tool definitions into chat.params", {
          injectedCount: mcpToolDefs.length,
          beforeCount: beforeTools.length,
          afterCount: afterTools.length,
          mcpNames: mcpToolDefs.slice(0, 10).map((t: any) => t?.function?.name ?? t?.name ?? "unknown"),
          tailNames: afterTools.slice(-10).map((t: any) => t?.function?.name ?? t?.name ?? "unknown"),
        });
      }
    },

    async "experimental.chat.system.transform"(input: any, output: { system: string[] }) {
      if (!toolsEnabled) return;
      const boundaryContext = createBoundaryRuntimeContext("experimental.chat.system.transform");
      const providerMatch = boundaryContext.run("matchesProvider", (boundary) =>
        boundary.matchesProvider(input.model),
      );
      if (!providerMatch) {
        return;
      }
      const subagentNames = readSubagentNames();
      const systemMessage = buildAvailableToolsSystemMessage(
        lastToolNames, lastToolMap, mcpToolDefs, mcpToolSummaries,
        subagentNames,
      );
      if (!systemMessage) return;
      output.system = output.system || [];
      output.system.push(systemMessage);
    },
  };
};

export default CursorPlugin;
