import type { SafeDiagnostic, SafeScopeStatus, SafeStatus, ScopeId } from "../contracts.js";
import type { ServerProtection } from "../options.js";
import { applyProtection, type McpEditor, type ProtectionState } from "../plugin.js";
import type { ManagedEnvironmentState } from "../plugin.js";
import type { ScopedConfiguration, ScopedGroup } from "../scoped-config.js";
import type { Runtime } from "./controller-types.js";

export function filterGroupMappings(
  group: ScopedGroup,
  bindings: Readonly<Record<string, ScopeId>>,
): Readonly<Record<string, ServerProtection>> {
  return Object.fromEntries(
    Object.entries(group.servers).filter(([name]) => bindings[name] === group.id),
  );
}

/**
 * Returns the semantic project inputs used by the configuration watcher.
 *
 * `sourceRoot` and the manager directory are resolved by scoped-config before
 * this point. Including both prevents a project-root switch from reusing the
 * Varlock process while keeping relative aliases and key ordering stable.
 */
export function configurationFingerprint(value: ScopedConfiguration): string {
  return JSON.stringify(
    stableValue({
      project:
        value.project === undefined
          ? undefined
          : {
              servers: value.project.servers,
              sourceRoot: value.project.sourceRoot,
              managerProjectDirectory: value.project.manager.projectDirectory,
            },
      activation: value.activation,
      bindings: value.bindings,
      diagnostics: value.diagnostics,
    }),
  );
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stableValue(item)]),
  );
}

function optionalStatusFields(status: SafeStatus): Partial<SafeStatus> {
  return {
    ...(status.pid === undefined ? {} : { pid: status.pid }),
    ...(status.lastRefreshAt === undefined ? {} : { lastRefreshAt: status.lastRefreshAt }),
    ...(status.error === undefined ? {} : { error: status.error }),
  };
}

export function groupStatus(
  runtime: Runtime,
  activation?: SafeScopeStatus["activation"],
): SafeScopeStatus {
  const status = runtime.status ?? {
    phase: "starting" as const,
    projectDirectory: runtime.group.sourceRoot,
    generation: 0,
  };
  const diagnostics: readonly SafeDiagnostic[] = [
    ...(status.diagnostics ?? []),
    ...runtime.remote.diagnostics,
  ];
  return {
    scope: runtime.id,
    projectDirectory: status.projectDirectory,
    phase: status.phase,
    generation: status.generation,
    ...optionalStatusFields(status),
    ...(diagnostics.length === 0 ? {} : { diagnostics }),
    ...(activation === undefined ? {} : { activation }),
  };
}

export function emptyProtectionState(): ProtectionState {
  return { ready: false, environment: {} };
}

export function captureEditor(editor: McpEditor): {
  disabled: Set<string>;
  remote: Map<string, NonNullable<ReturnType<typeof remoteSnapshot>>>;
  environments: Map<string, Readonly<Record<string, string>>>;
} {
  const disabled = new Set<string>();
  const remote = new Map<string, ReturnType<typeof remoteSnapshot>>();
  const environments = new Map<string, Readonly<Record<string, string>>>();
  for (const [name, value] of editor.list()) {
    if (value.disabled === true) disabled.add(name);
    if (value.type === "local") environments.set(name, { ...(value.environment ?? {}) });
    if (value.type === "remote") remote.set(name, remoteSnapshot(value));
  }
  return { disabled, remote, environments };
}

function remoteSnapshot(value: any) {
  return {
    type: "remote" as const,
    url: value.url,
    ...(value.headers === undefined ? {} : { headers: { ...value.headers } }),
    ...(value.oauth === undefined ? {} : { oauth: value.oauth }),
    ...(value.disabled === undefined ? {} : { disabled: value.disabled }),
  };
}

export function cleanManagedEnvironment(
  editor: McpEditor,
  managed: Map<string, Map<string, ManagedEnvironmentState>>,
  injected: Map<string, Record<string, string>>,
  pristine: Map<string, Readonly<Record<string, string>>>,
): void {
  for (const [name, keys] of managed)
    editor.update(name, (config) => restoreManaged(config, keys, pristine, name));
  for (const [name, values] of injected)
    editor.update(name, (config) => restoreInjected(config, values, pristine, name));
}

function restoreManaged(
  config: any,
  keys: Map<string, ManagedEnvironmentState>,
  pristine: Map<string, Readonly<Record<string, string>>>,
  name: string,
): void {
  if (config.type !== "local") return;
  const environment = { ...(config.environment ?? {}) };
  for (const state of keys.values())
    for (const key of Object.keys(state.injected))
      restoreManagedKey(environment, key, state, keys, pristine, name);
  keys.clear();
  config.environment = environment;
}

function restoreManagedKey(
  environment: Record<string, string>,
  key: string,
  state: ManagedEnvironmentState,
  _keys: Map<string, ManagedEnvironmentState>,
  pristine: Map<string, Readonly<Record<string, string>>>,
  name: string,
): void {
  if (environment[key] !== state.injected[key])
    pristine.set(name, { ...(pristine.get(name) ?? {}), [key]: environment[key] });
  else if (state.original[key] === undefined) delete environment[key];
  else environment[key] = state.original[key]!;
}

function restoreInjected(
  config: any,
  values: Record<string, string>,
  pristine: Map<string, Readonly<Record<string, string>>>,
  name: string,
): void {
  if (config.type !== "local") return;
  const environment = { ...(config.environment ?? {}) };
  for (const [key, value] of Object.entries(values))
    restoreInjectedKey(environment, key, value, pristine.get(name)?.[key]);
  config.environment = environment;
}

function restoreInjectedKey(
  environment: Record<string, string>,
  key: string,
  injected: string,
  original: string | undefined,
): void {
  if (environment[key] !== injected) return;
  if (original === undefined) delete environment[key];
  else environment[key] = original;
}

export function runtimeEnvironment(
  editor: McpEditor,
  runtime: Runtime,
  pristine: Map<string, Readonly<Record<string, string>>>,
  managed: Map<string, Map<string, ManagedEnvironmentState>>,
  injected: Map<string, Record<string, string>>,
): void {
  for (const [name, mapping] of Object.entries(runtime.mappings)) {
    if (!eligibleEnvironmentMapping(mapping, runtime.state.ready)) continue;
    const server = editor.get(name);
    if (server?.type !== "local") continue;
    rememberEnvironment(name, mapping, runtime, pristine, managed, injected);
  }
}

function eligibleEnvironmentMapping(
  mapping: ServerProtection,
  ready: boolean,
): mapping is Record<string, string> {
  return ready && typeof mapping === "object" && !("remote" in mapping);
}

function rememberEnvironment(
  name: string,
  mapping: Record<string, string>,
  runtime: Runtime,
  pristine: Map<string, Readonly<Record<string, string>>>,
  managed: Map<string, Map<string, ManagedEnvironmentState>>,
  injected: Map<string, Record<string, string>>,
): void {
  const values = environmentValues(mapping, runtime.state.environment, pristine.get(name));
  if (Object.keys(values.injected).length === 0) return;
  managed.set(name, new Map([[runtime.id, values]]));
  injected.set(name, values.injected);
}

function environmentValues(
  mapping: Record<string, string>,
  environment: Readonly<Record<string, string>>,
  originalEnvironment: Readonly<Record<string, string>> | undefined,
): ManagedEnvironmentState {
  const injected: Record<string, string> = {};
  const original: Record<string, string | undefined> = {};
  for (const output of Object.keys(mapping)) {
    const value = environment[mapping[output]!];
    if (value === undefined) continue;
    injected[output] = value;
    original[output] = originalEnvironment?.[output];
  }
  return { original, injected };
}

export function selectRuntime(
  runtimes: Map<ScopeId, Runtime>,
  bindings: Readonly<Record<string, ScopeId>>,
  selector?: { readonly scope?: ScopeId; readonly server?: string },
): Runtime | undefined {
  if (!selector?.scope && !selector?.server) return defaultRuntime(runtimes);
  const scope =
    selector.scope ?? (selector.server === undefined ? undefined : bindings[selector.server]);
  return validSelection(scope, selector?.server, bindings) ? runtimes.get(scope) : undefined;
}

function defaultRuntime(runtimes: Map<ScopeId, Runtime>): Runtime | undefined {
  return runtimes.get("global") ?? runtimes.get("project");
}

function validSelection(
  scope: ScopeId | undefined,
  server: string | undefined,
  bindings: Readonly<Record<string, ScopeId>>,
): scope is ScopeId {
  return scope !== undefined && (server === undefined || bindings[server] === scope);
}

export function aggregatePhase(
  base: SafeStatus["phase"],
  scopes: readonly SafeScopeStatus[],
): SafeStatus["phase"] {
  const active = scopes.filter((item) => item.activation !== "awaiting_activation");
  const unstable = active.some((item) => item.phase === "failed" || item.phase === "starting");
  if (unstable) return active.some((item) => item.phase === "ready") ? "degraded" : base;
  return active.every((item) => item.phase === "ready") ? "ready" : base;
}

export function projectFallback(configuration: ScopedConfiguration): SafeScopeStatus | undefined {
  if (!configuration.project) return undefined;
  return {
    scope: "project",
    projectDirectory: configuration.project.sourceRoot,
    phase: "stopped",
    generation: 0,
    activation: configuration.activation === "auto" ? "auto" : "awaiting_activation",
    diagnostics: configuration.diagnostics,
  };
}

export function applyRuntimeProtection(
  editor: McpEditor,
  runtime: Runtime,
  explicitlyDisabled: ReadonlySet<string>,
): void {
  for (const name of Object.keys(runtime.mappings)) {
    if (explicitlyDisabled.has(name)) continue;
    editor.update(name, (config) => {
      config.disabled = undefined;
    });
  }
  applyProtection(editor, { ...runtime.group.options.adapter, servers: runtime.mappings } as any, {
    ...runtime.state,
    explicitlyDisabled,
    remoteHandles: runtime.remote.handles,
  });
}

export function disableProjectServers(
  editor: McpEditor,
  configuration: ScopedConfiguration,
  inactive: ReadonlySet<string>,
): void {
  for (const [name] of Object.entries(configuration.project?.servers ?? {})) {
    if (configuration.bindings[name] !== "project") continue;
    editor.update(name, (config) => {
      config.disabled = true;
    });
  }
  for (const name of inactive)
    editor.update(name, (config) => {
      config.disabled = true;
    });
}

export function selectedStatus(
  runtime: Runtime | undefined,
  configuration: ScopedConfiguration,
  selector: { readonly scope?: ScopeId; readonly server?: string },
): SafeStatus {
  if (runtime) {
    const scoped = groupStatus(
      runtime,
      runtime.id === "project" ? configuration.activation : "auto",
    );
    return {
      phase: scoped.phase,
      projectDirectory: scoped.projectDirectory,
      generation: scoped.generation,
      ...safeFields(scoped),
      scopes: [scoped],
      bindings: configuration.bindings,
    };
  }
  return {
    phase: "failed",
    projectDirectory: configuration.global.sourceRoot,
    generation: 0,
    diagnostics: [
      {
        code: "server_unbound",
        server: selector.server ?? "",
        message: "server is not bound to an active scope",
      },
    ],
  };
}

function safeFields(status: SafeScopeStatus): Partial<SafeStatus> {
  return {
    ...(status.pid === undefined ? {} : { pid: status.pid }),
    ...(status.lastRefreshAt === undefined ? {} : { lastRefreshAt: status.lastRefreshAt }),
    ...(status.error === undefined ? {} : { error: status.error }),
    ...(status.diagnostics === undefined ? {} : { diagnostics: status.diagnostics }),
  };
}

export function statusBase(
  global: Runtime | undefined,
  project: SafeScopeStatus | undefined,
  configuration: ScopedConfiguration,
): SafeStatus {
  if (global?.status) return global.status;
  if (global)
    return { phase: "starting", projectDirectory: global.group.sourceRoot, generation: 0 };
  if (project)
    return {
      phase: project.phase,
      projectDirectory: project.projectDirectory,
      generation: project.generation,
      ...(project.error === undefined ? {} : { error: project.error }),
    };
  return { phase: "stopped", projectDirectory: configuration.global.sourceRoot, generation: 0 };
}

export function statusScopes(
  global: Runtime | undefined,
  project: SafeScopeStatus | undefined,
): SafeScopeStatus[] {
  return [...(global ? [groupStatus(global, "auto")] : []), ...(project ? [project] : [])];
}
