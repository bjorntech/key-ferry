import { Mcp, Plugin } from "@opencode/plugin/effect";
import { Effect, Scope, Types } from "effect";
import type {
  ProjectKeyFerryManagerFactory,
  ProjectKeyFerryManagerService,
  ResolvedEnvironment,
  SafeStatus,
} from "./contracts.js";
import { ProjectKeyFerryManager } from "./contracts.js";
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
      const handle = state.remoteHandles?.get(name);
      editor.update(name, (config) => {
        if (config.type !== "remote" || config.oauth !== false || !state.ready || !handle) {
          config.disabled = true;
          return;
        }
        const headers = safeForwardHeaders(config.headers, mapping);
        if (headers === undefined) {
          config.disabled = true;
          return;
        }
        config.url = handle.localUrl;
        config.headers = { ...headers, [RELAY_AUTH_HEADER]: handle.downstreamToken };
        // Preserve an intentional user disablement. The transformed config is
        // never allowed to enable a server disabled in project configuration.
        if (server.disabled !== true) config.disabled = false;
      });
      continue;
    }
    if (server.type !== "local") {
      editor.update(name, (config) => {
        config.disabled = true;
      });
      continue;
    }
    const resolved: Record<string, string> = Object.create(null) as Record<string, string>;
    let complete = state.ready;
    for (const [outputName, sourceName] of Object.entries(mapping)) {
      const value = state.environment[sourceName];
      if (value === undefined) complete = false;
      else resolved[outputName] = value;
    }
    editor.update(name, (config) => {
      if (config.type !== "local") {
        config.disabled = true;
        return;
      }
      if (!complete) {
        config.disabled = true;
        return;
      }
      config.environment = { ...(config.environment ?? {}), ...resolved };
      // Preserve an intentional user disablement. Protection never enables a
      // server that was explicitly disabled in project configuration.
      if (server.disabled !== true) config.disabled = false;
    });
  }
}

const ensureState = (manager: ProjectKeyFerryManagerService) =>
  manager
    .withExclusive(
      Effect.gen(function* () {
        const status = yield* manager.ensureStarted;
        const environment = yield* manager.environment;
        return { status: sanitizeStatus(status), environment };
      }),
    )
    .pipe(
      Effect.catch((error) =>
        manager.status.pipe(
          Effect.map((status) => ({
            status: sanitizeStatus({ ...status, error }),
            environment: {},
          })),
        ),
      ),
    );

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

/** Construct the native OpenCode V2 plugin. The real manager is injected later. */
export function makePlugin(
  factory: ProjectKeyFerryManagerFactory,
  relayFactory?: RemoteRelayFactory,
): Plugin.Plugin {
  return Plugin.define({
    id: "key-ferry",
    effect: (ctx) => {
      const parsed = parseOptions(ctx.options, ctx.location.project.directory);
      if (!parsed.enabled) return Effect.void;
      const program = Effect.gen(function* () {
        const pluginScope = yield* Effect.scope;
        const manager = yield* ProjectKeyFerryManager;
        let state: ProtectionState = { ready: false, environment: {} };
        let observedGeneration = -1;
        let remoteDiagnostics: readonly RemoteDiagnostic[] = [];
        let serverSnapshots: ReadonlyMap<string, RemoteServerSnapshot> = new Map();
        const remote = makeRemoteRelayCoordinator(relayFactory, parsed.adapter.allowPrivateNetwork);
        const setState = (next: ProtectionState) => {
          state = next;
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
          serverSnapshots = snapshotServers(editor);
          applyProtection(editor, parsed.adapter, { ...state, remoteHandles: remote.handles });
        });

        const initial = yield* ensureState(manager);
        yield* reconcileRemote(initial.status, initial.environment);
        observedGeneration = initial.status.generation;
        yield* ctx.mcp.reload();

        yield* ctx.rpc.register(KeyFerryRpc, {
          status: () => manager.status.pipe(Effect.map(publicStatus)),
          refresh: (_, context) =>
            manager.withExclusive(
              Effect.gen(function* () {
                yield* remote.stopAll;
                setState({ ready: false, environment: {}, remoteHandles: remote.handles });
                yield* ctx.mcp.reload();
                const status = yield* manager.refresh;
                const environment = yield* manager.environment;
                yield* reconcileRemote(status, environment);
                yield* ctx.mcp.reload();
                return publicStatus(status);
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
            ),
          doctor: (_, context) =>
            manager.withExclusive(
              Effect.gen(function* () {
                const next = yield* ensureState(manager);
                yield* reconcileRemote(next.status, next.environment);
                yield* ctx.mcp.reload();
                return publicStatus(next.status);
              }).pipe(
                Effect.catch((error) =>
                  Effect.fail(context.error("unavailable", publicMessage(error), rpcError(error))),
                ),
              ),
            ),
        });

        // The manager owns process health. Poll only safe metadata and disable
        // protected servers immediately if the owned process dies. A changed
        // generation gets a fresh, allowlisted environment before reconnecting.
        yield* Effect.forkScoped(
          Effect.forever(
            Effect.gen(function* () {
              yield* Effect.sleep("30 seconds");
              const status = yield* manager.status;
              if (status.phase !== "ready") {
                if (state.ready || remote.handles.size > 0) {
                  yield* remote.stopAll;
                  setState({ ready: false, environment: {}, remoteHandles: remote.handles });
                  yield* ctx.mcp.reload();
                }
                return;
              }
              const relayHealthy = yield* remote.health;
              if (!relayHealthy) {
                yield* remote.stopAll;
                setState({ ready: false, environment: {}, remoteHandles: remote.handles });
                yield* ctx.mcp.reload();
                return;
              }
              if (status.generation === observedGeneration && state.ready) return;
              yield* remote.stopAll;
              const next = yield* ensureState(manager);
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
            }),
          ).pipe(Effect.catch(() => Effect.void)),
        );
        yield* Effect.addFinalizer(() => remote.stopAll);
      });
      return Effect.provide(
        program,
        factory.layer(managerOptions(parsed, ctx.location.project.directory)),
      ).pipe(Effect.catch(() => Effect.void));
    },
  });
}
