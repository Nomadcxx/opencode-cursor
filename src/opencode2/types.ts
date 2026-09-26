/**
 * Runtime duck-type boundary for the OpenCode 2.0 plugin — not host conformance.
 *
 * Only the methods and fields this plugin calls or publishes. Extra host
 * fields are ignored at runtime. Do not import `@opencode/plugin`: it is not a
 * standalone types surface we can pin next to `@opencode-ai/plugin`, and a host
 * dependency would force a plugin bump on every OpenCode release.
 *
 * Effect `Schema` brands (Provider.ID, Model.ID, …) are modelled as plain
 * `string`; brands are compile-time only and erase at runtime.
 */

export type Registration = {
  readonly dispose: () => Promise<void> | void;
};

export type Hooks<Spec> = <Name extends keyof Spec>(
  name: Name,
  callback: (input: Spec[Name]) => Promise<void> | void,
) => Promise<Registration>;

export type Transform<Input> = (callback: (input: Input) => void) => Promise<Registration>;

export type ProviderInfo = {
  id: string;
  name: string;
  /** `"aisdk:<pkg>"` selects the AI SDK path. */
  package: string;
  activation: "auto" | "enabled" | "disabled";
  integrationID?: string;
  settings?: Record<string, unknown>;
};

export type ModelVariantInfo = {
  id: string;
  settings?: Record<string, unknown>;
};

export type ModelInfo2 = {
  id: string;
  modelID: string;
  providerID: string;
  name: string;
  capabilities: { tools: boolean; input: readonly string[]; output: readonly string[] };
  variants: readonly ModelVariantInfo[];
  time: { released: number };
  cost: readonly {
    tier?: { type: "context"; size: number };
    input: number;
    output: number;
    cache: { read: number; write: number };
  }[];
  status: "active";
  enabled: boolean;
  limit: { context: number; input?: number; output: number };
  settings?: Record<string, unknown>;
};

export type CredentialKey = {
  type: "key";
  key: string;
  metadata?: Record<string, unknown>;
};

export type CredentialValue = CredentialKey | { type: string; key?: string; access?: string };

export type ConnectionInfo =
  | { type: "credential"; id: string; label: string }
  | { type: "env"; name: string };

export type ProviderEditor = {
  add(input: {
    info: ProviderInfo;
    models: readonly ModelInfo2[];
    sourceConnection?: ConnectionInfo;
  }): void;
};

export type ProviderDomain = {
  readonly transform: Transform<ProviderEditor>;
  readonly reload: () => Promise<void>;
};

export type IntegrationKeyMethod = { type: "key"; label?: string };
export type IntegrationEnvMethod = { type: "env"; names: string[] };

export type IntegrationMethodRegistration =
  | { readonly integrationID: string; readonly method: IntegrationKeyMethod }
  | { readonly integrationID: string; readonly method: IntegrationEnvMethod };

export type IntegrationRef = { id: string; name: string };

export type IntegrationDraft = {
  update(id: string, update: (integration: IntegrationRef) => void): void;
  readonly method: {
    update(input: IntegrationMethodRegistration): void;
  };
};

export type IntegrationDomain = {
  readonly transform: Transform<IntegrationDraft>;
  readonly reload: () => Promise<void>;
  readonly connection: {
    readonly active: (integrationID: string) => Promise<ConnectionInfo | undefined>;
    readonly resolve: (connection: ConnectionInfo) => Promise<CredentialValue | undefined>;
  };
};

export type ToolOptions = {
  readonly namespace?: string;
  readonly permission?: string;
  readonly codemode?: boolean;
  readonly pinned?: boolean;
};

export type ToolExecutionContext = {
  readonly sessionID: string;
  readonly agent: string;
  readonly messageID: string;
  readonly id: string;
  readonly progress: (update: Record<string, unknown>) => Promise<void>;
};

export type ToolDefinition = {
  readonly name: string;
  readonly description: string;
  readonly input: unknown;
  readonly output?: unknown;
  readonly options?: ToolOptions;
  readonly execute: (input: any, context: ToolExecutionContext) => Promise<any>;
};

export type ToolDraft = {
  add(tool: ToolDefinition): void;
  get?(id: string): (ToolDefinition & { readonly id?: string }) | undefined;
  list?(): readonly (ToolDefinition & { readonly id: string })[];
  update?(
    id: string,
    update: (tool: {
      options?: {
        namespace?: string;
        permission?: string;
        codemode?: boolean;
        pinned?: boolean;
      };
    }) => void,
  ): void;
};

export type ToolDomain = {
  readonly transform: Transform<ToolDraft>;
  readonly reload: () => Promise<void>;
};

export type SessionContext = {
  readonly sessionID: string;
  readonly agent: string;
  readonly model: { providerID: string; id: string; variant?: string };
  system: Array<any>;
  messages: Array<any>;
  tools: Record<string, { description: string; input: unknown }>;
  options?: Record<string, unknown>;
};

export type SessionHttpRequest = {
  readonly model: { providerID: string; id?: string };
  request: Request;
};

export type SessionHooks = {
  readonly context: SessionContext;
  /** Present on some hosts; optional at runtime — registration may throw. */
  readonly "http.request": SessionHttpRequest;
};

export type SessionDomain = {
  readonly hook: Hooks<SessionHooks>;
  readonly get?: (input: { sessionID: string }) => Promise<{
    readonly id?: string;
    readonly directory?: string;
    readonly location?: { readonly directory?: string };
  }>;
};

export type PluginLocation = {
  readonly directory: string;
};

export type PluginContext = {
  readonly integration: IntegrationDomain;
  readonly provider: ProviderDomain;
  readonly session: SessionDomain;
  readonly tool: ToolDomain;
  readonly location?: PluginLocation;
};

export type Cleanup = () => Promise<void> | void;

export type Plugin2 = {
  readonly id: string;
  readonly setup: (context: PluginContext) => Promise<Cleanup | void> | Cleanup | void;
};
