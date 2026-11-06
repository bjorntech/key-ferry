import { createHash } from "node:crypto";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  Context,
  Deferred,
  Duration,
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
import { setOwnershipLifecycleLogger } from "./varlock/ownership.js";

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
  /** Supplies the schema fingerprint; the default retains the real filesystem implementation. */
  readonly schemaHash?: (directory: string) => Effect.Effect<string, unknown>;
  readonly maxEntries?: number;
  readonly now?: () => number;
  readonly idleTimeoutMs?: number;
  readonly logger?: (event: BrokerLogEvent) => void;
  readonly hostShutdownHooks?: boolean;
}

export interface BrokerLogEvent {
  readonly event:
    | "start"
    | "ready"
    | "release"
    | "idle-scheduled"
    | "reused"
    | "disposed"
    | "stop-failed"
    | "dispose-failed"
    | "stale-reaped"
    | "stale-skipped";
  readonly scope: "global" | "project";
  readonly directory: string;
  readonly keyHash: string;
  readonly pid?: number;
  readonly proxySessionId?: string;
}

type BrokerResult = { readonly status: SafeStatus; readonly environment: ResolvedEnvironment };

export const RETRY_BASE_DELAY_MS = 5_000;
export const RETRY_MAX_DELAY_MS = 300_000;

export const retryDelayMs = (failureCount: number) =>
  Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** Math.max(0, failureCount - 1));
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
  failureCount: number;
  lastFailureAt?: string;
  nextRetryAt?: string;
  retryBatch?: Deferred.Deferred<BrokerResult, VarlockError>;
  idleFiber?: Fiber.Fiber<void>;
  idleUntil?: string;
  contextKey: string;
};

function retryPending(entry: Entry): { pending: NonNullable<Entry["attempt"]> } | undefined {
  return entry.attempt && entry.attemptPending ? { pending: entry.attempt } : undefined;
}

const adapterKeys = new Set([
  "command",
  "environmentKeys",
  "startupTimeoutMs",
  "commandTimeoutMs",
  "reloadTimeoutMs",
  "pollIntervalMs",
  "requireStrictEgress",
  "idleTimeoutMs",
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

const schemaHashCache = new Map<string, { signature: string; hash: string }>();

async function contentHash(directory: string): Promise<string> {
  const hash = createHash("sha256");
  try {
    const names = (await readdir(directory))
      .filter((name) => name === ".env.schema" || name.startsWith(".env.schema."))
      .sort();
    const metadata = await Promise.all(
      names.map(async (name) => {
        const info = await stat(join(directory, name));
        return `${name}:${info.mtimeMs}:${info.size}`;
      }),
    );
    const signature = metadata.join("\0");
    const cached = schemaHashCache.get(directory);
    if (cached?.signature === signature) return cached.hash;
    for (const name of names) {
      hash.update(name);
      hash.update(await readFile(join(directory, name)));
    }
    const result = hash.digest("hex");
    schemaHashCache.set(directory, { signature, hash: result });
    return result;
  } catch {
    // The manager performs the authoritative directory validation. Keep the
    // registry usable with injected/test canonicalizers and distinguish an
    // unreadable schema from a real schema without exposing its contents.
    hash.update("schema-unavailable");
  }
  return hash.digest("hex");
}

function keyFor(
  directory: string,
  options: ProjectKeyFerryManagerOptions,
  schemaHash: (directory: string) => Effect.Effect<string, unknown>,
): Effect.Effect<{ key: string; contextKey: string }, unknown> {
  return Effect.gen(function* () {
    const adapter = validateOptions(options);
    const keys = [
      ...new Set([
        ...(adapter.environmentKeys as string[]),
        ...Object.keys(globalThis.process.env).filter((key) => /^OP_/.test(key)),
      ]),
    ].sort();
    const valuesHash = createHash("sha256");
    for (const key of keys) valuesHash.update(`${key}\0${globalThis.process.env[key] ?? ""}\0`);
    const context = {
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
      idleTimeoutMs: adapter.idleTimeoutMs,
    };
    return {
      contextKey: stable(context),
      key: stable({
        ...context,
        environmentValuesHash: valuesHash.digest("hex"),
        schemaHash: yield* schemaHash(directory),
      }),
    };
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
  const factoryMaps = new Set<Map<string, Entry>>();
  const lock = Effect.runSync(Semaphore.make(1));
  const canonicalize =
    configuration.canonicalize ??
    ((directory: string) => Effect.tryPromise(() => realpath(directory)));
  const schemaHash =
    configuration.schemaHash ??
    ((directory: string) => Effect.tryPromise(() => contentHash(directory)));
  const maxEntries = configuration.maxEntries ?? 128;
  const now = configuration.now ?? (() => Date.now());
  // Direct registry consumers historically received immediate teardown. The
  // validated plugin adapter always supplies the public ten-minute default;
  // retaining this fallback keeps injected/test registries backwards compatible.
  const idleTimeoutMs = configuration.idleTimeoutMs ?? 0;
  const log = (entry: Entry, event: BrokerLogEvent["event"]) => {
    configuration.logger?.({
      event,
      scope: entry.options.owner === "key-ferry" ? "project" : "global",
      directory: entry.options.projectDirectory,
      keyHash: createHash("sha256").update(entry.key).digest("hex").slice(0, 12),
      ...(entry.status?.pid === undefined ? {} : { pid: entry.status.pid }),
      ...((entry.status as (SafeStatus & { proxySessionId?: string }) | undefined)
        ?.proxySessionId === undefined
        ? {}
        : {
            proxySessionId: (entry.status as SafeStatus & { proxySessionId?: string })
              .proxySessionId,
          }),
    });
  };

  const publish = (entry: Entry, status: SafeStatus) => {
    entry.status = status;
    return PubSub.publish(entry.events, status);
  };

  const recordFailure = (entry: Entry, failure: VarlockError) => {
    entry.failure = failure;
    entry.failureCount += 1;
    entry.lastFailureAt = new Date(now()).toISOString();
    entry.nextRetryAt = new Date(now() + retryDelayMs(entry.failureCount)).toISOString();
    return {
      lastFailureAt: entry.lastFailureAt,
      nextRetryAt: entry.nextRetryAt,
    };
  };

  const clearFailure = (entry: Entry) => {
    entry.failure = undefined;
    entry.failureCount = 0;
    entry.lastFailureAt = undefined;
    entry.nextRetryAt = undefined;
    entry.retryBatch = undefined;
  };

  const capacityFailure = () => Effect.die(new Error("broker registry capacity reached"));

  const disposeStaleEntries = (factoryMap: Map<string, Entry>, contextKey: string) =>
    Effect.gen(function* () {
      for (const [oldKey, oldEntry] of factoryMap) {
        if (oldEntry.contextKey !== contextKey || oldEntry.leases.size > 0) continue;
        yield* disposeEntry(oldEntry);
        entries.delete(oldEntry);
        factoryMap.delete(oldKey);
      }
    });

  const disposeEntry = (entry: Entry) =>
    Effect.gen(function* () {
      log(entry, "disposed");
      if (entry.idleFiber) {
        yield* Fiber.interrupt(entry.idleFiber);
        entry.idleFiber = undefined;
      }
      if (entry.startup) yield* Fiber.interrupt(entry.startup);
      if (entry.manager) {
        yield* entry.manager.dispose.pipe(
          Effect.catch(() =>
            Effect.sync(() => {
              // The manager may have left the ownership record in place. Drop
              // the in-process entry, but make the startup reaper handoff
              // explicit so cleanup is still observable without error text.
              log(entry, "dispose-failed");
            }),
          ),
        );
      }
      yield* Scope.close(entry.scope, Exit.void).pipe(Effect.ignore);
      entry.manager = undefined;
      entry.disposed = true;
      entry.idleUntil = undefined;
    }).pipe(Effect.catch(() => Effect.void));

  const start = (entry: Entry): Effect.Effect<BrokerResult, VarlockError> => {
    const operation: Effect.Effect<BrokerResult, VarlockError, any> = Effect.gen(function* () {
      const context = yield* Layer.build(entry.factory.layer(entry.options)).pipe(
        Effect.provideService(Scope.Scope, entry.scope),
      );
      const manager = Context.get(context, ProjectKeyFerryManager);
      entry.manager = manager;
      entry.status = yield* manager.status;
      log(entry, "start");
      const result = yield* manager.ensureReady;
      log(entry, "ready");
      yield* publish(entry, result.status);
      return result;
    });
    return operation.pipe(
      Effect.catch((error: unknown) => {
        const failure = safeError(error, "start_failed");
        const metadata = recordFailure(entry, failure);
        return publish(entry, {
          phase: "failed",
          projectDirectory: entry.options.projectDirectory,
          generation: entry.status?.generation ?? 0,
          error: failure,
          ...metadata,
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
      Effect.flatMap((result) =>
        Effect.sync(() => clearFailure(entry)).pipe(
          Effect.andThen(Deferred.succeed(target, result)),
        ),
      ),
      Effect.catch((error: unknown) =>
        Effect.sync(() => {
          entry.attemptPending = false;
        }).pipe(Effect.andThen(Deferred.fail(target, safeError(error, "start_failed")))),
      ),
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
              const metadata = recordFailure(entry, failure);
              entry.refresh = undefined;
              return publish(entry, {
                phase: "failed",
                projectDirectory: entry.options.projectDirectory,
                generation: entry.status?.generation ?? 0,
                error: failure,
                ...metadata,
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
      const identity = yield* keyFor(directory, options, schemaHash).pipe(Effect.orDie);
      const key = identity.key;
      const factoryMap = factories.get(factory as object) ?? new Map<string, Entry>();
      factories.set(factory as object, factoryMap);
      factoryMaps.add(factoryMap);
      const existing = factoryMap.get(key);
      if (existing) return existing;
      if (entries.size >= maxEntries) return yield* capacityFailure();
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
        failureCount: 0,
        contextKey: identity.contextKey,
      };
      yield* disposeStaleEntries(factoryMap, identity.contextKey);
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
      yield* disposeEntry(entry);
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

  const scheduleIdle = (
    entry: Entry,
    factoryMap: Map<string, Entry>,
    directory: string,
    timeout: number,
  ) =>
    Effect.gen(function* () {
      entry.idleUntil = new Date(now() + timeout).toISOString();
      log(entry, "idle-scheduled");
      yield* publish(entry, {
        ...(entry.status ?? { phase: "idle", projectDirectory: directory as any, generation: 0 }),
        phase: "idle",
        idleUntil: entry.idleUntil,
      });
      entry.idleFiber = yield* Effect.sleep(Duration.millis(timeout)).pipe(
        Effect.andThen(
          Effect.gen(function* () {
            if (entry.leases.size === 0 && !entry.disposed) {
              entry.disposed = true;
              const deferred = yield* Deferred.make<void>();
              entry.closing = deferred;
              yield* disposeLeaseEntry(entry, factoryMap, deferred).pipe(Effect.forkDetach);
            }
          }),
        ),
        Effect.forkIn(entry.scope),
      );
    });

  const closeImmediately = (
    entry: Entry,
    factoryMap: Map<string, Entry>,
    required: boolean,
  ): Effect.Effect<Deferred.Deferred<void> | undefined> =>
    Effect.gen(function* () {
      if (!required) return undefined;
      entry.disposed = true;
      const deferred = yield* Deferred.make<void>();
      entry.closing = deferred;
      yield* disposeLeaseEntry(entry, factoryMap, deferred).pipe(Effect.forkDetach);
      return deferred;
    });

  const releaseLease = (
    entry: Entry,
    factoryMap: Map<string, Entry>,
    leaseID: symbol,
    directory: string,
    isReleased: () => boolean,
    markReleased: () => void,
  ) =>
    lock.withPermit(
      Effect.gen(function* () {
        if (isReleased()) return undefined;
        markReleased();
        log(entry, "release");
        entry.leases.delete(leaseID);
        return yield* releaseAfterDelete(entry, factoryMap, directory);
      }),
    );

  const releaseAfterDelete = (
    entry: Entry,
    factoryMap: Map<string, Entry>,
    directory: string,
  ): Effect.Effect<Deferred.Deferred<void> | undefined> =>
    entry.leases.size !== 0 || entry.disposed
      ? Effect.succeed(undefined)
      : releaseLastLease(entry, factoryMap, directory);

  const releaseLastLease = (
    entry: Entry,
    factoryMap: Map<string, Entry>,
    directory: string,
  ): Effect.Effect<Deferred.Deferred<void> | undefined> =>
    Effect.gen(function* () {
      const timeout = Number(
        (entry.options.adapter as Record<string, unknown>).idleTimeoutMs ?? idleTimeoutMs,
      );
      const immediate = yield* closeImmediately(
        entry,
        factoryMap,
        entry.failure !== undefined || timeout <= 0,
      );
      if (immediate) return immediate;
      yield* scheduleIdle(entry, factoryMap, directory, timeout);
      return undefined;
    });

  const reuseIdle = (entry: Entry) =>
    Effect.gen(function* () {
      if (!entry.idleFiber) return;
      yield* Fiber.interrupt(entry.idleFiber);
      entry.idleFiber = undefined;
      entry.idleUntil = undefined;
      entry.disposed = false;
      if (entry.status?.phase === "idle")
        yield* publish(entry, { ...entry.status, phase: "ready", idleUntil: undefined });
      log(entry, "reused");
    });

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
        factoryMaps.add(factoryMap);
        const entry = yield* getOrCreateEntry(factory, options, directory);
        if (entry.closing) return { waiting: entry.closing };
        yield* reuseIdle(entry);
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
          const close = yield* releaseLease(
            entry!,
            factoryMap,
            leaseID,
            directory,
            () => released,
            () => (released = true),
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
  ): Effect.Effect<
    | BrokerResult
    | { waiting: Deferred.Deferred<void> }
    | { pending: Deferred.Deferred<BrokerResult, VarlockError> },
    any,
    never
  > =>
    Effect.gen(function* () {
      const directory = yield* canonicalize(options.projectDirectory);
      const target = yield* lock.withPermit(
        Effect.gen(function* () {
          const entry = factories
            .get(factory as object)
            ?.get((yield* keyFor(directory, options, schemaHash)).key);
          if (entry?.retryBatch) return entry.retryBatch;
          if (entry) {
            const initial = yield* retryEntry(entry);
            if ("waiting" in initial || "pending" in initial) return initial;
            const batch = yield* Deferred.make<BrokerResult, VarlockError>();
            entry.retryBatch = batch;
            yield* Deferred.await(initial).pipe(
              Effect.matchEffect({
                onSuccess: (result) => Deferred.succeed(batch, result),
                onFailure: (error) => Deferred.fail(batch, error),
              }),
              // Keep the completed batch as the result of this explicit
              // retry. A background retry clears it when its deadline is due
              // and atomically establishes the next batch.
              Effect.andThen(Effect.void),
              Effect.forkDetach,
            );
            return batch;
          }
          return yield* retryEntry(entry);
        }),
      );
      if ("waiting" in target || "pending" in target) return target;
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
      if ("pending" in result) {
        // This caller observed an attempt already in flight. Its result is the
        // result of this retry operation; do not turn a shared failure into a
        // fresh attempt when the pending attempt completes.
        return yield* Deferred.await(result.pending);
      }
      return result;
    });

  const retryEntry = (
    entry: Entry | undefined,
  ): Effect.Effect<
    | Deferred.Deferred<BrokerResult, VarlockError>
    | { waiting: Deferred.Deferred<void> }
    | { pending: Deferred.Deferred<BrokerResult, VarlockError> },
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
    const pending = retryPending(entry);
    if (pending) return Effect.succeed(pending);
    if (!entry.failure)
      return Effect.fail(
        new VarlockError({
          code: "not_ready",
          message: "No failed broker entry",
          retryable: false,
        }),
      );
    return Effect.gen(function* () {
      // The previous attempt is complete (attemptPending was checked above),
      // so closing its scope cannot race a startup. This runs manager and
      // certificate-directory finalizers before allocating the replacement.
      yield* Scope.close(entry.scope, Exit.void).pipe(Effect.ignore);
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

  const retryIfDue = (
    factory: ProjectKeyFerryManagerFactory<any>,
    options: ProjectKeyFerryManagerOptions,
  ): Effect.Effect<BrokerResult | undefined, any, never> =>
    Effect.gen(function* () {
      const directory = yield* canonicalize(options.projectDirectory);
      const entry = factories
        .get(factory as object)
        ?.get((yield* keyFor(directory, options, schemaHash)).key);
      if (!entry?.failure || (entry.nextRetryAt && now() < Date.parse(entry.nextRetryAt)))
        return undefined;
      entry.retryBatch = undefined;
      return yield* retry(factory, options).pipe(
        Effect.catch((error) =>
          error instanceof VarlockError && error.code === "not_ready"
            ? Effect.succeed(undefined)
            : Effect.fail(error),
        ),
      );
    });

  let unregisterOwnershipLogger: () => void = () => undefined;
  const shutdown = Effect.uninterruptible(
    Effect.gen(function* () {
      removeHooksWhenConfigured(configuration.hostShutdownHooks);
      const current = [...entries];
      yield* Effect.forEach(current, (entry) => disposeEntry(entry), { concurrency: "unbounded" });
      for (const map of factoryMaps) map.clear();
      entries.clear();
      unregisterOwnershipLogger();
    }),
  );

  installHooksWhenConfigured(configuration.hostShutdownHooks, shutdown);
  unregisterOwnershipLogger = setOwnershipLifecycleLogger((event) =>
    configuration.logger?.({
      ...event,
      scope: "project",
      directory: "" as any,
      keyHash: event.keyHash,
    } as BrokerLogEvent),
  );
  return { acquire, retry, retryIfDue, shutdown };
}

let hostHooks: (() => void) | undefined;
let hostShutdown: Effect.Effect<void> | undefined;
export interface HostSignalProcess {
  readonly pid: number;
  readonly on: (event: any, listener: (...args: any[]) => void) => unknown;
  readonly removeListener: (event: any, listener: (...args: any[]) => void) => unknown;
  readonly listeners: (event: any) => Function[];
  readonly kill: (pid: number, signal: "SIGINT" | "SIGTERM") => unknown;
}
function removeHooksWhenConfigured(enabled: boolean | undefined): void {
  if (enabled) removeHostShutdownHooks();
}
function installHooksWhenConfigured(
  enabled: boolean | undefined,
  shutdown: Effect.Effect<void>,
): void {
  if (enabled) installHostShutdownHooks(shutdown);
}
function signalListener(
  name: "SIGINT" | "SIGTERM",
  onSigInt: () => void,
  onSigTerm: () => void,
): () => void {
  return name === "SIGINT" ? onSigInt : onSigTerm;
}
function reraiseSignal(
  signalProcess: HostSignalProcess,
  name: "SIGINT" | "SIGTERM",
  listener: () => void,
): void {
  signalProcess.removeListener(name, listener);
  signalProcess.kill(signalProcess.pid, name);
}
function finishSignalCleanup(
  signalProcess: HostSignalProcess,
  name: "SIGINT" | "SIGTERM",
  listener: () => void,
  active: boolean,
): void {
  if (!active && signalProcess.listeners(name).length > 0) return;
  const others = signalProcess.listeners(name).filter((item) => item !== listener);
  signalProcess.removeListener(name, listener);
  if (others.length === 0) signalProcess.kill(signalProcess.pid, name);
}
export function removeHostShutdownHooks(): void {
  hostHooks?.();
  hostHooks = undefined;
  hostShutdown = undefined;
}
export function installHostShutdownHooks(
  shutdown: Effect.Effect<void>,
  signalProcess: HostSignalProcess = process,
  options: { readonly cleanupTimeoutMs?: number } = {},
): (() => void) | undefined {
  if (hostHooks) return;
  hostShutdown = shutdown;
  let active = true;
  const beforeExit = () => {
    if (active) void Effect.runPromise(hostShutdown!).catch(() => undefined);
  };
  let cleaning = false;
  // Node and Bun suppress their default signal termination while a signal
  // listener is installed. Cleanup is bounded; `exit` cannot await work and
  // is covered by the startup ownership reaper instead.
  const boundedTimer = (resolve: () => void) => {
    const timer = setTimeout(resolve, options.cleanupTimeoutMs ?? 3_000);
    (timer as unknown as { unref?: () => void }).unref?.();
    return timer;
  };
  const signal = (name: "SIGINT" | "SIGTERM") => {
    if (!active) return;
    const listener = signalListener(name, onSigInt, onSigTerm);
    if (cleaning) {
      reraiseSignal(signalProcess, name, listener);
      return;
    }
    cleaning = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = boundedTimer(resolve);
    });
    void Promise.race([Effect.runPromise(hostShutdown!).catch(() => undefined), timeout]).finally(
      () => {
        if (timer !== undefined) clearTimeout(timer);
        // shutdown() removes the hooks at its start, so do not let that normal
        // cleanup path suppress the signal re-raise requested by this handler.
        finishSignalCleanup(signalProcess, name, listener, active);
      },
    );
  };
  const onSigInt = () => signal("SIGINT");
  const onSigTerm = () => signal("SIGTERM");
  signalProcess.on("beforeExit", beforeExit);
  signalProcess.on("SIGINT", onSigInt);
  signalProcess.on("SIGTERM", onSigTerm);
  hostHooks = () => {
    active = false;
    signalProcess.removeListener("beforeExit", beforeExit);
    signalProcess.removeListener("SIGINT", onSigInt);
    signalProcess.removeListener("SIGTERM", onSigTerm);
  };
  return hostHooks;
}

export const brokerRegistry = makeBrokerRegistry({
  idleTimeoutMs: 600_000,
  hostShutdownHooks: true,
});
export type BrokerRegistry = ReturnType<typeof makeBrokerRegistry>;
