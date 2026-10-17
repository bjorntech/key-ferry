import { Effect, Exit, Scope, Stream } from "effect";
import type { BrokerLease, BrokerRegistry } from "./broker-registry.js";
import type {
  ProjectKeyFerryManagerFactory,
  ResolvedEnvironment,
  SafeStatus,
  ScopeId,
} from "./contracts.js";
import { VarlockError } from "./contracts.js";
import { type McpEditor } from "./plugin.js";
import type { ManagedEnvironmentState } from "./plugin.js";
import {
  makeRemoteRelayCoordinator,
  type RemoteRelayFactory,
  type RemoteServerSnapshot,
} from "./remote.js";
import type { ScopedConfiguration, ScopedGroup } from "./scoped-config.js";
import {
  aggregatePhase,
  applyRuntimeProtection,
  captureEditor,
  cleanManagedEnvironment,
  configurationFingerprint,
  emptyProtectionState,
  filterGroupMappings,
  groupStatus,
  projectFallback,
  runtimeEnvironment,
  selectRuntime,
  disableProjectServers,
  selectedStatus,
  statusBase,
  statusScopes,
} from "./scopes/controller-helpers.js";
import type { Runtime } from "./scopes/controller-types.js";

function projectNames(configuration: ScopedConfiguration, runtime?: Runtime): Set<string> {
  const names = new Set(
    Object.keys(configuration.project?.servers ?? {}).filter(
      (name) => configuration.bindings[name] === "project",
    ),
  );
  if (runtime) for (const name of Object.keys(runtime.mappings)) names.add(name);
  return names;
}

function inactiveNames(names: Set<string>, next: ScopedConfiguration): Set<string> {
  return new Set([...names].filter((name) => next.bindings[name] === undefined));
}

function runtimeIsCurrent(
  runtime: Runtime,
  runtimes: Map<ScopeId, Runtime>,
  expectedEpoch: number,
): boolean {
  return runtime.active && runtime.epoch === expectedEpoch && runtimes.get(runtime.id) === runtime;
}

export interface ScopedControllerOptions {
  readonly configuration: ScopedConfiguration;
  readonly factory: ProjectKeyFerryManagerFactory;
  readonly relayFactory?: RemoteRelayFactory;
  readonly registry: BrokerRegistry;
  readonly scope: Scope.Scope;
  readonly reload: () => Effect.Effect<void>;
  readonly watchIntervalMs?: number;
  readonly startEmptyGlobal?: boolean;
}

/** Coordinates independent manager/relay lifecycles without merging scopes. */
export function makeScopedController(options: ScopedControllerOptions) {
  const runtimes = new Map<ScopeId, Runtime>();
  let configuration = options.configuration;
  const pristine = new Map<string, RemoteServerSnapshot>();
  const pristineEnvironment = new Map<string, Readonly<Record<string, string>>>();
  const managedEnvironment = new Map<string, Map<string, ManagedEnvironmentState>>();
  const lastInjected = new Map<string, Record<string, string>>();
  let explicitlyDisabled = new Set<string>();
  let captured = false;
  let inactiveProjectNames = new Set<string>();

  const capture = (nextEditor: McpEditor) => {
    if (captured) return;
    captured = true;
    const snapshot = captureEditor(nextEditor);
    explicitlyDisabled = snapshot.disabled;
    for (const [name, value] of snapshot.remote) pristine.set(name, value);
    for (const [name, value] of snapshot.environments) pristineEnvironment.set(name, value);
  };

  const cleanupManagedEnvironment = (nextEditor: McpEditor) =>
    cleanManagedEnvironment(nextEditor, managedEnvironment, lastInjected, pristineEnvironment);

  const rememberManagedEnvironment = (nextEditor: McpEditor, runtime: Runtime) =>
    runtimeEnvironment(nextEditor, runtime, pristineEnvironment, managedEnvironment, lastInjected);

  const removeUnboundManaged = () => {
    const bound = new Set(
      [...runtimes.values()].flatMap((runtime) => Object.keys(runtime.mappings)),
    );
    for (const [name, entries] of managedEnvironment) {
      if (bound.has(name)) continue;
      managedEnvironment.delete(name);
      lastInjected.delete(name);
    }
  };

  const projectStatus = () => {
    const runtime = runtimes.get("project");
    if (runtime) return groupStatus(runtime, configuration.activation);
    return projectFallback(configuration);
  };

  // Called only from the active mcp.transform callback. The editor is a draft
  // owned by that callback and is never retained by the controller.
  const apply = (editor: McpEditor) => {
    capture(editor);
    cleanupManagedEnvironment(editor);
    removeUnboundManaged();
    for (const runtime of runtimes.values()) {
      applyRuntimeProtection(editor, runtime, explicitlyDisabled);
      rememberManagedEnvironment(editor, runtime);
    }
    const project = projectStatus();
    if (project && !runtimes.has("project"))
      disableProjectServers(editor, configuration, inactiveProjectNames);
    else
      for (const name of inactiveProjectNames)
        editor.update(name, (config) => {
          config.disabled = true;
        });
  };

  const safeFailure = (error: unknown, code: "unavailable" | "start_failed" | "refresh_failed") =>
    error instanceof VarlockError
      ? error
      : new VarlockError({
          code,
          message: "Key Ferry manager operation failed",
          retryable: true,
        });

  const rememberFailure = (
    runtime: Runtime,
    error: unknown,
    code: "unavailable" | "start_failed" | "refresh_failed" = "start_failed",
  ) => {
    runtime.status = {
      phase: "failed",
      projectDirectory: runtime.group.sourceRoot,
      generation: runtime.status?.generation ?? 0,
      ...(runtime.status?.pid === undefined ? {} : { pid: runtime.status.pid }),
      error: safeFailure(error, code),
    };
    runtime.state = emptyProtectionState();
  };

  const clear = (runtime: Runtime, phase: "starting" | "failed" = "starting") =>
    Effect.gen(function* () {
      if (!runtime.active) return;
      runtime.epoch += 1;
      const previous = runtime.status;
      runtime.status = {
        phase,
        projectDirectory: runtime.group.sourceRoot,
        generation: runtime.status?.generation ?? 0,
        ...(previous?.error === undefined ? {} : { error: previous.error }),
      };
      runtime.state = emptyProtectionState();
      yield* runtime.remote.stopAll;
      yield* options.reload();
    });

  const reconcileRemote = (
    runtime: Runtime,
    status: SafeStatus,
    environment: ResolvedEnvironment,
  ) =>
    status.phase === "ready"
      ? Effect.provideService(
          runtime.remote.reconcile(
            new Map(
              Object.keys(runtime.mappings)
                .map((name) => [name, pristine.get(name)] as const)
                .filter(
                  (entry): entry is readonly [string, RemoteServerSnapshot] =>
                    entry[1] !== undefined,
                ),
            ),
            runtime.mappings,
            environment,
            status.generation,
          ),
          Scope.Scope,
          options.scope,
        )
      : runtime.remote.stopAll;

  const reconcile = (
    runtime: Runtime,
    status: SafeStatus,
    environment: ResolvedEnvironment,
    expectedEpoch = runtime.epoch,
  ) =>
    Effect.gen(function* () {
      if (!runtime.active || runtime.epoch !== expectedEpoch) return;
      runtime.status = status;
      yield* reconcileRemote(runtime, status, environment);
      if (!runtimeIsCurrent(runtime, runtimes, expectedEpoch)) {
        yield* runtime.remote.stopAll;
        return;
      }
      runtime.state = {
        ready: status.phase === "ready",
        environment,
        remoteHandles: runtime.remote.handles,
        explicitlyDisabled,
      };
      runtime.observedGeneration = status.generation;
      yield* options.reload();
    });

  const startObserver = (runtime: Runtime) =>
    runtime.lease
      ? Effect.suspend(() => {
          const epoch = runtime.epoch;
          const lease = runtime.lease!;
          return lease.ensureReady.pipe(
            Effect.flatMap(({ status, environment }) =>
              runtime.active ? reconcile(runtime, status, environment, epoch) : Effect.void,
            ),
            Effect.catch((error: unknown) =>
              Effect.gen(function* () {
                if (!runtime.active) return;
                rememberFailure(runtime, error);
                yield* clear(runtime, "failed");
              }),
            ),
            Effect.forkIn(runtime.scope),
          );
        })
      : Effect.void;

  const subscribeRuntime = (runtime: Runtime) =>
    Effect.gen(function* () {
      const lease = runtime.lease;
      if (!lease) return;
      const subscription = yield* lease.subscribe;
      yield* Stream.runForEach(subscription.changes, (next) =>
        !runtime.active || runtime.transitioning
          ? Effect.void
          : next.phase === "ready"
            ? Effect.gen(function* () {
                const epoch = runtime.epoch;
                const environment = yield* lease.environment;
                if (runtime.active && next.generation >= runtime.observedGeneration)
                  yield* reconcile(runtime, next, environment, epoch);
              })
            : clear(runtime, next.phase === "failed" ? "failed" : "starting"),
      );
    }).pipe(Effect.catch(() => Effect.void));

  const heartbeat = (runtime: Runtime) =>
    Effect.sleep("30 seconds").pipe(Effect.andThen(heartbeatAfterSleep(runtime)));

  const heartbeatAfterSleep = (runtime: Runtime) => {
    const lease = runtime.lease;
    if (!(lease && runtime.active)) return Effect.void;
    return lease.status.pipe(Effect.flatMap((current) => heartbeatStatus(runtime, lease, current)));
  };

  const heartbeatReady = (runtime: Runtime, lease: BrokerLease, current: SafeStatus) =>
    Effect.gen(function* () {
      if (!(yield* runtime.remote.health)) return yield* clear(runtime);
      yield* heartbeatGeneration(runtime, lease, current);
    });

  const heartbeatGeneration = (runtime: Runtime, lease: BrokerLease, current: SafeStatus) =>
    current.generation <= runtime.observedGeneration
      ? Effect.void
      : Effect.gen(function* () {
          const epoch = runtime.epoch;
          const environment = yield* lease.environment;
          yield* reconcile(runtime, current, environment, epoch);
        });

  const heartbeatStatus = (runtime: Runtime, lease: BrokerLease, current: SafeStatus) =>
    current.phase !== "ready"
      ? clear(runtime, current.phase === "failed" ? "failed" : "starting")
      : heartbeatReady(runtime, lease, current);

  const acquire = (group: ScopedGroup) =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const runtime: Runtime = {
        id: group.id,
        group,
        lease: undefined,
        remote: makeRemoteRelayCoordinator(
          options.relayFactory,
          group.options.adapter.allowPrivateNetwork,
        ),
        mappings: filterGroupMappings(group, configuration.bindings),
        state: emptyProtectionState(),
        observedGeneration: -1,
        active: true,
        scope,
        epoch: 0,
        transitioning: false,
      };
      runtimes.set(group.id, runtime);
      const lease = yield* options.registry.acquire(options.factory, group.manager).pipe(
        Effect.map((value) => value as BrokerLease),
        Effect.catch((error: unknown) =>
          Effect.sync(() => {
            runtime.status = {
              phase: "failed",
              projectDirectory: group.sourceRoot,
              generation: 0,
              error:
                error instanceof VarlockError
                  ? error
                  : new VarlockError({
                      code: "unavailable",
                      message: "Key Ferry manager is unavailable",
                      retryable: true,
                    }),
            };
          }).pipe(Effect.as(undefined)),
        ),
      );
      if (lease) {
        runtime.lease = lease;
        yield* startObserver(runtime);
        yield* subscribeRuntime(runtime).pipe(Effect.forkIn(runtime.scope));
      }
      yield* Effect.forever(heartbeat(runtime)).pipe(
        Effect.catch(() => Effect.void),
        Effect.forkIn(runtime.scope),
      );
      return runtime;
    });

  const start = Effect.gen(function* () {
    if (options.startEmptyGlobal || Object.keys(configuration.global.servers).length > 0)
      yield* acquire(configuration.global);
    if (configuration.project && configuration.activation === "auto")
      yield* acquire(configuration.project);
  });

  const selected = (selector?: {
    readonly scope?: "global" | "project";
    readonly server?: string;
  }) => selectRuntime(runtimes, configuration.bindings, selector);

  const status = Effect.sync((): SafeStatus => {
    const global = runtimes.get("global");
    const project = projectStatus();
    const base = statusBase(global, project, configuration);
    if (!project && configuration.diagnostics.length === 0) return base;
    const scopes = statusScopes(global, project);
    const aggregate = aggregatePhase(base.phase, scopes);
    return {
      ...base,
      phase: aggregate,
      scopes,
      bindings: configuration.bindings,
      ...(configuration.diagnostics.length === 0 ? {} : { diagnostics: configuration.diagnostics }),
    };
  });

  const statusSelected = (selector?: { readonly scope?: ScopeId; readonly server?: string }) =>
    Effect.sync((): SafeStatus => {
      if (!selector?.scope && !selector?.server) return Effect.runSync(status);
      return selectedStatus(selected(selector), configuration, selector);
    });

  const acquireForOperation = (runtime: Runtime, kind: "refresh" | "doctor") =>
    options.registry.acquire(options.factory, runtime.group.manager).pipe(
      Effect.map((value) => value as BrokerLease),
      Effect.catch((error: unknown) =>
        kind === "doctor"
          ? Effect.gen(function* () {
              rememberFailure(runtime, error, "unavailable");
              yield* options.reload();
            }).pipe(Effect.as(undefined))
          : Effect.fail(error),
      ),
    );

  const operationStarting = (runtime: Runtime, kind: "refresh" | "doctor", lease: BrokerLease) =>
    kind === "doctor"
      ? lease.ensureReady.pipe(
          Effect.catch((error: unknown) =>
            Effect.gen(function* () {
              rememberFailure(runtime, error);
              yield* options.reload();
            }),
          ),
        )
      : lease.ensureReady;

  const operationFailed = (runtime: Runtime, kind: "refresh" | "doctor") =>
    Effect.gen(function* () {
      yield* clear(runtime);
      if (kind === "doctor") {
        const epoch = runtime.epoch;
        const result = yield* options.registry.retry(options.factory, runtime.group.manager).pipe(
          Effect.catch((error) =>
            Effect.sync(() => {
              rememberFailure(runtime, error);
              return undefined;
            }),
          ),
        );
        if (!result) return;
        if (!runtimeIsCurrent(runtime, runtimes, epoch)) return;
        yield* reconcile(runtime, result.status, result.environment, epoch);
        yield* startObserver(runtime);
        return;
      }
      const epoch = runtime.epoch;
      const result = yield* options.registry
        .retry(options.factory, runtime.group.manager)
        .pipe(
          Effect.tapError((error) =>
            Effect.sync(() => rememberFailure(runtime, error, "refresh_failed")),
          ),
        );
      if (!runtimeIsCurrent(runtime, runtimes, epoch)) return;
      yield* reconcile(runtime, result.status, result.environment, epoch);
      yield* startObserver(runtime);
    });

  const operationRefresh = (runtime: Runtime, lease: BrokerLease) =>
    Effect.gen(function* () {
      yield* clear(runtime);
      const epoch = runtime.epoch;
      if (!runtimes.has("global")) {
        const nextStatus = yield* lease.refresh;
        const environment = yield* lease.environment;
        yield* reconcile(runtime, nextStatus, environment, epoch);
        return;
      }
      const result = yield* lease.refreshReady;
      yield* reconcile(runtime, result.status, result.environment, epoch);
    });

  const operationReady = (runtime: Runtime, lease: BrokerLease) =>
    Effect.gen(function* () {
      if (!(yield* runtime.remote.health)) yield* runtime.remote.stopAll;
      const epoch = runtime.epoch;
      const result = yield* lease.ensureReady;
      yield* reconcile(runtime, result.status, result.environment, epoch);
    });

  const prepareOperation = (runtime: Runtime, kind: "refresh" | "doctor") =>
    runtime.lease
      ? Effect.succeed({ lease: runtime.lease, acquired: false })
      : acquireForOperation(runtime, kind).pipe(
          Effect.flatMap((lease) => {
            if (!lease) return Effect.succeed(undefined);
            runtime.lease = lease;
            return startObserver(runtime).pipe(Effect.as({ lease, acquired: true }));
          }),
        );

  const operateCurrent = (runtime: Runtime, kind: "refresh" | "doctor", lease: BrokerLease) =>
    Effect.gen(function* () {
      const current = yield* lease.status;
      if (current.phase === "starting") {
        yield* operationStarting(runtime, kind, lease);
        return;
      }
      if (current.phase === "failed") return yield* operationFailed(runtime, kind);
      if (kind === "refresh") return yield* operationRefresh(runtime, lease);
      yield* operationReady(runtime, lease);
    });

  const operation = (
    kind: "refresh" | "doctor",
    selector?: { readonly scope?: ScopeId; readonly server?: string },
  ) =>
    Effect.gen(function* () {
      const runtime = selected(selector);
      if (!runtime) return yield* status;
      runtime.transitioning = true;
      return yield* Effect.gen(function* () {
        const prepared = yield* prepareOperation(runtime, kind);
        if (!prepared || (kind === "doctor" && prepared.acquired)) return yield* status;
        yield* operateCurrent(runtime, kind, prepared.lease).pipe(
          Effect.tapError((error) =>
            Effect.sync(() => rememberFailure(runtime, error, "refresh_failed")),
          ),
        );
        return yield* status;
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            runtime.transitioning = false;
          }),
        ),
      );
    });

  const activateProject = Effect.gen(function* () {
    if (!configuration.project) return yield* status;
    const existing = runtimes.get("project");
    if (existing) return yield* status;
    yield* acquire(configuration.project);
    return yield* status;
  });

  const retireProject = (runtime: Runtime) =>
    Effect.gen(function* () {
      const previousNames = new Set(Object.keys(runtime.mappings));
      runtime.active = false;
      runtime.epoch += 1;
      runtime.status = {
        phase: "stopped",
        projectDirectory: runtime.group.sourceRoot,
        generation: runtime.status?.generation ?? 0,
      };
      runtime.state = emptyProtectionState();
      runtimes.delete("project");
      inactiveProjectNames = previousNames;
      yield* options.reload();
      yield* runtime.remote.stopAll;
      if (runtime.lease) yield* runtime.lease.release;
      yield* Scope.close(runtime.scope, Exit.void);
    });

  const updateProjectConfiguration = (next: ScopedConfiguration) => {
    const global = runtimes.get("global");
    if (global) {
      global.transitioning = true;
      global.mappings = filterGroupMappings(global.group, next.bindings);
    }
    return global;
  };

  const replaceProject = (next: ScopedConfiguration) =>
    Effect.gen(function* () {
      const previous = runtimes.get("project");
      const previousNames = projectNames(configuration, previous);
      configuration = next;
      if (previous) yield* retireProject(previous);
      inactiveProjectNames = inactiveNames(previousNames, next);
      const global = updateProjectConfiguration(next);
      if (next.project && next.activation === "auto") yield* acquire(next.project);
      yield* options.reload();
      if (global) global.transitioning = false;
    });

  /** Polls semantic configuration, so comment-only edits do not reauthenticate. */
  const watch = (load: () => Promise<ScopedConfiguration>) =>
    Effect.forkIn(
      Effect.gen(function* () {
        let previous = configurationFingerprint(configuration);
        while (true) {
          yield* Effect.sleep(options.watchIntervalMs ?? 250);
          const next = yield* Effect.promise(load);
          const current = configurationFingerprint(next);
          if (current === previous) continue;
          previous = current;
          yield* replaceProject(next);
        }
      }).pipe(Effect.catch(() => Effect.void)),
      options.scope,
    );

  const dispose = Effect.suspend(() =>
    Effect.forEach(
      [...runtimes.values()],
      (runtime) => {
        runtime.active = false;
        runtime.epoch += 1;
        runtime.status = {
          phase: "stopped",
          projectDirectory: runtime.group.sourceRoot,
          generation: runtime.status?.generation ?? 0,
        };
        return runtime.remote.stopAll.pipe(
          Effect.andThen(runtime.lease ? runtime.lease.release : Effect.void),
          Effect.andThen(Scope.close(runtime.scope, Exit.void)),
        );
      },
      { concurrency: "unbounded" },
    ).pipe(Effect.asVoid),
  );

  return {
    start,
    capture,
    apply,
    status,
    statusSelected,
    operation,
    activateProject,
    replaceProject,
    watch,
    dispose,
    runtimes,
  };
}
