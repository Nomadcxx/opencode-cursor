import type { OpenAiToolCall } from "../proxy/tool-loop.js";

type JsonRecord = Record<string, unknown>;

const EDIT_COMPAT_REPAIR_ENABLED = process.env.CURSOR_ACP_EDIT_COMPAT_REPAIR !== "false";
const QUESTION_COMPAT_REPAIR_ENABLED = process.env.CURSOR_ACP_QUESTION_COMPAT_REPAIR !== "false";

// OpenCode's `question` tool caps option labels and the per-question header at
// 30 characters (see opencode question schema). Cursor-style AskQuestion
// payloads routinely exceed this, so we truncate when remapping.
const QUESTION_LABEL_MAX = 30;

const ARG_KEY_ALIASES = new Map<string, string>([
  ["filepath", "path"],
  ["filename", "path"],
  ["file", "path"],
  ["targetpath", "path"],
  ["directorypath", "path"],
  ["dir", "path"],
  ["folder", "path"],
  ["directory", "path"],
  ["targetdirectory", "path"],
  ["targetfile", "path"],
  ["globpattern", "pattern"],
  ["filepattern", "pattern"],
  ["searchpattern", "pattern"],
  ["includepattern", "include"],
  ["workingdirectory", "cwd"],
  ["workdir", "cwd"],
  ["currentdirectory", "cwd"],
  ["cmd", "command"],
  ["script", "command"],
  ["shellcommand", "command"],
  ["terminalcommand", "command"],
  ["contents", "content"],
  ["text", "content"],
  ["body", "content"],
  ["data", "content"],
  ["payload", "content"],
  ["streamcontent", "content"],
  ["recursive", "force"],
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
  originalArgs: JsonRecord;
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
  const schema = toolSchemaMap.get(toolCall.function.name);
  const { normalizedArgs, collisionKeys } = normalizeArgumentKeys(parsedArgs, schema);
  const toolSpecificArgs = normalizeToolSpecificArgs(toolCall.function.name, normalizedArgs, schema);
  const sanitization = sanitizeArgumentsForSchema(toolSpecificArgs, schema);
  const validation = validateToolArguments(
    toolCall.function.name,
    sanitization.args,
    schema,
    sanitization.unexpected,
    {
      originalArgs: parsedArgs,
      writeSchema: selectWriteSchemaForTool(toolCall.function.name, toolSchemaMap),
    },
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
    originalArgs: parsedArgs,
    originalArgKeys,
    normalizedArgKeys: Object.keys(sanitization.args),
    collisionKeys,
    validation,
  };
}

export function isFullFileShapedEditValidationFailure(
  toolName: string,
  args: JsonRecord,
  validation: ToolSchemaValidationResult,
  originalArgs: JsonRecord,
  writeSchema?: unknown,
): boolean {
  if (!isToolName(toolName, "edit") || validation.ok) {
    return false;
  }
  return buildEditFullFileHint(args, validation.missing, validation.typeErrors, {
    originalArgs,
    writeSchema,
  }) !== null;
}

function buildWriteArguments(
  filePath: string,
  content: string,
  writeSchema: unknown,
  writeToolName = "write",
): JsonRecord {
  if (!isRecord(writeSchema)) {
    return isToolName(writeToolName, "write") && writeToolName.toLowerCase().startsWith("oc_")
      ? { path: filePath, content }
      : { filePath, content };
  }
  const required = Array.isArray(writeSchema.required)
    ? writeSchema.required.filter((value): value is string => typeof value === "string")
    : [];
  if (required.includes("filePath")) {
    return { filePath, content };
  }
  return { path: filePath, content };
}

/** Malformed full-file edit (path + body, no old_string) → write tool call when write is available. */
export function tryRerouteEditToWrite(
  toolCall: OpenAiToolCall,
  compat: ToolSchemaCompatResult,
  allowedToolNames: Set<string>,
  toolSchemaMap: Map<string, unknown>,
): OpenAiToolCall | null {
  if (!isToolName(toolCall.function.name, "edit")) {
    return null;
  }
  const writeToolName = resolveAllowedWriteToolName(allowedToolNames);
  if (!writeToolName) {
    return null;
  }

  const writeSchema = toolSchemaMap.get(writeToolName) ?? selectWriteSchemaForTool(toolCall.function.name, toolSchemaMap);
  if (
    !isFullFileShapedEditValidationFailure(
      toolCall.function.name,
      compat.normalizedArgs,
      compat.validation,
      compat.originalArgs,
      writeSchema,
    )
    && !isFullFileShapedEditPayload(compat.normalizedArgs, compat.originalArgs)
  ) {
    return null;
  }

  const filePath = typeof compat.normalizedArgs.path === "string" && compat.normalizedArgs.path.length > 0
    ? compat.normalizedArgs.path
    : typeof compat.normalizedArgs.filePath === "string" && compat.normalizedArgs.filePath.length > 0
      ? compat.normalizedArgs.filePath
      : null;
  if (!filePath) {
    return null;
  }

  const content =
    typeof compat.normalizedArgs.new_string === "string"
      ? compat.normalizedArgs.new_string
      : typeof compat.normalizedArgs.newString === "string"
        ? compat.normalizedArgs.newString
        : typeof compat.normalizedArgs.content === "string"
          ? compat.normalizedArgs.content
          : typeof compat.normalizedArgs.streamContent === "string"
            ? compat.normalizedArgs.streamContent
            : null;
  if (content === null) {
    return null;
  }

  return {
    ...toolCall,
    function: {
      name: writeToolName,
      arguments: JSON.stringify(buildWriteArguments(filePath, content, writeSchema, writeToolName)),
    },
  };
}

function resolveAllowedWriteToolName(allowedToolNames: Set<string>): string | null {
  if (allowedToolNames.has("write")) {
    return "write";
  }
  if (allowedToolNames.has("oc_write")) {
    return "oc_write";
  }
  return null;
}

function isFullFileShapedEditPayload(args: JsonRecord, originalArgs: JsonRecord): boolean {
  if (hadOldStringPropertyInPayload(originalArgs)) {
    return false;
  }
  return hasEditFilePath(args) && hasEditBody(args);
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

function normalizeArgumentKeys(args: JsonRecord, schema?: unknown): {
  normalizedArgs: JsonRecord;
  collisionKeys: string[];
} {
  const normalizedArgs: JsonRecord = { ...args };
  const collisionKeys: string[] = [];
  const schemaProperties = getSchemaPropertyNames(schema);

  for (const [rawKey, rawValue] of Object.entries(args)) {
    const canonicalKey = resolveCanonicalArgKey(rawKey);
    if (!canonicalKey || canonicalKey === rawKey) {
      continue;
    }
    if (schemaProperties.has(rawKey)) {
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

function getSchemaPropertyNames(schema: unknown): Set<string> {
  if (!isRecord(schema) || !isRecord(schema.properties)) {
    return new Set();
  }
  return new Set(Object.keys(schema.properties));
}

function resolveCanonicalArgKey(rawKey: string): string | null {
  const token = rawKey.toLowerCase().replace(/[^a-z0-9]/g, "");
  return ARG_KEY_ALIASES.get(token) ?? null;
}

function normalizeToolSpecificArgs(toolName: string, args: JsonRecord, schema?: unknown): JsonRecord {
  const normalizedToolName = toolName.toLowerCase();
  if (normalizedToolName === "question" && QUESTION_COMPAT_REPAIR_ENABLED) {
    return normalizeQuestionArgs(args);
  }

  if (normalizedToolName === "bash") {
    const normalized: JsonRecord = { ...args };
    const normalizedCommand = normalizeBashCommand(normalized.command);
    if (typeof normalizedCommand === "string" && normalizedCommand.trim().length > 0) {
      normalized.command = normalizedCommand;
    }
    if (
      normalized.cwd === undefined
      && typeof normalized.path === "string"
      && normalized.path.trim().length > 0
    ) {
      normalized.cwd = normalized.path;
    }
    return normalized;
  }

  if (normalizedToolName === "rm") {
    const normalized: JsonRecord = { ...args };
    if (typeof normalized.force === "string") {
      const lowered = normalized.force.trim().toLowerCase();
      if (lowered === "true" || lowered === "1" || lowered === "yes") {
        normalized.force = true;
      } else if (lowered === "false" || lowered === "0" || lowered === "no") {
        normalized.force = false;
      }
    }
    return normalized;
  }

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

  if (isToolName(toolName, "write")) {
    const normalized: JsonRecord = { ...args };
    const schemaProperties = getSchemaPropertyNames(schema);

    // Cursor's Write tool uses `path`; OpenCode's write schema uses `filePath`.
    if (
      schemaProperties.has("filePath")
      && normalized.filePath === undefined
      && typeof normalized.path === "string"
    ) {
      normalized.filePath = normalized.path;
      delete normalized.path;
    }

    // Some model variants confuse write/edit and send edit-style payload keys.
    // Map them into canonical write arguments before schema validation/sanitization.
    if (normalized.content === undefined && normalized.new_string !== undefined) {
      const coerced = coerceToString(normalized.new_string);
      if (coerced !== null) {
        normalized.content = coerced;
      }
      delete normalized.new_string;
    }

    if (normalized.content !== undefined && typeof normalized.content !== "string") {
      const coerced = coerceToString(normalized.content);
      if (coerced !== null) {
        normalized.content = coerced;
      }
    }

    return normalized;
  }

  if (!isToolName(toolName, "edit") || !EDIT_COMPAT_REPAIR_ENABLED) {
    return args;
  }

  const repaired: JsonRecord = { ...args };
  const schemaProperties = getSchemaPropertyNames(schema);
  if (schemaProperties.size === 0) {
    return normalizeSchemaAbsentEditArgs(repaired);
  }
  const newKey = schemaProperties.has("newString") ? "newString" : "new_string";
  const oldKey = schemaProperties.has("oldString") ? "oldString" : "old_string";

  if (
    schemaProperties.has("filePath")
    && repaired.filePath === undefined
    && typeof repaired.path === "string"
  ) {
    repaired.filePath = repaired.path;
    delete repaired.path;
  }
  if (
    oldKey === "oldString"
    && repaired.oldString === undefined
    && typeof repaired.old_string === "string"
  ) {
    repaired.oldString = repaired.old_string;
    delete repaired.old_string;
  }
  if (
    newKey === "newString"
    && repaired.newString === undefined
    && typeof repaired.new_string === "string"
  ) {
    repaired.newString = repaired.new_string;
    delete repaired.new_string;
  }

  const hasStringNew = typeof repaired[newKey] === "string";
  const hasStringOld = typeof repaired[oldKey] === "string";

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
    repaired[newKey] = content;
  }
  if (hasStringOld && repaired[oldKey] === "") {
    delete repaired[oldKey];
  }

  return repaired;
}

function normalizeSchemaAbsentEditArgs(args: JsonRecord): JsonRecord {
  const repaired: JsonRecord = { ...args };
  if (repaired.filePath === undefined && typeof repaired.path === "string") {
    repaired.filePath = repaired.path;
    delete repaired.path;
  }
  if (repaired.oldString === undefined && typeof repaired.old_string === "string") {
    repaired.oldString = repaired.old_string;
    delete repaired.old_string;
  }
  if (repaired.newString === undefined && typeof repaired.new_string === "string") {
    repaired.newString = repaired.new_string;
    delete repaired.new_string;
  }
  if (repaired.content !== undefined && typeof repaired.content !== "string") {
    const coerced = coerceToString(repaired.content);
    if (coerced !== null) {
      repaired.content = coerced;
    }
  }
  if (repaired.newString === undefined && typeof repaired.content === "string") {
    repaired.newString = repaired.content;
  }
  delete repaired.content;
  return repaired;
}

/**
 * Maps a Cursor-style `AskQuestion` payload into OpenCode's `question` schema.
 *
 * Cursor emits:   { title?, questions: [{ id?, prompt, options: [{ id?, label }], allow_multiple? }] }
 * OpenCode wants: { questions: [{ question, header(<=30), options: [{ label(<=30), description }], multiple?, custom? }] }
 *
 * The transform is idempotent: payloads already shaped for OpenCode pass through
 * unchanged apart from defensive truncation of over-long labels/headers.
 */
function normalizeQuestionArgs(args: JsonRecord): JsonRecord {
  if (!Array.isArray(args.questions)) {
    return args;
  }

  const topTitle = typeof args.title === "string" ? args.title : undefined;

  const questions = args.questions.map((rawQuestion) => {
    if (!isRecord(rawQuestion)) {
      return rawQuestion;
    }

    const question: JsonRecord = { ...rawQuestion };

    // prompt/text -> question
    if (typeof question.question !== "string") {
      if (typeof question.prompt === "string") {
        question.question = question.prompt;
      } else if (typeof question.text === "string") {
        question.question = question.text;
      }
    }
    delete question.prompt;
    delete question.text;

    // header (<=30 chars). Prefer an explicit header, then the top-level title,
    // then a truncation of the question itself so the field is never empty.
    const headerSource =
      typeof question.header === "string" && question.header.trim().length > 0
        ? question.header
        : topTitle ?? (typeof question.question === "string" ? question.question : "");
    question.header = truncate(headerSource, QUESTION_LABEL_MAX);

    // allow_multiple -> multiple
    if (question.multiple === undefined && typeof question.allow_multiple === "boolean") {
      question.multiple = question.allow_multiple;
    }
    delete question.allow_multiple;

    if (Array.isArray(question.options)) {
      question.options = question.options.map((rawOption) => {
        if (typeof rawOption === "string") {
          return { label: truncate(rawOption, QUESTION_LABEL_MAX), description: rawOption };
        }
        if (!isRecord(rawOption)) {
          return rawOption;
        }

        const option: JsonRecord = { ...rawOption };
        const fullLabel =
          typeof option.label === "string"
            ? option.label
            : typeof option.title === "string"
              ? option.title
              : typeof option.text === "string"
                ? option.text
                : "";

        // OpenCode requires a non-empty description; fall back to the full label.
        if (typeof option.description !== "string" || option.description.trim().length === 0) {
          option.description = fullLabel;
        }
        const labelSource = fullLabel.length > 0 ? fullLabel : String(option.description ?? "");
        option.label = truncate(labelSource, QUESTION_LABEL_MAX);

        // Cursor-only fields OpenCode does not understand.
        delete option.id;
        delete option.title;
        delete option.text;
        return option;
      });
    }

    // Cursor scopes answers by per-question id; OpenCode keys by index/label.
    delete question.id;
    return question;
  });

  // OpenCode's `question` schema has no top-level title field.
  return { questions };
}

function truncate(value: unknown, max: number): string {
  const text = typeof value === "string" ? value.trim() : "";
  return text.length > max ? text.slice(0, max) : text;
}

function normalizeBashCommand(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    const parts = value
      .map((entry) => (typeof entry === "string" ? entry : coerceToString(entry)))
      .filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
    return parts.length > 0 ? parts.join(" ") : null;
  }
  if (isRecord(value)) {
    const command = typeof value.command === "string" ? value.command : null;
    const args = Array.isArray(value.args)
      ? value.args
          .map((entry) => (typeof entry === "string" ? entry : coerceToString(entry)))
          .filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
      : [];
    if (command && args.length > 0) {
      return [command, ...args].join(" ");
    }
    if (command) {
      return command;
    }
  }
  return null;
}

function normalizeTodoStatus(status: string): string {
  const normalized = status.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (normalized === "todo_status_pending") {
    return "pending";
  }
  if (normalized === "todo_status_inprogress" || normalized === "todo_status_in_progress") {
    return "in_progress";
  }
  if (
    normalized === "todo_status_done"
    || normalized === "todo_status_complete"
    || normalized === "todo_status_completed"
  ) {
    return "completed";
  }
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

type ValidateToolArgumentsContext = {
  originalArgs?: JsonRecord;
  writeSchema?: unknown;
};

function validateToolArguments(
  toolName: string,
  args: JsonRecord,
  schema: unknown,
  unexpected: string[],
  context: ValidateToolArgumentsContext = {},
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
    repairHint: ok
      ? undefined
      : buildRepairHint(toolName, args, missing, unexpected, typeErrors, context),
  };
}

function hadOldStringPropertyInPayload(args: JsonRecord): boolean {
  for (const key of Object.keys(args)) {
    const token = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (token === "oldstring") {
      return true;
    }
  }
  return false;
}

function hasEditFilePath(args: JsonRecord): boolean {
  const pathValue = args.path ?? args.filePath;
  return typeof pathValue === "string" && pathValue.trim().length > 0;
}

function hasEditBody(args: JsonRecord): boolean {
  const body = args.new_string ?? args.newString ?? args.content ?? args.streamContent;
  return typeof body === "string" && body.length > 0;
}

function writeToolExample(writeSchema: unknown): string {
  if (!isRecord(writeSchema)) {
    return "write with path and content";
  }
  const required = Array.isArray(writeSchema.required)
    ? writeSchema.required.filter((value): value is string => typeof value === "string")
    : [];
  if (required.includes("filePath")) {
    return "write with filePath and content";
  }
  return "write with path and content";
}

function buildEditFullFileHint(
  args: JsonRecord,
  missing: string[],
  typeErrors: string[],
  context: ValidateToolArgumentsContext,
): string | null {
  if (typeErrors.length > 0) {
    return null;
  }

  const missingOldStringOnly =
    (missing.includes("old_string") || missing.includes("oldString"))
    && missing.every((key) => key === "old_string" || key === "oldString");
  if (!missingOldStringOnly) {
    return null;
  }

  const originalArgs = context.originalArgs ?? {};
  if (hadOldStringPropertyInPayload(originalArgs)) {
    return null;
  }

  if (!hasEditFilePath(args) || !hasEditBody(args)) {
    return null;
  }

  const example = writeToolExample(context.writeSchema);
  return `For a full file body, use ${example} instead of edit without old_string`;
}

function buildRepairHint(
  toolName: string,
  args: JsonRecord,
  missing: string[],
  unexpected: string[],
  typeErrors: string[],
  context: ValidateToolArgumentsContext = {},
): string {
  const fullFileHint = isToolName(toolName, "edit")
    ? buildEditFullFileHint(args, missing, typeErrors, context)
    : null;
  if (fullFileHint) {
    return fullFileHint;
  }

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
    isToolName(toolName, "edit")
    && (missing.includes("old_string") || missing.includes("oldString") || missing.includes("new_string") || missing.includes("newString"))
  ) {
    hints.push("edit requires path, old_string, and new_string");
  }

  return hints.join(" | ");
}

function selectWriteSchemaForTool(toolName: string, toolSchemaMap: Map<string, unknown>): unknown {
  if (toolName.toLowerCase().startsWith("oc_")) {
    return toolSchemaMap.get("oc_write") ?? toolSchemaMap.get("write");
  }
  return toolSchemaMap.get("write") ?? toolSchemaMap.get("oc_write");
}

function isToolName(toolName: string, canonical: "edit" | "write"): boolean {
  const token = toolName.toLowerCase().replace(/[^a-z0-9]/g, "");
  return token === canonical || token === `oc${canonical}`;
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
