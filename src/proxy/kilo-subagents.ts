export interface KiloSubagentSummary {
  name: string;
  description: string;
}

const CURSOR_NATIVE_TASK_MISUSE_RE = /unknown agent type:\s*custom/i;

/** Parse `- name: description` lines from Kilo's task tool description. */
export function parseKiloSubagentsFromTaskDescription(description: string): KiloSubagentSummary[] {
  const subagents: KiloSubagentSummary[] = [];
  for (const line of description.split("\n")) {
    const match = line.match(/^\s*-\s*([a-zA-Z0-9][a-zA-Z0-9_.-]*)\s*:\s*(.+)\s*$/);
    if (!match) {
      continue;
    }
    subagents.push({
      name: match[1],
      description: match[2].trim(),
    });
  }
  return subagents;
}

function readTaskToolDescription(tool: unknown): string | null {
  if (!tool || typeof tool !== "object") {
    return null;
  }
  const record = tool as Record<string, unknown>;
  const fn = (record.function && typeof record.function === "object"
    ? record.function
    : record) as Record<string, unknown>;
  const name = typeof fn.name === "string" ? fn.name.trim() : "";
  if (name !== "task") {
    return null;
  }
  return typeof fn.description === "string" ? fn.description : null;
}

/** Extract registered Kilo subagents from the active request tool list. */
export function extractKiloSubagentsFromTools(tools: unknown[]): KiloSubagentSummary[] {
  for (const tool of tools) {
    const description = readTaskToolDescription(tool);
    if (description) {
      return parseKiloSubagentsFromTaskDescription(description);
    }
  }
  return [];
}

export function formatKiloSubagentList(subagents: KiloSubagentSummary[]): string {
  if (subagents.length === 0) {
    return "  (see the task tool description for allowed subagent_type values)";
  }
  return subagents
    .map((entry) => `  - ${entry.name}: ${entry.description}`)
    .join("\n");
}

export function buildKiloSubagentSystemMessage(subagents: KiloSubagentSummary[]): string | null {
  if (subagents.length === 0) {
    return null;
  }

  return [
    "KILO SUBAGENTS — Delegate only through Kilo's task tool, never Cursor's built-in Task tool.",
    "Use the JSON bridge envelope with subagent_type as a plain string.",
    "Never use subagentType, never use { custom: \"name\" }, and never call Cursor's native Task/delegateTask roster.",
    "",
    "Registered Kilo subagents:",
    formatKiloSubagentList(subagents),
  ].join("\n");
}

export function buildKiloTaskBridgeContext(subagents: KiloSubagentSummary[]): string {
  const roster = formatKiloSubagentList(subagents);
  return [
    "SYSTEM: OpenCode Task bridge mode is active.",
    "For Task only, the exact envelope below overrides the earlier generic \"standard OpenAI tool_call\" instruction.",
    "Do not add id, type, or function fields, and do not stringify arguments.",
    "OpenCode owns the task tool. Do not invoke Cursor's built-in Task tool; it uses a different subagent list.",
    "Never use subagentType. Never use { custom: \"name\" } or any Cursor subagent wrapper.",
    "Use subagent_type as a plain string from the Kilo roster below.",
    "To call OpenCode's task tool, respond with exactly one JSON object and no prose:",
    "{\"name\":\"task\",\"arguments\":{\"description\":\"3-5 words\",\"prompt\":\"task details\",\"subagent_type\":\"one name listed below\"}}",
    "",
    "Allowed Kilo subagent_type values:",
    roster,
    "",
    "Use this only when delegating through OpenCode/Kilo. Otherwise answer normally.",
  ].join("\n");
}

export function isCursorNativeTaskMisuse(text: string): boolean {
  return CURSOR_NATIVE_TASK_MISUSE_RE.test(text);
}

export function buildCursorNativeTaskRetryMessage(
  subagents: KiloSubagentSummary[],
  originalText?: string,
): string {
  const roster = formatKiloSubagentList(subagents);
  const lines = [
    "cursor-kilo: The model attempted Cursor's native Task tool instead of Kilo's task tool.",
    "That path only works for .cursor/agents/* and fails with \"Unknown agent type: custom\" for Kilo-only subagents.",
    "",
    "Retry through Kilo's task tool using this JSON envelope (no subagentType, no { custom: ... }):",
    "{\"name\":\"task\",\"arguments\":{\"description\":\"3-5 words\",\"prompt\":\"task details\",\"subagent_type\":\"<kilo-subagent>\"}}",
    "",
    "Allowed Kilo subagent_type values:",
    roster,
  ];
  if (originalText?.trim()) {
    lines.push("", "Original cursor-agent output:", originalText.trim().slice(0, 500));
  }
  return lines.join("\n");
}

export function rewriteCursorNativeTaskMisuse(
  text: string,
  subagents: KiloSubagentSummary[],
): string {
  if (!isCursorNativeTaskMisuse(text)) {
    return text;
  }
  return buildCursorNativeTaskRetryMessage(subagents, text);
}
