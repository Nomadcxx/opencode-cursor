import { tool } from "@kilocode/plugin/tool";
import {
  discoverKiloNativeMcpToolDefs,
  groupKiloMcpCatalogByServer,
  isKiloMcpCatalogToolName,
  isKiloNativeCoreToolName,
  isUsableSkillId,
  mcpCatalogAliasKey,
  normalizeKiloCoreToolArgs,
  pickPreferredKiloToolName,
  resolveMcpToolName,
  splitKiloMcpToolName,
  formatKiloCoreToolsCatalogLines,
} from "./kilo-bridge.js";
import { namespaceMcpToolKilo, namespaceMcpToolKiloNative } from "../kilo/platform.js";

export type McpCatalogEntry = {
  name: string;
  description: string;
};

export type DynamicCatalogQuery = {
  namespace?: string;
  toolName?: string;
  pattern?: string;
};

const CURSOR_DYNAMIC_TOOLS = ["CreateGoal", "GenerateImage", "UpdateGoal"] as const;

let rememberedCatalog: McpCatalogEntry[] = [];
let rememberedMcpServers: string[] = [];
let rememberedCoreTools: string[] = [];

export const GET_DYNAMIC_TOOLS_NAME = "GetDynamicTools";

export function getRememberedMcpCatalog(): McpCatalogEntry[] {
  return rememberedCatalog;
}

export function getRememberedMcpServers(): string[] {
  return rememberedMcpServers;
}

export function resetRememberedMcpCatalog(): void {
  rememberedCatalog = [];
  rememberedMcpServers = [];
  rememberedCoreTools = [];
}

export function getRememberedCoreTools(): string[] {
  return rememberedCoreTools;
}

/** Track Kilo core bridge tools (skill, skill_mcp, …) for GetDynamicTools listing. */
export function rememberCoreToolsFromTools(tools: unknown): string[] {
  if (!Array.isArray(tools)) {
    return rememberedCoreTools;
  }
  const next = new Set(rememberedCoreTools);
  for (const toolDef of tools) {
    const fn = (toolDef as any)?.function ?? toolDef;
    const name = fn?.name;
    if (typeof name === "string" && isKiloNativeCoreToolName(name)) {
      next.add(name);
    }
  }
  rememberedCoreTools = [...next].sort((a, b) => a.localeCompare(b));
  return rememberedCoreTools;
}

export function rememberMcpServers(names: Iterable<string>): string[] {
  const byKey = new Map(rememberedMcpServers.map((name) => [mcpCatalogAliasKey(name), name]));
  for (const name of names) {
    const trimmed = String(name ?? "").trim();
    if (!trimmed || trimmed.toLowerCase() === "cursor") {
      continue;
    }
    byKey.set(mcpCatalogAliasKey(trimmed), trimmed);
  }
  rememberedMcpServers = [...byKey.values()].sort((a, b) => a.localeCompare(b));
  return rememberedMcpServers;
}

export function mcpServerIsRemembered(server: string): boolean {
  const key = mcpCatalogAliasKey(server);
  return rememberedMcpServers.some((name) => mcpCatalogAliasKey(name) === key);
}

function preferCanonicalCatalogEntry(
  current: McpCatalogEntry | undefined,
  next: McpCatalogEntry,
): McpCatalogEntry {
  if (!current) {
    return next;
  }
  const preferredName = pickPreferredKiloToolName([current.name, next.name]);
  const chosen = preferredName === next.name ? next : current;
  const other = chosen === next ? current : next;
  return {
    name: chosen.name,
    description: chosen.description || other.description,
  };
}

function upsertCatalogEntry(
  byKey: Map<string, McpCatalogEntry>,
  entry: McpCatalogEntry,
): void {
  const key = mcpCatalogAliasKey(entry.name);
  byKey.set(key, preferCanonicalCatalogEntry(byKey.get(key), entry));
}

function sortCatalogEntries(entries: Iterable<McpCatalogEntry>): McpCatalogEntry[] {
  return [...entries].sort((a, b) => a.name.localeCompare(b.name));
}

/** Cache Kilo MCP names seen on the wire (proxy/chat.params), not only mcp.tool.list(). */
export function rememberMcpCatalogFromTools(tools: unknown): McpCatalogEntry[] {
  const next: McpCatalogEntry[] = [];
  const seen = new Set<string>();
  const list = Array.isArray(tools) ? tools : [];

  for (const toolDef of list) {
    const fn = (toolDef as any)?.function ?? toolDef;
    const name = fn?.name;
    if (typeof name !== "string" || name.startsWith("mcp__")) {
      continue;
    }
    if (isGetDynamicToolsName(name) || isCallDynamicToolName(name)) {
      continue;
    }
    if (!isKiloMcpCatalogToolName(name)) {
      continue;
    }
    if (seen.has(name)) {
      continue;
    }
    seen.add(name);
    next.push({
      name,
      description: String(fn?.description ?? "").trim(),
    });
  }

  if (next.length === 0) {
    return rememberedCatalog;
  }

  const byKey = new Map(rememberedCatalog.map((entry) => [mcpCatalogAliasKey(entry.name), entry]));
  for (const entry of next) {
    upsertCatalogEntry(byKey, entry);
  }
  rememberedCatalog = sortCatalogEntries(byKey.values());
  return rememberedCatalog;
}

export type ParsedDynamicToolArgs = {
  namespace?: string;
  toolName?: string;
  innerArgs: unknown;
};

export function getDynamicToolsDefinition(): Record<string, unknown> {
  return {
    type: "function",
    function: {
      name: GET_DYNAMIC_TOOLS_NAME,
      description:
        "List Kilo MCP dynamic namespaces and tools (openviking, context7, browser-harness, …). "
        + "Also lists Kilo core tools (skill, skill_mcp) — load those with CallDynamicTool "
        + "{ namespace: \"kilo\", toolName: \"skill\", arguments: { name } }. "
        + "No arguments lists every namespace — not only \"cursor\". "
        + "Pass namespace to inspect one server. Invoke MCP tools by their exact Kilo names "
        + "(e.g. openviking_health, context7_query-docs, browser-harness_browser_list_tabs).",
      parameters: {
        type: "object",
        properties: {
          namespace: {
            type: "string",
            description: "MCP server id, \"kilo\" for all Kilo MCP tools, or \"cursor\" for native Cursor tools. Omit to list all namespaces.",
          },
          toolName: {
            type: "string",
            description: "Optional tool within that namespace",
          },
          pattern: {
            type: "string",
            description: "Optional regex over namespace and tool names",
          },
        },
      },
    },
  };
}

export function isGetDynamicToolsName(name: string): boolean {
  const key = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  return key === "getdynamictools" || key === "getmcptools";
}

export function isCallDynamicToolName(name: string): boolean {
  const key = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  return key === "calldynamictool" || key === "callmcptool" || key === "mcptoolcall";
}

export function parseCallDynamicToolArgs(args: unknown): ParsedDynamicToolArgs | null {
  let parsedArgs = args;
  if (typeof parsedArgs === "string") {
    try {
      parsedArgs = JSON.parse(parsedArgs);
    } catch {
      return null;
    }
  }
  if (!parsedArgs || typeof parsedArgs !== "object" || Array.isArray(parsedArgs)) {
    return null;
  }
  const record = parsedArgs as Record<string, unknown>;
  const namespace = pickString(record.namespace, record.providerIdentifier, record.server);
  const toolName = pickString(record.toolName, record.name, record.tool);
  let innerArgs: unknown = record.arguments ?? record.args ?? record.input ?? {};
  if (typeof innerArgs === "string") {
    try {
      const parsedInner = JSON.parse(innerArgs);
      if (parsedInner && typeof parsedInner === "object") {
        innerArgs = parsedInner;
      }
    } catch {
      // Keep the raw string; the Kilo tool can still parse it.
    }
  }
  if (!namespace && !toolName) {
    return null;
  }
  return { namespace, toolName, innerArgs };
}

export function shouldPassthroughCursorDynamicTool(args: unknown): boolean {
  const parsed = parseCallDynamicToolArgs(args);
  if (!parsed) {
    return false;
  }
  if (parsed.namespace?.toLowerCase() === "cursor") {
    return true;
  }
  const key = (parsed.toolName ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return key === "creategoal" || key === "generateimage" || key === "updategoal";
}

function constructKiloNameFromDynamicArgs(parsed: ParsedDynamicToolArgs): string | null {
  if (!parsed.toolName) {
    return null;
  }
  const ns = parsed.namespace?.trim();
  const nsKey = ns?.toLowerCase();
  if (nsKey === "cursor") {
    return null;
  }
  if (!ns || nsKey === "kilo" || nsKey === "mcp") {
    return parsed.toolName;
  }
  if (isKiloMcpCatalogToolName(parsed.toolName)) {
    const split = splitKiloMcpToolName(parsed.toolName);
    if (split && mcpCatalogAliasKey(split.server) === mcpCatalogAliasKey(ns)) {
      return parsed.toolName;
    }
  }
  return `${ns}_${parsed.toolName}`;
}

function skillArgsFromDynamicCall(parsed: ParsedDynamicToolArgs, raw: unknown): unknown {
  const inner = parsed.innerArgs;
  const merged: Record<string, unknown> =
    inner && typeof inner === "object" && !Array.isArray(inner)
      ? { ...(inner as Record<string, unknown>) }
      : typeof inner === "string" && inner.trim()
        ? { name: inner.trim() }
        : {};
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const record = raw as Record<string, unknown>;
    for (const key of [
      "name",
      "skill",
      "id",
      "skillName",
      "skill_name",
      "skillId",
      "skill_id",
      "identifier",
    ]) {
      if (merged[key] === undefined && record[key] !== undefined) {
        merged[key] = record[key];
      }
    }
  }
  if (
    isUsableSkillId(parsed.toolName)
    && !isKiloMcpCatalogToolName(parsed.toolName)
    && !isUsableSkillId(typeof merged.name === "string" ? merged.name : undefined)
  ) {
    merged.name = parsed.toolName;
  }
  return normalizeKiloCoreToolArgs("skill", merged);
}

export function resolveCallDynamicToolToKiloName(
  args: unknown,
  allowedToolNames: Set<string>,
): { name: string; args: unknown } | null {
  if (shouldPassthroughCursorDynamicTool(args)) {
    return null;
  }
  const parsed = parseCallDynamicToolArgs(args);
  if (!parsed?.toolName) {
    return null;
  }

  const nsKey = parsed.namespace?.trim().toLowerCase() ?? "";
  const skillArgs = skillArgsFromDynamicCall(parsed, args);
  if (nsKey === "skill" && !isKiloNativeCoreToolName(parsed.toolName)) {
    return { name: "skill", args: skillArgs };
  }
  if (
    isKiloNativeCoreToolName(parsed.toolName)
    && (!nsKey || nsKey === "kilo" || nsKey === "mcp")
  ) {
    const coreName = parsed.toolName.toLowerCase();
    if (coreName === "skill") {
      return { name: "skill", args: skillArgs };
    }
    return {
      name: coreName,
      args: normalizeKiloCoreToolArgs(coreName, parsed.innerArgs),
    };
  }
  if (
    (nsKey === "kilo" || nsKey === "skill")
    && isUsableSkillId(parsed.toolName)
    && !isKiloMcpCatalogToolName(parsed.toolName)
  ) {
    return { name: "skill", args: skillArgs };
  }

  const candidates = [parsed.toolName];
  if (parsed.namespace) {
    candidates.push(namespaceMcpToolKiloNative(parsed.namespace, parsed.toolName));
    candidates.push(namespaceMcpToolKilo(parsed.namespace, parsed.toolName));
    candidates.push(`${parsed.namespace}_${parsed.toolName}`);
  }
  const constructed = constructKiloNameFromDynamicArgs(parsed);
  if (constructed) {
    candidates.push(constructed);
  }

  for (const candidate of candidates) {
    const resolved = resolveMcpToolName(candidate, allowedToolNames);
    if (resolved && !resolved.startsWith("mcp__")) {
      return { name: resolved, args: parsed.innerArgs };
    }
    if (allowedToolNames.has(candidate) && !candidate.startsWith("mcp__")) {
      return { name: candidate, args: parsed.innerArgs };
    }
  }

  const lookupName = constructed ?? parsed.toolName;
  const rememberedMatch = rememberedCatalog.find(
    (entry) => mcpCatalogAliasKey(entry.name) === mcpCatalogAliasKey(lookupName),
  );
  if (rememberedMatch) {
    return { name: rememberedMatch.name, args: parsed.innerArgs };
  }

  if (lookupName) {
    return {
      name: lookupName,
      args: isKiloNativeCoreToolName(lookupName)
        ? normalizeKiloCoreToolArgs(lookupName, parsed.innerArgs)
        : parsed.innerArgs,
    };
  }

  return null;
}

function matchesPattern(value: string, pattern: string): boolean {
  const raw = pattern.trim();
  if (!raw) {
    return true;
  }
  try {
    return new RegExp(raw, "i").test(value);
  } catch {
    return value.toLowerCase().includes(raw.toLowerCase());
  }
}

function parseCatalogQuery(
  namespaceOrQuery?: string | DynamicCatalogQuery,
): DynamicCatalogQuery {
  if (typeof namespaceOrQuery === "string" || namespaceOrQuery === undefined) {
    return { namespace: namespaceOrQuery };
  }
  return namespaceOrQuery;
}

function formatToolLine(entry: McpCatalogEntry): string {
  return entry.description ? `- ${entry.name} — ${entry.description}` : `- ${entry.name}`;
}

function formatCursorNamespaceBody(): string[] {
  return [
    "Namespace: cursor (native Cursor dynamic tools — not Kilo MCP)",
    ...CURSOR_DYNAMIC_TOOLS.map((name) => `- ${name}`),
    "Call these with CallDynamicTool { namespace: \"cursor\", toolName, arguments }.",
  ];
}

async function collectCatalogEntries(client: any): Promise<McpCatalogEntry[]> {
  const listed = await discoverKiloNativeMcpToolDefs(client);
  const byKey = new Map<string, McpCatalogEntry>();
  for (const entry of rememberedCatalog) {
    upsertCatalogEntry(byKey, entry);
  }
  for (const toolDef of listed) {
    const fn = toolDef?.function ?? toolDef;
    const name = String(fn?.name ?? "").trim();
    if (!name || name.startsWith("mcp__") || !isKiloMcpCatalogToolName(name)) {
      continue;
    }
    upsertCatalogEntry(byKey, {
      name,
      description: String(fn?.description ?? "").trim(),
    });
  }
  rememberedCatalog = sortCatalogEntries(byKey.values());
  return rememberedCatalog;
}

function filterCatalog(
  tools: McpCatalogEntry[],
  query: DynamicCatalogQuery,
): McpCatalogEntry[] {
  const ns = String(query.namespace ?? "").trim();
  const nsKey = ns.toLowerCase();
  const toolFilter = String(query.toolName ?? "").trim();
  const pattern = String(query.pattern ?? "").trim();

  return tools.filter((entry) => {
    const split = splitKiloMcpToolName(entry.name);
    if (ns && nsKey !== "kilo" && nsKey !== "mcp") {
      if (!split || mcpCatalogAliasKey(split.server) !== mcpCatalogAliasKey(ns)) {
        return false;
      }
    }
    if (toolFilter) {
      const namesToMatch = [entry.name, split?.toolName ?? ""];
      const want = mcpCatalogAliasKey(toolFilter);
      if (!namesToMatch.some((name) => mcpCatalogAliasKey(name) === want)) {
        return false;
      }
    }
    if (pattern) {
      const haystack = `${split?.server ?? ""} ${entry.name} ${entry.description}`;
      if (!matchesPattern(haystack, pattern)) {
        return false;
      }
    }
    return true;
  });
}

export async function formatKiloMcpDynamicCatalog(
  client: any,
  namespaceOrQuery?: string | DynamicCatalogQuery,
): Promise<string> {
  const query = parseCatalogQuery(namespaceOrQuery);
  const ns = String(query.namespace ?? "").trim().toLowerCase();
  const tools = await collectCatalogEntries(client);
  const grouped = groupKiloMcpCatalogByServer(tools.map((entry) => entry.name));
  rememberMcpServers(grouped.keys());
  rememberMcpServers(rememberedMcpServers);
  const otherNamespaces = [...new Set([...grouped.keys(), ...rememberedMcpServers])]
    .sort((a, b) => a.localeCompare(b));

  if (ns === "cursor") {
    const extra = otherNamespaces.length > 0
      ? [
          "",
          `Other namespaces (Kilo MCP, not listed above): ${otherNamespaces.join(", ")}.`,
          "Call GetDynamicTools() with no arguments or GetDynamicTools({ namespace: \"<server>\" }) for those tools.",
          "Namespace \"cursor\" is not the full catalog.",
        ]
      : [
          "",
          "Kilo MCP namespaces (context7, openviking, browser-harness, …) are registered separately.",
          "Call GetDynamicTools() with no arguments to list them. Namespace \"cursor\" is not the full catalog.",
        ];
    return [
      ...formatCursorNamespaceBody(),
      ...extra,
      ...formatKiloCoreToolsCatalogLines(getRememberedCoreTools(), query),
    ].join("\n");
  }

  const filtered = filterCatalog(tools, query);
  const coreLines = formatKiloCoreToolsCatalogLines(getRememberedCoreTools(), query);
  if (filtered.length === 0) {
    if (coreLines.length > 0 && (!ns || ns === "kilo" || ns === "mcp")) {
      return [
        "Namespace: kilo (Kilo core tools — not MCP, not native Cursor tools).",
        ...coreLines.filter((line) => line.length > 0),
      ].join("\n");
    }
    if (ns && ns !== "kilo" && ns !== "mcp") {
      const known = otherNamespaces.length > 0
        ? `Known Kilo MCP namespaces: ${otherNamespaces.join(", ")}.`
        : "No Kilo MCP tools are registered yet.";
      return [
        `No Kilo MCP tools matched namespace "${query.namespace}".`,
        known,
        "Invoke MCP tools by their exact Kilo names (e.g. openviking_health). Do not use mcp__ prefixes.",
      ].join("\n");
    }
    if (otherNamespaces.length > 0) {
      return [
        "Available dynamic tool namespaces:",
        `- cursor: ${CURSOR_DYNAMIC_TOOLS.join(", ")} (native Cursor; CallDynamicTool { namespace: \"cursor\" })`,
        `- kilo: skill, skill_mcp (CallDynamicTool { namespace: \"kilo\", toolName: \"skill\", arguments: { name } })`,
        ...otherNamespaces.map((server) => (
          `- ${server}: invoke as ${server}_<tool> (CallDynamicTool { namespace: "${server}", toolName, arguments })`
        )),
        "",
        "Kilo MCP tool schemas are still loading; invoke by the exact Kilo name anyway.",
        "Namespace \"cursor\" is not the full catalog.",
        ...coreLines,
      ].join("\n");
    }
    return [
      "No Kilo MCP tools are registered yet.",
      ...formatCursorNamespaceBody(),
      ...coreLines,
    ].join("\n");
  }

  if (!ns || ns === "kilo" || ns === "mcp") {
    const namespaceLines = otherNamespaces.map((server) => {
      const names = grouped.get(server) ?? [];
      return names.length > 0
        ? `- ${server} (${names.length}): ${names.join(", ")}`
        : `- ${server}: invoke as ${server}_<tool> (CallDynamicTool { namespace: "${server}", toolName, arguments })`;
    });
    const toolLines = filtered.map(formatToolLine);
    return [
      "Available dynamic tool namespaces:",
      `- cursor: ${CURSOR_DYNAMIC_TOOLS.join(", ")} (native Cursor; CallDynamicTool { namespace: \"cursor\" })`,
      `- kilo: skill, skill_mcp (CallDynamicTool { namespace: \"kilo\", toolName: \"skill\", arguments: { name } })`,
      ...namespaceLines,
      "",
      "Kilo MCP tools — invoke by these exact Kilo names (no mcp__ prefix):",
      ...toolLines,
      ...coreLines,
      "",
      "GetDynamicTools({ namespace: \"<server>\" }) lists one namespace.",
      "CallDynamicTool({ namespace: \"<server>\", toolName, arguments }) remaps to <server>_<tool>.",
      "CallDynamicTool({ namespace: \"kilo\", toolName: \"skill\", arguments: { name } }) loads an Agent Skill.",
      "Namespace \"cursor\" is not the full catalog.",
    ].join("\n");
  }

  return [
    `Namespace: ${query.namespace} (Kilo MCP — invoke by these exact names, no mcp__ prefix):`,
    ...filtered.map(formatToolLine),
    "",
    `CallDynamicTool { namespace: "${query.namespace}", toolName, arguments } remaps to the Kilo name.`,
  ].join("\n");
}

export function buildKiloMcpDiscoveryToolEntries(client: any): Record<string, any> {
  const z = tool.schema;
  return {
    [GET_DYNAMIC_TOOLS_NAME]: tool({
      description:
        "List Kilo MCP dynamic namespaces and tools (openviking, context7, browser-harness, …). "
        + "No arguments lists every namespace — not only \"cursor\". "
        + "Namespace \"kilo\" lists Agent Skills (skill / skill_mcp) for CallDynamicTool.",
      args: {
        namespace: z.string().optional().describe("MCP server id | kilo | cursor"),
        toolName: z.string().optional().describe("Optional tool within that namespace"),
        pattern: z.string().optional().describe("Optional regex over namespace and tool names"),
      },
      async execute(args: any) {
        return formatKiloMcpDynamicCatalog(client, {
          namespace: args?.namespace,
          toolName: args?.toolName,
          pattern: args?.pattern,
        });
      },
    }),
  };
}

function pickString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}
