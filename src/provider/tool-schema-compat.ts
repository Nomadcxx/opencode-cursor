import type { OpenAiToolCall } from "../proxy/tool-loop.js";

type JsonRecord = Record<string, unknown>;

const EDIT_COMPAT_REPAIR_ENABLED = process.env.CURSOR_ACP_EDIT_COMPAT_REPAIR !== "false";

const ARG_KEY_ALIASES = new Map<string, string>([
  ["filepath", "path"],
  ["filename", "path"],
  ["file", "path"],
  ["directory", "path"],
  ["targetdirectory", "path"],
  ["targetfile", "path"],
  ["globpattern", "pattern"],
  ["searchpattern", "pattern"],
  ["includepattern", "include"],
  ["cmd", "command"],
  ["contents", "content"],
  ["text", "content"],
  ["streamcontent", "content"],
  ["oldstring", "old_string"],
  ["newstring", "new_string"],
]);

export interface ToolSchemaValidationResult {
  hasSchema: boolean;
  ok: boolean;
  missing: string[];
  unexpected: string[];
  typeErrors: string[];
  repairHint?: string;
}

export interface ToolSchemaCompatResult {
  toolCall: OpenAiToolCall;
  normalizedArgs: JsonRecord;
  originalArgKeys: string[];
  normalizedArgKeys: string[];
  collisionKeys: string[];
  validation: ToolSchemaValidationResult;
}

export function buildToolSchemaMap(tools: Array<unknown>): Map<string, unknown> {
  const schemas = new Map<string, unknown>();
  for (const rawTool of tools) {
    const tool = isRecord(rawTool) ? rawTool : null;
    if (!tool) {
      continue;
    }
    const fn = isRecord(tool.function) ? tool.function : tool;
    const name = typeof fn.name === "string" ? fn.name.trim() : "";
    if (!name) {
      continue;
    }
    if (fn.parameters !== undefined) {
      schemas.set(name, fn.parameters);
    }
  }
  return schemas;
}

export function applyToolSchemaCompat(
  toolCall: OpenAiToolCall,
  toolSchemaMap: Map<string, unknown>,
): ToolSchemaCompatResult {
  const parsedArgs = parseArguments(toolCall.function.arguments);
  const originalArgKeys = Object.keys(parsedArgs);
  const { normalizedArgs, collisionKeys } = normalizeArgumentKeys(parsedArgs);
  const toolSpecificArgs = normalizeToolSpecificArgs(toolCall.function.name, normalizedArgs);
  const schema = toolSchemaMap.get(toolCall.function.name);
  const sanitization = sanitizeArgumentsForSchema(toolSpecificArgs, schema);
  const validation = validateToolArguments(
    toolCall.function.name,
    sanitization.args,
    schema,
    sanitization.unexpected,
  );

  const normalizedToolCall: OpenAiToolCall = {
    ...toolCall,
    function: {
      ...toolCall.function,
      arguments: JSON.stringify(sanitization.args),
    },
  };

  return {
    toolCall: normalizedToolCall,
    normalizedArgs: sanitization.args,
    originalArgKeys,
    normalizedArgKeys: Object.keys(sanitization.args),
    collisionKeys,
    validation,
  };
}

function parseArguments(rawArguments: string): JsonRecord {
  try {
    const parsed = JSON.parse(rawArguments);
    if (isRecord(parsed)) {
      return parsed;
    }
    return { value: parsed };
  } catch {
    return { value: rawArguments };
  }
}

function normalizeArgumentKeys(args: JsonRecord): {
  normalizedArgs: JsonRecord;
  collisionKeys: string[];
} {
  const normalizedArgs: JsonRecord = { ...args };
  const collisionKeys: string[] = [];

  for (const [rawKey, rawValue] of Object.entries(args)) {
    const canonicalKey = resolveCanonicalArgKey(rawKey);
    if (!canonicalKey || canonicalKey === rawKey) {
      continue;
    }

    const canonicalInOriginal = hasOwn(args, canonicalKey);
    const canonicalInNormalized = hasOwn(normalizedArgs, canonicalKey);
    if (canonicalInOriginal || canonicalInNormalized) {
      collisionKeys.push(rawKey);
      delete normalizedArgs[rawKey];
      continue;
    }

    normalizedArgs[canonicalKey] = rawValue;
    delete normalizedArgs[rawKey];
  }

  return { normalizedArgs, collisionKeys };
}

function resolveCanonicalArgKey(rawKey: string): string | null {
  const token = rawKey.toLowerCase().replace(/[^a-z0-9]/g, "");
  return ARG_KEY_ALIASES.get(token) ?? null;
}

function normalizeToolSpecificArgs(toolName: string, args: JsonRecord): JsonRecord {
  const normalizedToolName = toolName.toLowerCase();
  if (normalizedToolName === "todowrite") {
    if (!Array.isArray(args.todos)) {
      return args;
    }

    const todos = args.todos.map((entry) => {
      if (!isRecord(entry)) {
        return entry;
      }

      const todo: JsonRecord = { ...entry };
      if (typeof todo.status === "string") {
        todo.status = normalizeTodoStatus(todo.status);
      }
      if (
        todo.priority === undefined
        || todo.priority === null
        || (typeof todo.priority === "string" && todo.priority.trim().length === 0)
      ) {
        todo.priority = "medium";
      }
      return todo;
    });

    return {
      ...args,
      todos,
    };
  }

  if (normalizedToolName !== "edit" || !EDIT_COMPAT_REPAIR_ENABLED) {
    return args;
  }

  const repaired: JsonRecord = { ...args };
  const hasStringNew = typeof repaired.new_string === "string";
  const hasStringOld = typeof repaired.old_string === "string";

  // Coerce non-string content/streamContent into a string before repair.
  // Models frequently emit array-of-chunks (streamContent) or object payloads.
  if (repaired.content !== undefined && typeof repaired.content !== "string") {
    const coerced = coerceToString(repaired.content);
    if (coerced !== null) {
      repaired.content = coerced;
    }
  }

  const content = repaired.content;

  // Guarded compatibility repair for models that send full-content edit payloads.
  if (!hasStringNew && typeof content === "string") {
    repaired.new_string = content;
  }
  if (typeof repaired.new_string === "string" && !hasStringOld) {
    repaired.old_string = "";
  }

  return repaired;
}

function normalizeTodoStatus(status: string): string {
  const normalized = status.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (normalized === "todo" || normalized === "pending") {
    return "pending";
  }
  if (normalized === "inprogress" || normalized === "in_progress") {
    return "in_progress";
  }
  if (normalized === "done" || normalized === "complete" || normalized === "completed") {
    return "completed";
  }
  return status;
}

function sanitizeArgumentsForSchema(
  args: JsonRecord,
  schema: unknown,
): { args: JsonRecord; unexpected: string[] } {
  if (!isRecord(schema)) {
    return { args, unexpected: [] };
  }

  if (schema.additionalProperties !== false) {
    return { args, unexpected: [] };
  }

  const properties = isRecord(schema.properties) ? schema.properties : {};
  const propertyNames = new Set(Object.keys(properties));
  const sanitized: JsonRecord = {};
  const unexpected: string[] = [];

  for (const [key, value] of Object.entries(args)) {
    if (propertyNames.has(key)) {
      sanitized[key] = value;
      continue;
    }
    unexpected.push(key);
  }

  return { args: sanitized, unexpected };
}

function validateToolArguments(
  toolName: string,
  args: JsonRecord,
  schema: unknown,
  unexpected: string[],
): ToolSchemaValidationResult {
  if (!isRecord(schema)) {
    return {
      hasSchema: false,
      ok: true,
      missing: [],
      unexpected: [],
      typeErrors: [],
    };
  }

  const properties = isRecord(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required)
    ? schema.required.filter((value): value is string => typeof value === "string")
    : [];
  const missing = required.filter((key) => !hasOwn(args, key));

  const typeErrors: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    const propertySchema = properties[key];
    if (!isRecord(propertySchema)) {
      continue;
    }
    if (!matchesType(value, propertySchema.type)) {
      if (propertySchema.type !== undefined) {
        typeErrors.push(`${key}: expected ${String(propertySchema.type)}`);
      }
      continue;
    }
    if (
      Array.isArray(propertySchema.enum)
      && !propertySchema.enum.some((candidate) => Object.is(candidate, value))
    ) {
      typeErrors.push(`${key}: expected enum ${JSON.stringify(propertySchema.enum)}`);
    }
  }

  const ok = missing.length === 0 && typeErrors.length === 0;
  return {
    hasSchema: true,
    ok,
    missing,
    unexpected,
    typeErrors,
    repairHint: ok ? undefined : buildRepairHint(toolName, missing, unexpected, typeErrors),
  };
}

function buildRepairHint(
  toolName: string,
  missing: string[],
  unexpected: string[],
  typeErrors: string[],
): string {
  const hints: string[] = [];
  if (missing.length > 0) {
    hints.push(`missing required: ${missing.join(", ")}`);
  }
  if (unexpected.length > 0) {
    hints.push(`remove unsupported fields: ${unexpected.join(", ")}`);
  }
  if (typeErrors.length > 0) {
    hints.push(`fix type errors: ${typeErrors.join("; ")}`);
  }
  if (
    toolName.toLowerCase() === "edit"
    && (missing.includes("old_string") || missing.includes("new_string"))
  ) {
    hints.push("edit requires path, old_string, and new_string");
  }
  return hints.join(" | ");
}

function matchesType(value: unknown, schemaType: unknown): boolean {
  if (schemaType === undefined) {
    return true;
  }
  if (Array.isArray(schemaType)) {
    return schemaType.some((entry) => matchesType(value, entry));
  }
  if (typeof schemaType !== "string") {
    return true;
  }
  switch (schemaType) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "object":
      return isRecord(value);
    case "array":
      return Array.isArray(value);
    case "null":
      return value === null;
    default:
      return true;
  }
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
      } else if (isRecord(item)) {
        const text = typeof item.text === "string"
          ? item.text
          : typeof item.content === "string"
            ? item.content
            : typeof item.value === "string"
              ? item.value
              : null;
        if (text !== null) {
          parts.push(text);
        } else {
          parts.push(JSON.stringify(item));
        }
      } else {
        parts.push(String(item));
      }
    }
    return parts.length > 0 ? parts.join("") : null;
  }
  if (isRecord(value)) {
    if (typeof value.text === "string") {
      return value.text;
    }
    if (typeof value.content === "string") {
      return value.content;
    }
    if (typeof value.value === "string") {
      return value.value;
    }
    return JSON.stringify(value);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return null;
}

function hasOwn(record: JsonRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
