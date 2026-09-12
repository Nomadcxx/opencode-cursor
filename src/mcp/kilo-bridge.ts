/**
 * Passthrough MCP bridge: Kilo owns MCP registration and execution.
 *
 * cursor-agent emits `mcp__<server>__<tool>` (or a generic `mcp` wrapper).
 * Kilo exposes the same tools as `<server>_<tool>` (e.g. context7_resolve-library-id).
 * The proxy only maps names on the way back — no separate MCP client or reload.
 */
import { namespaceMcpToolKilo, namespaceMcpToolKiloNative } from "../kilo/platform.js";
import { namespaceMcpTool } from "./tool-bridge.js";

const KILO_NATIVE_UNDERSCORE_TOOLS = new Set([
  "list_mcp_resources",
  "read_mcp_resource",
  "list_mcp_resource_templates",
  "skill_mcp",
  "call_omo_agent",
]);

/** Underscore tools whose first segment looks like an MCP server but are Kilo/OpenViking natives. */
const KILO_NATIVE_CATALOG_SERVERS = new Set([
  "agent",
  "background",
  "kilo",
  "viking",
]);

/** Split a Kilo MCP function name into server + tool segments. */
export function splitKiloMcpToolName(name: string): { server: string; toolName: string } | null {
  // Server ids may include hyphens (`browser-harness_browser_list_tabs`).
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*_[a-zA-Z0-9_.-]+$/.test(name)) {
    return null;
  }
  if (name.startsWith("oc_") || name.startsWith("mcp__")) {
    return null;
  }
  if (KILO_NATIVE_UNDERSCORE_TOOLS.has(name.toLowerCase())) {
    return null;
  }

  const firstUnderscore = name.indexOf("_");
  const server = name.slice(0, firstUnderscore);
  const toolName = name.slice(firstUnderscore + 1);
  if (!server || !toolName) {
    return null;
  }
  return { server, toolName };
}

export function isKiloMcpToolName(name: string): boolean {
  return splitKiloMcpToolName(name) !== null;
}

/** Visible GetDynamicTools catalog: real MCP servers only, not Kilo/OpenViking natives. */
export function isKiloMcpCatalogToolName(name: string): boolean {
  const split = splitKiloMcpToolName(name);
  if (!split) {
    return false;
  }
  return !KILO_NATIVE_CATALOG_SERVERS.has(split.server.toLowerCase());
}

/** Kilo tools often missing from cursor provider chat.params — backfill via tool.list/ids. */
export const KILO_CORE_BRIDGE_TOOLS = [
  "skill",
  "skill_mcp",
  "plan",
  "question",
  "task",
  "todowrite",
  "todoread",
  "list_mcp_resources",
  "read_mcp_resource",
  "list_mcp_resource_templates",
  "call_omo_agent",
] as const;

const KILO_CORE_BRIDGE_TOOL_SET = new Set<string>(KILO_CORE_BRIDGE_TOOLS);

/** Static schemas when client.tool.list/ids omit core tools (common on cursor provider). */
export const KILO_CORE_BRIDGE_TOOL_FALLBACKS: Record<
  (typeof KILO_CORE_BRIDGE_TOOLS)[number],
  { description: string; parameters: Record<string, unknown> }
> = {
  skill: {
    description:
      "Load an Agent Skill by id. Use ids from available_skills in context; returns SKILL.md instructions.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Skill id from available_skills (e.g. superpowers/brainstorming)",
        },
      },
      required: ["name"],
    },
  },
  skill_mcp: {
    description: "Invoke an MCP tool bundled with an Agent Skill.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Skill id" },
        tool: { type: "string", description: "MCP tool name within the skill" },
        arguments: { type: "object", description: "Tool arguments" },
      },
    },
  },
  plan: {
    description: "Create or update a structured plan.",
    parameters: { type: "object", properties: {} },
  },
  question: {
    description: "Ask the user a structured question.",
    parameters: { type: "object", properties: {} },
  },
  task: {
    description: "Delegate work to a Kilo subagent.",
    parameters: { type: "object", properties: {} },
  },
  todowrite: {
    description: "Update the session todo list.",
    parameters: { type: "object", properties: {} },
  },
  todoread: {
    description: "Read the session todo list.",
    parameters: { type: "object", properties: {} },
  },
  list_mcp_resources: {
    description: "List MCP resources.",
    parameters: { type: "object", properties: {} },
  },
  read_mcp_resource: {
    description: "Read an MCP resource.",
    parameters: { type: "object", properties: {} },
  },
  list_mcp_resource_templates: {
    description: "List MCP resource templates.",
    parameters: { type: "object", properties: {} },
  },
  call_omo_agent: {
    description: "Call an OMO subagent.",
    parameters: { type: "object", properties: {} },
  },
};

/**
 * Kilo-native tools that are not MCP server_tool names (skill, plan, skill_mcp, …).
 * Used to backfill chat.params when the cursor provider omits them.
 */
export function isKiloNativeCoreToolName(name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed || trimmed.startsWith("mcp__") || trimmed.startsWith("oc_")) {
    return false;
  }
  return KILO_CORE_BRIDGE_TOOL_SET.has(trimmed.toLowerCase());
}

function coreToolFallback(
  name: string,
): (typeof KILO_CORE_BRIDGE_TOOL_FALLBACKS)[(typeof KILO_CORE_BRIDGE_TOOLS)[number]] | undefined {
  const key = name.trim().toLowerCase();
  if (!KILO_CORE_BRIDGE_TOOL_SET.has(key)) {
    return undefined;
  }
  return KILO_CORE_BRIDGE_TOOL_FALLBACKS[key as (typeof KILO_CORE_BRIDGE_TOOLS)[number]];
}

/** Fill empty list/ids schemas with the static fallback (cursor provider often omits parameters). */
export function enrichKiloCoreToolDef(def: Record<string, any> | null): Record<string, any> | null {
  const name = def?.function?.name;
  if (!def || typeof name !== "string") {
    return def;
  }
  const fallback = coreToolFallback(name);
  if (!fallback) {
    return def;
  }
  const params = def.function.parameters;
  const properties = params && typeof params === "object" ? (params as { properties?: unknown }).properties : undefined;
  const emptyParams = !properties || typeof properties !== "object" || Object.keys(properties as object).length === 0;
  const desc = typeof def.function.description === "string" ? def.function.description.trim() : "";
  const weakDesc = !desc || desc === `Kilo tool ${name}`;
  return {
    type: "function",
    function: {
      name,
      description: weakDesc ? fallback.description : desc,
      parameters: emptyParams ? fallback.parameters : params,
    },
  };
}

export function buildKiloCoreBridgeToolFallbacks(existingToolNames: Iterable<string> = []): Array<any> {
  const existing = new Set(
    [...existingToolNames]
      .filter((name) => typeof name === "string" && name.length > 0)
      .map((name) => name.toLowerCase()),
  );
  const defs: Array<any> = [];
  for (const name of KILO_CORE_BRIDGE_TOOLS) {
    if (existing.has(name)) {
      continue;
    }
    const fallback = KILO_CORE_BRIDGE_TOOL_FALLBACKS[name];
    defs.push({
      type: "function",
      function: {
        name,
        description: fallback.description,
        parameters: fallback.parameters,
      },
    });
  }
  return defs;
}

/** How Composer must load Agent Skills. `arguments.name` is required. */
export const KILO_SKILL_CALL_DYNAMIC_EXAMPLE =
  "skill({ name: \"<id-from-available_skills>\" })";

export const KILO_SKILL_CALL_DYNAMIC_FALLBACK =
  "CallDynamicTool({ namespace: \"kilo\", toolName: \"skill\", arguments: { name: \"<id-from-available_skills>\" } })";

const SKILL_ID_RESERVED = new Set([
  "skill",
  "skillmcp",
  "kilo",
  "mcp",
  "cursor",
  "getdynamictools",
  "getmcptools",
  "calldynamictool",
  "callmcptool",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isUsableSkillId(value: string | undefined): value is string {
  if (!value) {
    return false;
  }
  const key = value.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  return key.length > 0 && !SKILL_ID_RESERVED.has(key);
}

function skillIdFromRecord(record: Record<string, unknown>): string | undefined {
  const candidates = [
    record.name,
    record.skill,
    record.id,
    record.skillName,
    record.skill_name,
    record.skillId,
    record.skill_id,
    record.identifier,
    record.toolName,
    record.tool,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && isUsableSkillId(candidate)) {
      return candidate.trim();
    }
  }
  return undefined;
}

/** Map alias fields (`skill`, `toolName`, `id`) onto the native `name` argument. */
export function normalizeKiloCoreToolArgs(name: string, args: unknown): unknown {
  if (name.trim().toLowerCase() !== "skill") {
    return args;
  }
  if (typeof args === "string" && isUsableSkillId(args)) {
    return { name: args.trim() };
  }
  if (!isRecord(args)) {
    return args ?? {};
  }
  const fromName = skillIdFromRecord(args);
  if (!fromName) {
    return args;
  }
  return { ...args, name: fromName };
}

/** Lines for GetDynamicTools — core tools ride CallDynamicTool, not Cursor natives. */
export function formatKiloCoreToolsCatalogLines(
  registeredNames: Iterable<string> = [],
  query?: { namespace?: string; toolName?: string },
): string[] {
  const ns = String(query?.namespace ?? "").trim().toLowerCase();
  if (ns && ns !== "kilo" && ns !== "mcp" && ns !== "cursor") {
    return [];
  }
  const registered = new Set(
    [...registeredNames]
      .filter((name) => typeof name === "string" && isKiloNativeCoreToolName(name))
      .map((name) => name.toLowerCase()),
  );
  let names: Array<(typeof KILO_CORE_BRIDGE_TOOLS)[number]> = registered.size > 0
    ? KILO_CORE_BRIDGE_TOOLS.filter((name) => registered.has(name))
    : ["skill", "skill_mcp"];
  const toolFilter = String(query?.toolName ?? "").trim();
  if (toolFilter) {
    const want = mcpCatalogAliasKey(toolFilter);
    names = names.filter((name) => mcpCatalogAliasKey(name) === want);
  }
  if (names.length === 0) {
    return [];
  }
  return [
    "",
    "Kilo core tools — not native Cursor tools. Load them with CallDynamicTool (namespace \"kilo\"):",
    ...names.map((name) => {
      const fallback = KILO_CORE_BRIDGE_TOOL_FALLBACKS[name];
      const summary = fallback.description.split(".")[0]?.trim() ?? name;
      return `- ${name} — ${summary}`;
    }),
    `Agent Skills: ${KILO_SKILL_CALL_DYNAMIC_EXAMPLE} — the name argument is required.`,
    `Fallback if skill is not callable: ${KILO_SKILL_CALL_DYNAMIC_FALLBACK}.`,
    "Never call skill() with empty arguments. Prefer skill({ name }) over Read on SKILL.md paths.",
  ];
}

export function mcpCatalogAliasKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function normalizeToolAliasKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Prefer the name Kilo executes: no mcp__ prefix, keep hyphens (`query-docs`). */
export function pickPreferredKiloToolName(matches: string[]): string {
  const unique = [...new Set(matches.filter((name) => name.length > 0))];
  const kilo = unique.filter((name) => !name.startsWith("mcp__"));
  const pool = kilo.length > 0 ? kilo : unique;
  const hyphenated = pool.filter((name) => name.includes("-"));
  return hyphenated[0] ?? pool[0] ?? matches[0]!;
}

export function groupKiloMcpCatalogByServer(names: string[]): Map<string, string[]> {
  const grouped = new Map<string, string[]>();
  for (const name of names) {
    if (!isKiloMcpCatalogToolName(name) || name.startsWith("mcp__")) {
      continue;
    }
    const split = splitKiloMcpToolName(name);
    if (!split) {
      continue;
    }
    const list = grouped.get(split.server) ?? [];
    list.push(name);
    grouped.set(split.server, list);
  }
  return grouped;
}

function expandMcpToolNameCandidates(name: string): string[] {
  const candidates = [name];
  if (!name.startsWith("mcp__")) {
    return candidates;
  }

  const rest = name.slice("mcp__".length);
  const parts = rest.split("__");
  if (parts.length >= 2) {
    const server = parts[0]!;
    const tool = parts.slice(1).join("__");
    candidates.push(parts.join("_"));
    candidates.push(parts.join("."));
    candidates.push(namespaceMcpToolKilo(server, tool));
    candidates.push(namespaceMcpToolKiloNative(server, tool));
    candidates.push(`${server}_${tool}`);
    candidates.push(parts[parts.length - 1]!);
  }
  candidates.push(rest);
  return candidates;
}

/** Map cursor-agent MCP names back to the Kilo tool name from the request allowlist. */
export function resolveMcpToolName(name: string, allowedToolNames: Set<string>): string | null {
  const candidates = expandMcpToolNameCandidates(name);
  const candidateKeys = new Set(candidates.map(normalizeToolAliasKey));

  const matches: string[] = [];
  for (const allowed of allowedToolNames) {
    if (candidates.includes(allowed) || candidateKeys.has(normalizeToolAliasKey(allowed))) {
      matches.push(allowed);
    }
  }

  if (matches.length === 0) {
    return null;
  }
  return pickPreferredKiloToolName(matches);
}

export function extractFunctionToolNames(tools: Array<any>): string[] {
  const names: string[] = [];
  for (const tool of tools) {
    const fn = tool?.function ?? tool;
    const name = fn?.name;
    if (typeof name === "string" && name.length > 0) {
      names.push(name);
    }
  }
  return names;
}

/** Drop `mcp__*` aliases from the visible catalog; Kilo names stay as registered. */
export function stripVisibleMcpPrefixTools(tools: Array<any>): Array<any> {
  if (!Array.isArray(tools) || tools.length === 0) {
    return tools;
  }
  return tools.filter((tool) => {
    const name = (tool?.function ?? tool)?.name;
    return typeof name !== "string" || !name.startsWith("mcp__");
  });
}

/**
 * When two names differ only by hyphen/underscore, keep the Kilo-registered
 * canonical name from `preferNames` (usually `mcp.tool.list()`).
 */
export function preferCanonicalMcpNames(tools: Array<any>, preferNames: string[]): Array<any> {
  const preferredByKey = new Map<string, string>();
  for (const name of preferNames) {
    if (name.startsWith("mcp__")) {
      continue;
    }
    preferredByKey.set(normalizeToolAliasKey(name), name);
  }

  const seen = new Set<string>();
  const kept: Array<any> = [];
  for (const tool of tools) {
    const name = (tool?.function ?? tool)?.name;
    if (typeof name !== "string" || name.startsWith("mcp__")) {
      continue;
    }
    const key = normalizeToolAliasKey(name);
    const preferred = preferredByKey.get(key);
    if (preferred && name !== preferred) {
      continue;
    }
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    kept.push(tool);
  }
  return kept;
}

/** @deprecated Visible mcp__ aliases are no longer injected. Keep as identity for callers. */
export function enrichKiloToolsWithMcpAliases(tools: Array<any>): Array<any> {
  return stripVisibleMcpPrefixTools(tools);
}

/** Allowlist for interception: Kilo names plus hidden mcp__ aliases for remapping. */
export function buildProxyAllowedToolNames(tools: Array<any>): Set<string> {
  const names = new Set(extractFunctionToolNames(tools));
  names.add("GetDynamicTools");

  for (const name of [...names]) {
    const split = splitKiloMcpToolName(name);
    if (split) {
      names.add(namespaceMcpTool(split.server, split.toolName));
      names.add(namespaceMcpToolKilo(split.server, split.toolName));
      names.add(namespaceMcpToolKiloNative(split.server, split.toolName));
    }
  }

  return names;
}

export function isCursorMcpMetaTool(rawName: string): boolean {
  let key = rawName.toLowerCase().replace(/[_-]/g, "");
  if (key.endsWith("toolcall")) {
    key = key.slice(0, -"toolcall".length);
  }
  if (key.endsWith("tool") && key !== "mcp") {
    key = key.slice(0, -"tool".length);
  }
  return key === "mcp" || key === "callmcp";
}

export function remapBareMcpToolCall(
  args: unknown,
  allowedToolNames: Set<string>,
): { name: string; args: unknown } | null {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return null;
  }

  const record = args as Record<string, unknown>;
  const provider = record.providerIdentifier ?? record.server;
  const toolName = record.toolName ?? record.name;
  if (typeof provider !== "string" || typeof toolName !== "string") {
    return null;
  }

  const virtualName = namespaceMcpTool(provider, toolName);
  const resolved = resolveMcpToolName(virtualName, allowedToolNames);
  if (!resolved) {
    return null;
  }

  return {
    name: resolved,
    args: record.args ?? record.arguments ?? {},
  };
}

export function mergeToolDefinitionsByName(base: Array<any>, extra: Array<any>): Array<any> {
  const merged = Array.isArray(base) ? [...base] : [];
  const names = new Set(extractFunctionToolNames(merged));

  for (const tool of extra) {
    const name = tool?.function?.name;
    if (typeof name === "string" && name.length > 0 && !names.has(name)) {
      names.add(name);
      merged.push(tool);
    }
  }

  return merged;
}

/** Normalize Kilo MCP list payloads (`data.tools`, `data`, or a raw array). */
export function unwrapKiloToolListPayload(raw: unknown): unknown[] {
  if (Array.isArray(raw)) {
    return raw;
  }
  if (!raw || typeof raw !== "object") {
    return [];
  }
  const rec = raw as Record<string, unknown>;
  if (Array.isArray(rec.tools)) {
    return rec.tools;
  }
  if (Array.isArray(rec.data)) {
    return rec.data;
  }
  if (rec.data && typeof rec.data === "object") {
    const nested = rec.data as Record<string, unknown>;
    if (Array.isArray(nested.tools)) {
      return nested.tools;
    }
    if (Array.isArray(nested.ids)) {
      return nested.ids;
    }
  }
  if (Array.isArray(rec.ids)) {
    return rec.ids;
  }
  return [];
}

/** Convert a Kilo tool id/record into an OpenAI function def for the MCP catalog. */
export function kiloMcpToolRecordToDef(tool: unknown): Record<string, any> | null {
  if (typeof tool === "string") {
    return nameToMcpFunctionDef(tool);
  }
  if (!tool || typeof tool !== "object") {
    return null;
  }
  const rec = tool as Record<string, unknown>;
  const rawName = String(rec.name ?? rec.id ?? "").trim();
  const server = String(rec.server ?? rec.serverName ?? rec.provider ?? "").trim();
  let name = rawName;
  if (server && rawName) {
    const split = splitKiloMcpToolName(rawName);
    const alreadyPrefixed = Boolean(
      split && mcpCatalogAliasKey(split.server) === mcpCatalogAliasKey(server),
    );
    if (!alreadyPrefixed) {
      name = namespaceMcpToolKiloNative(server, rawName);
    }
  }
  return nameToMcpFunctionDef(
    name,
    String(rec.description ?? ""),
    rec.parameters ?? rec.inputSchema,
  );
}

function nameToCoreFunctionDef(
  name: string,
  description = "",
  parameters?: unknown,
): Record<string, any> | null {
  const trimmed = name.trim();
  if (!trimmed || !isKiloNativeCoreToolName(trimmed)) {
    return null;
  }
  return {
    type: "function",
    function: {
      name: trimmed,
      description: description.trim() || `Kilo tool ${trimmed}`,
      parameters: parameters && typeof parameters === "object"
        ? parameters
        : { type: "object", properties: {} },
    },
  };
}

/** Convert a Kilo tool id/record into an OpenAI function def for native core tools. */
export function kiloCoreToolRecordToDef(tool: unknown): Record<string, any> | null {
  if (typeof tool === "string") {
    return nameToCoreFunctionDef(tool);
  }
  if (!tool || typeof tool !== "object") {
    return null;
  }
  const rec = tool as Record<string, unknown>;
  const name = String(rec.name ?? rec.id ?? "").trim();
  return nameToCoreFunctionDef(
    name,
    String(rec.description ?? ""),
    rec.parameters ?? rec.inputSchema,
  );
}

function nameToMcpFunctionDef(
  name: string,
  description = "",
  parameters?: unknown,
): Record<string, any> | null {
  const trimmed = name.trim();
  if (!trimmed || trimmed.startsWith("mcp__") || !isKiloMcpCatalogToolName(trimmed)) {
    return null;
  }
  return {
    type: "function",
    function: {
      name: trimmed,
      description: description.trim() || `Kilo MCP tool ${trimmed}`,
      parameters: parameters && typeof parameters === "object"
        ? parameters
        : { type: "object", properties: {} },
    },
  };
}

async function callClientList(fn: unknown): Promise<unknown> {
  if (typeof fn !== "function") {
    return null;
  }
  try {
    return await fn({ query: {} });
  } catch {
    try {
      return await fn();
    } catch {
      return null;
    }
  }
}

/**
 * Pull native Kilo core tool defs (skill, skill_mcp, plan, …) that the cursor
 * provider may omit from chat.params even when `<available_skills>` is injected.
 */
export async function discoverKiloNativeCoreToolDefs(
  client: any,
  existingToolNames: Iterable<string> = [],
): Promise<Array<any>> {
  const collected: Array<any> = [];
  const seen = new Set<string>();

  const ingest = (raw: unknown) => {
    for (const item of unwrapKiloToolListPayload(raw)) {
      const def = kiloCoreToolRecordToDef(item);
      const name = def?.function?.name;
      if (!def || typeof name !== "string" || seen.has(name)) {
        continue;
      }
      seen.add(name);
      collected.push(enrichKiloCoreToolDef(def) ?? def);
    }
  };

  ingest(await callClientList(client?.tool?.list));
  ingest(await callClientList(client?.tool?.ids));

  const mergedNames = new Set([
    ...existingToolNames,
    ...collected.map((tool) => tool?.function?.name).filter((name): name is string => typeof name === "string"),
  ]);
  for (const fallback of buildKiloCoreBridgeToolFallbacks(mergedNames)) {
    const name = fallback?.function?.name;
    if (typeof name !== "string" || seen.has(name)) {
      continue;
    }
    seen.add(name);
    collected.push(fallback);
  }

  return collected;
}

/**
 * Pull native Kilo MCP tool defs (context7_*, openviking_*, browser-harness_*).
 *
 * `client.mcp.tool.list()` is not on the public Kilo SDK. Dynamically registered
 * plugin/MCP tools (OpenViking, browser-harness) are listed by `client.tool.ids()`.
 */
export async function discoverKiloNativeMcpToolDefs(client: any): Promise<Array<any>> {
  const collected: Array<any> = [];
  const seen = new Set<string>();

  const ingest = (raw: unknown) => {
    for (const item of unwrapKiloToolListPayload(raw)) {
      const def = kiloMcpToolRecordToDef(item);
      const name = def?.function?.name;
      if (!def || typeof name !== "string" || seen.has(name)) {
        continue;
      }
      seen.add(name);
      collected.push(def);
    }
  };

  ingest(await callClientList(client?.mcp?.tool?.list));
  ingest(await callClientList(client?.tool?.ids));

  return collected;
}

export function buildKiloMcpAliasHint(toolNames: string[]): string | null {
  const mcpNames = [...new Set(
    toolNames.filter((name) => isKiloMcpCatalogToolName(name) && !name.startsWith("mcp__")),
  )].sort();

  if (mcpNames.length === 0) {
    return null;
  }

  const grouped = groupKiloMcpCatalogByServer(mcpNames);
  const namespaceLines = [...grouped.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([server, names]) => `  - ${server}: ${names.join(", ")}`);

  return [
    "Available dynamic tool namespaces (Kilo MCP — not only namespace \"cursor\"):",
    ...namespaceLines,
    "GetDynamicTools() with no arguments lists these namespaces. Invoke each tool by its exact Kilo name — no mcp__ prefix.",
    "CallDynamicTool { namespace: \"<server>\", toolName, arguments } remaps to that Kilo name.",
    "Namespace \"cursor\" is only CreateGoal, GenerateImage, UpdateGoal.",
  ].join("\n");
}

export function isCursorNativeMcpDiscoveryTool(name: string): boolean {
  const key = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  return key === "getmcptools" || key === "callmcptool" || key === "mcptoolcall";
}
