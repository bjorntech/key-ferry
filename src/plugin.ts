import { Mcp, Plugin } from "@opencode/plugin/effect";
import { Effect, Scope, Stream, Types } from "effect";
import { brokerRegistry, type BrokerLease, type BrokerRegistry } from "./broker-registry.js";
import type {
  ProjectKeyFerryManagerFactory,
  ResolvedEnvironment,
  SafeStatus,
} from "./contracts.js";
import {
  managerOptions,
  parseOptions,
  type ServerProtection,
  type ValidatedOptions,
} from "./options.js";
import {
  makeRemoteRelayCoordinator,
  RELAY_AUTH_HEADER,
  safeForwardHeaders,
  isRemoteProtection,
  type RemoteDiagnostic,
  type RemoteRelayFactory,
  type RemoteRelayHandle,
  type RemoteServerSnapshot,
} from "./remote.js";
import { KeyFerryRpc, publicMessage, rpcError, sanitizeStatus } from "./rpc.js";

export interface McpEditor {
  list(): readonly [string, Types.DeepMutable<Mcp.ServerConfig>][];
  get(name: string): Types.DeepMutable<Mcp.ServerConfig> | undefined;
  update(name: string, update: (config: Types.DeepMutable<Mcp.ServerConfig>) => void): void;
}

export interface ProtectionState {
  readonly ready: boolean;
  readonly environment: ResolvedEnvironment;
  readonly remoteHandles?: ReadonlyMap<string, RemoteRelayHandle>;
  readonly explicitlyDisabled?: ReadonlySet<string>;
}

function preserveDisabled(name: string, server: Mcp.ServerConfig, state: ProtectionState): boolean {
  return state.explicitlyDisabled?.has(name) ?? server.disabled === true;
}

function disableConfig(config: Types.DeepMutable<Mcp.ServerConfig>): void {
  config.disabled = true;
}

function remoteCanBeProtected(
  config: Types.DeepMutable<Mcp.ServerConfig>,
  state: ProtectionState,
  handle: RemoteRelayHandle | undefined,
): boolean {
  return config.type === "remote" && config.oauth === false && state.ready && handle !== undefined;
}

function updateRemoteConfig(
  config: Types.DeepMutable<Mcp.ServerConfig>,
  mapping: Extract<ServerProtection, { remote: unknown }>,
  state: ProtectionState,
  handle: RemoteRelayHandle,
  name: string,
  server: Types.DeepMutable<Mcp.ServerConfig>,
): void {
  if (!remoteCanBeProtected(config, state, handle)) {
    disableConfig(config);
    return;
  }
  const remote = config as Extract<Types.DeepMutable<Mcp.ServerConfig>, { type: "remote" }>;
  const headers = safeForwardHeaders(remote.headers, mapping);
  if (headers === undefined) {
    disableConfig(config);
    return;
  }
  remote.url = handle.localUrl;
  remote.headers = { ...headers, [RELAY_AUTH_HEADER]: handle.downstreamToken };
  if (!preserveDisabled(name, server, state)) config.disabled = false;
}

function applyRemoteProtection(
  editor: McpEditor,
  name: string,
  server: Types.DeepMutable<Mcp.ServerConfig>,
  mapping: Extract<ServerProtection, { remote: unknown }>,
  state: ProtectionState,
): void {
  const handle = state.remoteHandles?.get(name);
  editor.update(name, (config) =>
    handle === undefined
      ? disableConfig(config)
      : updateRemoteConfig(config, mapping, state, handle, name, server),
  );
}

function applyLocalProtection(
  editor: McpEditor,
  name: string,
  server: Types.DeepMutable<Mcp.ServerConfig>,
  mapping: Record<string, string>,
  state: ProtectionState,
): void {
  const resolved: Record<string, string> = Object.create(null) as Record<string, string>;
  let complete = state.ready;
  for (const [outputName, sourceName] of Object.entries(mapping)) {
    const value = state.environment[sourceName];
    if (value === undefined) complete = false;
    else resolved[outputName] = value;
  }
  editor.update(name, (config) => {
    if (config.type !== "local" || !complete) {
      disableConfig(config);
      return;
    }
    config.environment = { ...(config.environment ?? {}), ...resolved };
    if (!preserveDisabled(name, server, state)) config.disabled = false;
  });
}

/**
 * Apply only explicitly configured local protections. A selected remote
 * server, missing key, or unavailable manager is disabled rather than falling
 * back to direct transport.
 */
export function applyProtection(
  editor: McpEditor,
  options: ValidatedOptions["adapter"],
  state: ProtectionState,
): void {
  for (const [name, mapping] of Object.entries(options.servers)) {
    const server = editor.get(name);
    if (!server) continue;
    if (isRemoteProtection(mapping)) {
      applyRemoteProtection(editor, name, server, mapping, state);
      continue;
    }
    if (server.type !== "local") {
      editor.update(name, disableConfig);
      continue;
    }
    applyLocalProtection(editor, name, server, mapping, state);
  }
}

function snapshotServers(editor: McpEditor): ReadonlyMap<string, RemoteServerSnapshot> {
  const result = new Map<string, RemoteServerSnapshot>();
  for (const [name, config] of editor.list()) {
    if (config.type !== "remote") continue;
    result.set(name, {
      type: "remote",
      url: config.url,
      ...(config.headers === undefined ? {} : { headers: { ...config.headers } }),
      ...(config.oauth === undefined ? {} : { oauth: config.oauth }),
      ...(config.disabled === undefined ? {} : { disabled: config.disabled }),
      ...(config.codemode === undefined ? {} : { codemode: config.codemode }),
      ...(config.timeout === undefined ? {} : { timeout: config.timeout }),
      ...(config.protocol === undefined ? {} : { protocol: config.protocol }),
    });
  }
  return result;
}

export type HealthPollDecision = "noop" | "clear" | "reconcile";

function unavailableHealthDecision(ready: boolean, remoteHandleCount: number): HealthPollDecision {
  if (ready) return "clear";
  if (remoteHandleCount > 0) return "clear";
  return "noop";
}

function readyHealthDecision(
  ready: boolean,
  relayHealthy: boolean,
  generation: number,
  observedGeneration: number,
): HealthPollDecision {
  if (!relayHealthy) return "clear";
  if (generation !== observedGeneration) return "reconcile";
  if (!ready) return "reconcile";
  return "noop";
}

/** Decide the side-effecting health action separately from its scheduler. */
export function healthPollDecision(
  phase: SafeStatus["phase"],
  ready: boolean,
  remoteHandleCount: number,
  relayHealthy: boolean,
  generation: number,
  observedGeneration: number,
): HealthPollDecision {
  if (phase !== "ready") return unavailableHealthDecision(ready, remoteHandleCount);
  return readyHealthDecision(ready, relayHealthy, generation, observedGeneration);
}

type PluginOptionsContext = {
  readonly options: unknown;
  readonly location: { readonly project: { readonly directory: string } };
};

function parsePluginOptions(ctx: PluginOptionsContext): ValidatedOptions {
  // Fully validate disabled options without touching the host location.
  // Relative project paths are deliberately left unresolved because they are
  // unused on this path and must not be resolved against process.cwd().
  const preflight = parseOptions(ctx.options, undefined, false);
  return preflight.enabled ? parseOptions(ctx.options, ctx.location.project.directory) : preflight;
}

/** Construct the native OpenCode V2 plugin. The real manager is injected later. */
export function makePlugin(
  factory: ProjectKeyFerryManagerFactory,
  relayFactory?: RemoteRelayFactory,
  registry: BrokerRegistry = brokerRegistry,
): Plugin.Plugin {
  return Plugin.define({
    id: "key-ferry",
    effect: (ctx) => {
      const parsed = parsePluginOptions(ctx);
      if (!parsed.enabled) return Effect.void;
      const program = Effect.gen(function* () {
        const pluginScope = yield* Effect.scope;
        const brokerOptions = managerOptions(parsed, ctx.location.project.directory);
        const lease: BrokerLease = yield* registry.acquire(factory, brokerOptions) as Effect.Effect<
          BrokerLease,
          never,
          never
        >;
        yield* Effect.addFinalizer(() => lease.release);
        let state: ProtectionState = { ready: false, environment: {} };
        let observedGeneration = -1;
        let remoteDiagnostics: readonly RemoteDiagnostic[] = [];
        let serverSnapshots: ReadonlyMap<string, RemoteServerSnapshot> = new Map();
        let explicitlyDisabled = new Set<string>();
        let capturedDisabled = false;
        const remote = makeRemoteRelayCoordinator(relayFactory, parsed.adapter.allowPrivateNetwork);
        const setState = (next: ProtectionState) => {
          state = { ...next, explicitlyDisabled };
        };
        const publicStatus = (status: SafeStatus): SafeStatus =>
          sanitizeStatus({
            ...status,
            ...(remoteDiagnostics.length === 0 ? {} : { diagnostics: remoteDiagnostics }),
          });
        const reconcileRemote = (
          status: SafeStatus,
          environment: Readonly<Record<string, string>>,
        ) =>
          Effect.gen(function* () {
            // A health failure may have stopped and removed the current handles.
            // Reconcile from the manager capability again during doctor, rather
            // than treating doctor as a metadata-only operation.
            if (status.phase === "ready") {
              if (!(yield* remote.health)) yield* remote.stopAll;
              yield* Effect.provideService(
                remote.reconcile(
                  serverSnapshots,
                  parsed.adapter.servers,
                  environment,
                  status.generation,
                ),
                Scope.Scope,
                pluginScope,
              );
            } else {
              yield* remote.stopAll;
            }
            remoteDiagnostics = remote.diagnostics;
            const next = {
              ready: status.phase === "ready",
              environment,
              remoteHandles: remote.handles,
            };
            setState(next);
            return next;
          });
        yield* ctx.mcp.transform((editor) => {
          if (!capturedDisabled) {
            explicitlyDisabled = new Set(
              editor
                .list()
                .filter(([, config]) => config.disabled === true)
                .map(([name]) => name),
            );
            capturedDisabled = true;
          }
          serverSnapshots = snapshotServers(editor);
          applyProtection(editor, parsed.adapter, {
            ...state,
            explicitlyDisabled,
            remoteHandles: remote.handles,
          });
        });

        const failClosed = Effect.gen(function* () {
          setState({ ready: false, environment: {}, remoteHandles: remote.handles });
          yield* remote.stopAll;
          yield* ctx.mcp.reload();
        });
        const observeReady = lease.ensureReady.pipe(
          Effect.flatMap((result) =>
            Effect.gen(function* () {
              if (result.status.generation <= observedGeneration) return;
              yield* reconcileRemote(result.status, result.environment);
              observedGeneration = result.status.generation;
              yield* ctx.mcp.reload();
            }),
          ),
          Effect.catch(() => failClosed),
        );
        const observeChanges = Effect.gen(function* () {
          const subscription = yield* lease.subscribe;
          yield* Stream.runForEach(subscription.changes, (status) =>
            status.phase === "ready"
              ? lease.environment.pipe(
                  Effect.flatMap((environment) =>
                    status.generation > observedGeneration
                      ? Effect.gen(function* () {
                          yield* reconcileRemote(status, environment);
                          observedGeneration = status.generation;
                          yield* ctx.mcp.reload();
                        })
                      : Effect.void,
                  ),
                )
              : failClosed,
          );
        });
        yield* Effect.forkScoped(observeReady);
        yield* Effect.forkScoped(observeChanges.pipe(Effect.catch(() => Effect.void)));
        yield* ctx.mcp.reload();

        const explicitRecovery = (operation: "refresh" | "doctor") =>
          Effect.gen(function* () {
            const status = yield* lease.status;
            if (status.phase === "failed") {
              yield* failClosed;
              return yield* registry.retry(factory, brokerOptions) as Effect.Effect<
                { readonly status: SafeStatus; readonly environment: ResolvedEnvironment },
                import("./contracts.js").VarlockError,
                never
              >;
            }
            if (status.phase === "starting") return yield* lease.ensureReady;
            return yield* operation === "refresh" ? lease.refreshReady : lease.ensureReady;
          });

        yield* ctx.rpc.register(KeyFerryRpc, {
          status: () => lease.status.pipe(Effect.map(publicStatus)),
          refresh: (_, context) =>
            Effect.gen(function* () {
              setState({ ready: false, environment: {}, remoteHandles: remote.handles });
              yield* remote.stopAll;
              yield* ctx.mcp.reload();
              const next = yield* explicitRecovery("refresh");
              yield* reconcileRemote(next.status, next.environment);
              yield* ctx.mcp.reload();
              return publicStatus(next.status);
            }).pipe(
              Effect.catch((error) =>
                Effect.sync(() => {
                  remoteDiagnostics = remote.diagnostics;
                  setState({ ready: false, environment: {}, remoteHandles: remote.handles });
                }).pipe(
                  Effect.andThen(ctx.mcp.reload()),
                  Effect.andThen(
                    Effect.fail(
                      context.error("unavailable", publicMessage(error), rpcError(error)),
                    ),
                  ),
                ),
              ),
            ),
          doctor: (_, context) =>
            Effect.gen(function* () {
              const next = yield* explicitRecovery("doctor").pipe(
                Effect.map(({ status, environment }) => ({
                  status: sanitizeStatus(status),
                  environment,
                })),
                Effect.catch((error) =>
                  lease.status.pipe(
                    Effect.map((status) => ({
                      status: sanitizeStatus({ ...status, error }),
                      environment: {},
                    })),
                  ),
                ),
              );
              yield* reconcileRemote(next.status, next.environment);
              yield* ctx.mcp.reload();
              return publicStatus(next.status);
            }).pipe(
              Effect.catch((error) =>
                Effect.fail(context.error("unavailable", publicMessage(error), rpcError(error))),
              ),
            ),
        });

        const clearProtection = Effect.gen(function* () {
          setState({ ready: false, environment: {}, remoteHandles: remote.handles });
          yield* remote.stopAll;
          yield* ctx.mcp.reload();
        });
        const reconcileGeneration = (status: SafeStatus) =>
          Effect.gen(function* () {
            yield* remote.stopAll;
            const next = yield* lease.ensureReady.pipe(
              Effect.map(({ status, environment }) => ({
                status: sanitizeStatus(status),
                environment,
              })),
            );
            observedGeneration = next.status.generation;
            if (next.status.phase === "ready") {
              yield* Effect.provideService(
                remote.reconcile(
                  serverSnapshots,
                  parsed.adapter.servers,
                  next.environment,
                  next.status.generation,
                ),
                Scope.Scope,
                pluginScope,
              );
              remoteDiagnostics = remote.diagnostics;
            }
            setState({
              ready: next.status.phase === "ready",
              environment: next.environment,
              remoteHandles: remote.handles,
            });
            yield* ctx.mcp.reload();
          });

        // The manager owns process health. Poll only safe metadata and disable
        // protected servers immediately if the owned process dies. A changed
        // generation gets a fresh, allowlisted environment before reconnecting.
        yield* Effect.forkScoped(
          Effect.forever(
            Effect.gen(function* () {
              yield* Effect.sleep("30 seconds");
              const status = yield* lease.status;
              const relayHealthy = yield* status.phase !== "ready"
                ? Effect.succeed(false)
                : remote.health;
              const decision = healthPollDecision(
                status.phase,
                state.ready,
                remote.handles.size,
                relayHealthy,
                status.generation,
                observedGeneration,
              );
              const action = {
                noop: Effect.void,
                clear: clearProtection,
                reconcile: reconcileGeneration(status).pipe(Effect.catch(() => Effect.void)),
              } satisfies Record<HealthPollDecision, Effect.Effect<void>>;
              yield* action[decision];
            }),
          ).pipe(Effect.catch(() => Effect.void)),
        );
        yield* Effect.addFinalizer(() => remote.stopAll);
      });
      return program.pipe(Effect.catch(() => Effect.void));
    },
  });
}
