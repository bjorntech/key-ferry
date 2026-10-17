import { realpath } from "node:fs/promises";
import {
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  PubSub,
  Scope,
  Semaphore,
  Stream,
} from "effect";
import {
  ProjectKeyFerryManager,
  type ProjectKeyFerryManagerFactory,
  type ProjectKeyFerryManagerOptions,
  type ProjectKeyFerryManagerService,
  type ResolvedEnvironment,
  type SafeStatus,
  VarlockError,
} from "./contracts.js";

export interface BrokerSubscription {
  readonly current: Effect.Effect<SafeStatus>;
  readonly changes: Stream.Stream<SafeStatus>;
}

export interface BrokerLease extends ProjectKeyFerryManagerService {
  readonly subscribe: Effect.Effect<BrokerSubscription>;
  readonly release: Effect.Effect<void>;
}

export interface BrokerRegistryOptions {
  readonly canonicalize?: (directory: string) => Effect.Effect<string, unknown>;
  readonly maxEntries?: number;
}

type BrokerResult = { readonly status: SafeStatus; readonly environment: ResolvedEnvironment };
type Entry = {
  key: string;
  options: ProjectKeyFerryManagerOptions;
  factory: ProjectKeyFerryManagerFactory<any>;
  scope: Scope.Closeable;
  events: PubSub.PubSub<SafeStatus>;
  ready: Deferred.Deferred<BrokerResult, VarlockError>;
  leases: Set<symbol>;
  manager?: ProjectKeyFerryManagerService;
  startup?: Fiber.Fiber<BrokerResult, VarlockError>;
  attempt?: Deferred.Deferred<BrokerResult, VarlockError>;
  attemptPending?: boolean;
  refresh?: Deferred.Deferred<BrokerResult, VarlockError>;
  closing?: Deferred.Deferred<void>;
  status?: SafeStatus;
  failure?: VarlockError;
  readinessRevision: number;
  disposed: boolean;
};

const adapterKeys = new Set([
  "command",
  "environmentKeys",
  "startupTimeoutMs",
  "commandTimeoutMs",
  "reloadTimeoutMs",
  "pollIntervalMs",
  "requireStrictEgress",
]);

function safeError(error: unknown, code: "start_failed" | "refresh_failed" | "disposed") {
  if (error instanceof VarlockError) return error;
  return new VarlockError({
    code,
    message: "Key Ferry manager operation failed",
    retryable: code !== "disposed",
  });
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

function adapterOf(options: ProjectKeyFerryManagerOptions): Record<string, unknown> {
  if (!options.adapter || typeof options.adapter !== "object")
    throw new TypeError("manager adapter options are required");
  return options.adapter as Record<string, unknown>;
}

function validateAdapterKeys(adapter: Record<string, unknown>): void {
  for (const key of Object.keys(adapter))
    if (!adapterKeys.has(key)) throw new TypeError(`unsupported manager option: ${key}`);
}

function validateAdapterShape(adapter: Record<string, unknown>): void {
  if (!Array.isArray(adapter.command) || !Array.isArray(adapter.environmentKeys))
    throw new TypeError("invalid manager adapter options");
  if (adapter.environmentKeys.some((key) => typeof key !== "string"))
    throw new TypeError("environmentKeys must be strings");
}

function validateOptions(options: ProjectKeyFerryManagerOptions): Record<string, unknown> {
  const adapter = adapterOf(options);
  validateAdapterKeys(adapter);
  validateAdapterShape(adapter);
  return adapter;
}

function keyFor(directory: string, options: ProjectKeyFerryManagerOptions): string {
  const adapter = validateOptions(options);
  return stable({
    projectDirectory: directory,
    owner: options.owner,
    sessionID: options.sessionID,
    command: adapter.command,
    environmentKeys: [...new Set(adapter.environmentKeys as string[])].sort(),
    startupTimeoutMs: adapter.startupTimeoutMs,
    commandTimeoutMs: adapter.commandTimeoutMs,
    reloadTimeoutMs: adapter.reloadTimeoutMs,
    pollIntervalMs: adapter.pollIntervalMs,
    requireStrictEgress: adapter.requireStrictEgress,
  });
}

function readinessChanged(entry: Entry, revision: number, ready: Entry["ready"]): boolean {
  return revision !== entry.readinessRevision || ready !== entry.ready;
}

function awaitRefresh(
  entry: Entry,
  revision: number,
  ready: Entry["ready"],
  refresh: NonNullable<Entry["refresh"]>,
): Effect.Effect<BrokerResult, VarlockError> {
  return Effect.gen(function* () {
    const refreshed = yield* Deferred.await(refresh);
    if (!readinessChanged(entry, revision, ready) && entry.ready === refresh) return refreshed;
    return yield* awaitCurrentReady(entry);
  });
}

function awaitCurrentReady(entry: Entry): Effect.Effect<BrokerResult, VarlockError> {
  return Effect.gen(function* () {
    while (true) {
      const revision = entry.readinessRevision;
      const ready = entry.ready;
      const refresh = entry.refresh;
      const result = yield* Deferred.await(ready);
      if (readinessChanged(entry, revision, ready)) continue;
      if (!refresh) return result;
      return yield* awaitRefresh(entry, revision, ready, refresh);
    }
  });
}

/** A module-local broker; it deliberately does not communicate across processes. */
export function makeBrokerRegistry(configuration: BrokerRegistryOptions = {}) {
  const entries = new Set<Entry>();
  const factories = new WeakMap<object, Map<string, Entry>>();
  const lock = Effect.runSync(Semaphore.make(1));
  const canonicalize =
    configuration.canonicalize ??
    ((directory: string) => Effect.tryPromise(() => realpath(directory)));
  const maxEntries = configuration.maxEntries ?? 128;

  const publish = (entry: Entry, status: SafeStatus) => {
    entry.status = status;
    return PubSub.publish(entry.events, status);
  };

  const start = (entry: Entry): Effect.Effect<BrokerResult, VarlockError> => {
    const operation: Effect.Effect<BrokerResult, VarlockError, any> = Effect.gen(function* () {
      const context = yield* Layer.build(entry.factory.layer(entry.options)).pipe(
        Effect.provideService(Scope.Scope, entry.scope),
      );
      const manager = Context.get(context, ProjectKeyFerryManager);
      entry.manager = manager;
      const result = yield* manager.ensureReady;
      yield* publish(entry, result.status);
      return result;
    });
    return operation.pipe(
      Effect.catch((error: unknown) => {
        const failure = safeError(error, "start_failed");
        entry.failure = failure;
        return publish(entry, {
          phase: "failed",
          projectDirectory: entry.options.projectDirectory,
          generation: entry.status?.generation ?? 0,
          error: failure,
        }).pipe(Effect.flatMap(() => Effect.fail(failure)));
      }),
    ) as Effect.Effect<BrokerResult, VarlockError>;
  };

  const ensure = (entry: Entry): Effect.Effect<BrokerResult, VarlockError> =>
    Effect.gen(function* () {
      if (entry.failure) return yield* Effect.fail(entry.failure);
      if (!entry.startup) {
        entry.startup = yield* start(entry).pipe(Effect.forkDetach);
        yield* Deferred.await(entry.ready).pipe(Effect.ignore);
      }
      return yield* awaitCurrentReady(entry);
    });

  const completeStartup = (entry: Entry, target: Deferred.Deferred<BrokerResult, VarlockError>) =>
    Fiber.join(entry.startup!).pipe(
      Effect.flatMap((result) => Deferred.succeed(target, result)),
      Effect.catch((error: unknown) => Deferred.fail(target, safeError(error, "start_failed"))),
      Effect.tap(() =>
        Effect.sync(() => {
          entry.attemptPending = false;
        }),
      ),
      Effect.forkDetach,
    );

  const refreshShared = (entry: Entry): Effect.Effect<BrokerResult, VarlockError> =>
    Effect.gen(function* () {
      if (entry.failure) return yield* Effect.fail(entry.failure);
      yield* Deferred.await(entry.ready);
      const deferred = yield* lock.withPermit(
        Effect.gen(function* () {
          if (entry.refresh) return entry.refresh;
          const next = yield* Deferred.make<BrokerResult, VarlockError>();
          entry.refresh = next;
          entry.readinessRevision += 1;
          yield* publish(entry, {
            phase: "starting",
            projectDirectory: entry.options.projectDirectory,
            generation: entry.status?.generation ?? 0,
          });
          yield* Effect.gen(function* () {
            const result = yield* entry.manager!.refreshReady;
            yield* publish(entry, result.status);
            yield* Deferred.succeed(next, result);
            entry.ready = next;
            entry.refresh = undefined;
          }).pipe(
            Effect.catch((error: unknown) => {
              const failure = safeError(error, "refresh_failed");
              entry.failure = failure;
              entry.refresh = undefined;
              return publish(entry, {
                phase: "failed",
                projectDirectory: entry.options.projectDirectory,
                generation: entry.status?.generation ?? 0,
                error: failure,
              }).pipe(Effect.flatMap(() => Deferred.fail(next, failure)));
            }),
            Effect.forkIn(entry.scope),
          );
          return next;
        }),
      );
      return yield* Deferred.await(deferred);
    });

  const getOrCreateEntry = <R>(
    factory: ProjectKeyFerryManagerFactory<R>,
    options: ProjectKeyFerryManagerOptions,
    directory: string,
  ): Effect.Effect<Entry> =>
    Effect.gen(function* () {
      const key = keyFor(directory, options);
      const factoryMap = factories.get(factory as object) ?? new Map<string, Entry>();
      factories.set(factory as object, factoryMap);
      const existing = factoryMap.get(key);
      if (existing) return existing;
      if (entries.size >= maxEntries)
        return yield* Effect.die(new Error("broker registry capacity reached"));
      const entry: Entry = {
        key,
        options: {
          ...options,
          projectDirectory: directory as ProjectKeyFerryManagerOptions["projectDirectory"],
        },
        factory,
        scope: yield* Scope.make(),
        events: yield* PubSub.unbounded<SafeStatus>({ replay: 1 }),
        ready: yield* Deferred.make<BrokerResult, VarlockError>(),
        leases: new Set(),
        readinessRevision: 0,
        disposed: false,
      };
      factoryMap.set(key, entry);
      entries.add(entry);
      return entry;
    });

  const disposeLeaseEntry = (
    entry: Entry,
    factoryMap: Map<string, Entry>,
    close: Deferred.Deferred<void>,
  ) =>
    Effect.gen(function* () {
      if (entry.startup) yield* Fiber.interrupt(entry.startup);
      if (entry.manager) yield* entry.manager.dispose;
      yield* Scope.close(entry.scope, Exit.void);
    }).pipe(
      Effect.catch(() => Effect.void),
      Effect.flatMap(() =>
        lock.withPermit(
          Effect.gen(function* () {
            if (entry.closing !== close) return;
            entry.manager = undefined;
            entry.startup = undefined;
            if (!entry.failure) {
              entries.delete(entry);
              factoryMap.delete(entry.key);
            }
            entry.closing = undefined;
            yield* Deferred.succeed(close, undefined);
          }),
        ),
      ),
    );

  const acquireAttempt = <R>(
    factory: ProjectKeyFerryManagerFactory<R>,
    options: ProjectKeyFerryManagerOptions,
  ) =>
    lock.withPermit(
      Effect.gen(function* () {
        const directory = yield* canonicalize(options.projectDirectory).pipe(
          Effect.mapError(() => new TypeError("project directory does not exist")),
        );
        const factoryMap = factories.get(factory as object) ?? new Map<string, Entry>();
        factories.set(factory as object, factoryMap);
        const entry = yield* getOrCreateEntry(factory, options, directory);
        if (entry.closing) return { waiting: entry.closing };
        const leaseID = Symbol();
        entry.leases.add(leaseID);
        if (!entry.startup && !entry.failure) {
          entry.attempt = entry.ready;
          entry.attemptPending = true;
          entry.startup = yield* start(entry).pipe(Effect.forkDetach);
          yield* completeStartup(entry, entry.ready);
        }
        let released = false;
        const managerEffect = <A, E, R>(
          operation: (manager: ProjectKeyFerryManagerService) => Effect.Effect<A, E, R>,
        ): Effect.Effect<A, E, R> =>
          Effect.gen(function* () {
            if (released) return yield* Effect.die(safeError(undefined, "disposed"));
            return yield* operation(entry!.manager!);
          });
        const release = Effect.gen(function* () {
          const close = yield* lock.withPermit(
            Effect.gen(function* () {
              if (released) return undefined;
              released = true;
              entry!.leases.delete(leaseID);
              if (entry!.leases.size !== 0 || entry!.disposed) return undefined;
              entry!.disposed = true;
              const deferred = yield* Deferred.make<void>();
              entry!.closing = deferred;
              yield* disposeLeaseEntry(entry!, factoryMap, deferred).pipe(Effect.forkDetach);
              return deferred;
            }),
          );
          if (close) yield* Deferred.await(close);
        });
        const leaseEnsure = Effect.gen(function* () {
          if (released) return yield* Effect.fail(safeError(undefined, "disposed"));
          return yield* ensure(entry!);
        });
        const lease: BrokerLease = {
          status: Effect.sync(
            () =>
              entry!.status ?? {
                phase: "starting",
                projectDirectory: directory as any,
                generation: 0,
              },
          ),
          ensureStarted: leaseEnsure.pipe(
            Effect.flatMap(() => managerEffect((manager) => manager.ensureStarted)),
          ) as any,
          ensureReady: leaseEnsure,
          environment: leaseEnsure.pipe(
            Effect.flatMap(() => managerEffect((manager) => manager.environment)),
          ) as any,
          refresh: refreshShared(entry).pipe(Effect.map(({ status }) => status)),
          refreshReady: refreshShared(entry),
          dispose: release,
          withExclusive: (effect) => managerEffect((manager) => manager.withExclusive(effect)),
          subscribe: Effect.succeed({
            current: Effect.sync(
              () =>
                entry!.status ?? {
                  phase: "starting",
                  projectDirectory: directory as any,
                  generation: 0,
                },
            ),
            changes: Stream.fromPubSub(entry.events),
          }),
          release,
        };
        return lease;
      }),
    );

  const acquire = <R>(
    factory: ProjectKeyFerryManagerFactory<R>,
    options: ProjectKeyFerryManagerOptions,
  ): Effect.Effect<BrokerLease, any, never> =>
    Effect.gen(function* () {
      const result = yield* acquireAttempt(factory, options);
      if ("waiting" in result) {
        yield* Deferred.await(result.waiting);
        return yield* acquire(factory, options);
      }
      return result;
    });

  const retryAttempt = (
    factory: ProjectKeyFerryManagerFactory<any>,
    options: ProjectKeyFerryManagerOptions,
  ): Effect.Effect<BrokerResult | { waiting: Deferred.Deferred<void> }, any, never> =>
    Effect.gen(function* () {
      const directory = yield* canonicalize(options.projectDirectory);
      const target = yield* lock.withPermit(
        Effect.gen(function* () {
          const entry = factories.get(factory as object)?.get(keyFor(directory, options));
          return yield* retryEntry(entry);
        }),
      );
      if ("waiting" in target) return target;
      return yield* Deferred.await(target);
    });

  const retry = (
    factory: ProjectKeyFerryManagerFactory<any>,
    options: ProjectKeyFerryManagerOptions,
  ): Effect.Effect<BrokerResult, any, never> =>
    Effect.gen(function* () {
      const result = yield* retryAttempt(factory, options);
      if ("waiting" in result) {
        yield* Deferred.await(result.waiting);
        return yield* retry(factory, options);
      }
      return result;
    });

  const retryEntry = (
    entry: Entry | undefined,
  ): Effect.Effect<
    Deferred.Deferred<BrokerResult, VarlockError> | { waiting: Deferred.Deferred<void> },
    any
  > => {
    if (!entry)
      return Effect.fail(
        new VarlockError({
          code: "not_ready",
          message: "No failed broker entry",
          retryable: false,
        }),
      );
    if (entry.closing) return Effect.succeed({ waiting: entry.closing });
    if (entry.attempt && entry.attemptPending) return Effect.succeed(entry.attempt);
    if (!entry.failure)
      return Effect.fail(
        new VarlockError({
          code: "not_ready",
          message: "No failed broker entry",
          retryable: false,
        }),
      );
    return Effect.gen(function* () {
      entry.failure = undefined;
      entry.disposed = false;
      entry.scope = yield* Scope.make();
      entry.manager = undefined;
      entry.ready = yield* Deferred.make<BrokerResult, VarlockError>();
      entry.attempt = entry.ready;
      entry.attemptPending = true;
      entry.startup = yield* start(entry).pipe(Effect.forkDetach);
      yield* completeStartup(entry, entry.ready);
      return entry.ready;
    });
  };

  return { acquire, retry };
}

export const brokerRegistry = makeBrokerRegistry();
export type BrokerRegistry = ReturnType<typeof makeBrokerRegistry>;
