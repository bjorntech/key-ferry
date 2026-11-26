import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Deferred, Effect, Fiber, Layer, Option, Stream } from "effect";
import { makeBrokerRegistry } from "../src/broker-registry.js";
import {
  ProjectKeyFerryManager,
  projectDirectory,
  type ProjectKeyFerryManagerFactory,
  type ProjectKeyFerryManagerOptions,
  type ProjectKeyFerryManagerService,
  type SafeStatus,
  VarlockError,
} from "../src/contracts.js";

const directory = projectDirectory(process.cwd());

function options(overrides: Partial<ProjectKeyFerryManagerOptions> = {}) {
  return {
    projectDirectory: directory,
    ...overrides,
    adapter: {
      command: ["varlock"],
      environmentKeys: ["TOKEN"],
      startupTimeoutMs: 100,
      commandTimeoutMs: 100,
      reloadTimeoutMs: 100,
      pollIntervalMs: 10,
      requireStrictEgress: true,
      idleTimeoutMs: 0,
      ...(overrides.adapter ?? {}),
    },
  } satisfies ProjectKeyFerryManagerOptions;
}

const readyStatus: SafeStatus = { phase: "ready", projectDirectory: directory, generation: 1 };

function failure(code: "start_failed" | "refresh_failed" = "start_failed") {
  return new VarlockError({ code, message: "fixture failure", retryable: true });
}

function manager(overrides: Partial<ProjectKeyFerryManagerService> = {}) {
  const base: ProjectKeyFerryManagerService = {
    status: Effect.succeed(readyStatus),
    ensureStarted: Effect.succeed(readyStatus),
    ensureReady: Effect.succeed({ status: readyStatus, environment: { TOKEN: "secret-canary" } }),
    environment: Effect.succeed({ TOKEN: "secret-canary" }),
    refresh: Effect.succeed(readyStatus),
    refreshReady: Effect.succeed({ status: readyStatus, environment: { TOKEN: "secret-canary" } }),
    dispose: Effect.void,
    withExclusive: (effect) => effect,
  };
  return { ...base, ...overrides };
}

function factoryFor(
  build: (options: ProjectKeyFerryManagerOptions) => ProjectKeyFerryManagerService,
  built?: { count: number },
): ProjectKeyFerryManagerFactory {
  return {
    layer: (factoryOptions) => {
      if (built) built.count += 1;
      return Layer.succeed(ProjectKeyFerryManager, build(factoryOptions));
    },
  };
}

const identity = { canonicalize: (value: string) => Effect.succeed(value) };

async function waitForFlag(getFlag: () => boolean, label: string) {
  const deadline = Date.now() + 2_000;
  while (!getFlag()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test("acquire is non-blocking and status is safe while layer authentication is pending", async () => {
  const gate = await Effect.runPromise(Deferred.make<void>());
  const registry = makeBrokerRegistry(identity);
  const factory: ProjectKeyFerryManagerFactory = {
    layer: () =>
      Layer.effect(ProjectKeyFerryManager, Deferred.await(gate).pipe(Effect.map(() => manager()))),
  };
  const acquired = await Effect.runPromise(registry.acquire(factory, options()));
  assert.deepEqual(await Effect.runPromise(acquired.status), {
    phase: "starting",
    projectDirectory: directory,
    generation: 0,
  });
  assert.equal(await Effect.runPromise(Deferred.succeed(gate, undefined)), true);
  await Effect.runPromise(acquired.ensureReady);
  await Effect.runPromise(acquired.release);
});

test("manager-affecting identity fields do not share, while eleven identical leases do", async () => {
  const built = { count: 0 };
  const factory = factoryFor(() => manager(), built);
  const registry = makeBrokerRegistry(identity);
  const leases = await Effect.runPromise(
    Effect.all(
      Array.from({ length: 11 }, () => registry.acquire(factory, options())),
      {
        concurrency: "unbounded",
      },
    ),
  );
  await Effect.runPromise(Effect.all(leases.map((lease) => lease.ensureReady)));
  assert.equal(built.count, 1);
  const otherRoot = projectDirectory(await mkdtemp(join(tmpdir(), "key-ferry-registry-root-")));
  const variants = [
    options({ owner: "different" }),
    options({ sessionID: "different" }),
    options({ projectDirectory: otherRoot }),
    options({ adapter: { ...options().adapter, command: ["other"] } }),
    options({ adapter: { ...options().adapter, environmentKeys: ["OTHER"] } }),
    options({ adapter: { ...options().adapter, requireStrictEgress: false } }),
  ];
  const distinct = await Effect.runPromise(
    Effect.all(
      variants.map((variant) => registry.acquire(factory, variant)),
      {
        concurrency: "unbounded",
      },
    ),
  );
  await Effect.runPromise(Effect.all(distinct.map((lease) => lease.ensureReady)));
  assert.equal(built.count, 7);
  await Effect.runPromise(Effect.all([...leases, ...distinct].map((lease) => lease.release)));
  await rm(otherRoot, { recursive: true, force: true });
});

test("startup failure is a zero-refcount tombstone and retry is one shared attempt", async () => {
  const built = { count: 0 };
  let attempts = 0;
  const factory = factoryFor(() => {
    attempts += 1;
    return manager({
      ensureReady: Effect.fail(attempts === 1 ? failure() : failure("refresh_failed")),
    });
  }, built);
  const registry = makeBrokerRegistry(identity);
  const leases = await Effect.runPromise(
    Effect.all(
      Array.from({ length: 11 }, () => registry.acquire(factory, options())),
      {
        concurrency: "unbounded",
      },
    ),
  );
  const errors = await Promise.all(
    leases.map(async (lease) => {
      try {
        await Effect.runPromise(lease.ensureReady);
        return undefined;
      } catch (error) {
        return error;
      }
    }),
  );
  assert.equal(attempts, 1);
  assert.ok(errors.every((error) => error instanceof VarlockError));
  await Effect.runPromise(Effect.all(leases.map((lease) => lease.release)));

  // With no lease held there is no owner that could ever stop a replacement,
  // so the tombstone refuses to retry and starts nothing.
  await assert.rejects(
    Effect.runPromise(registry.retry(factory, options())),
    (error) => error instanceof VarlockError && error.code === "not_ready",
  );
  assert.equal(attempts, 1);
  assert.equal(built.count, 1);

  const tombstone = await Effect.runPromise(registry.acquire(factory, options()));
  await assert.rejects(Effect.runPromise(tombstone.ensureReady), VarlockError);
  assert.equal(attempts, 1);

  const retryErrors = await Promise.all(
    Array.from({ length: 11 }, async () => {
      try {
        await Effect.runPromise(registry.retry(factory, options()));
        return undefined;
      } catch (error) {
        return error;
      }
    }),
  );
  assert.equal(attempts, 2);
  assert.equal(built.count, 2);
  assert.ok(
    retryErrors.every((error) => error instanceof VarlockError && error.code === "refresh_failed"),
  );
  await Effect.runPromise(tombstone.release);
  const postRetry = await Effect.runPromise(registry.acquire(factory, options()));
  await assert.rejects(Effect.runPromise(postRetry.ensureReady), VarlockError);
  await Effect.runPromise(postRetry.release);
});

test("releasing the last lease during startup settles callers awaiting readiness", async () => {
  const registry = makeBrokerRegistry(identity);
  let building = false;
  const factory: ProjectKeyFerryManagerFactory = {
    layer: () =>
      Layer.effect(
        ProjectKeyFerryManager,
        Effect.sync(() => {
          building = true;
        }).pipe(Effect.andThen(Effect.never)),
      ),
  };
  const lease = await Effect.runPromise(registry.acquire(factory, options()));
  const waiting = Effect.runPromise(lease.ensureReady.pipe(Effect.timeout("2 seconds")));
  await waitForFlag(() => building, "startup to begin");
  await Effect.runPromise(lease.release);
  // Disposal interrupts the startup; the waiter is told instead of hanging.
  await assert.rejects(
    waiting,
    (error) => error instanceof VarlockError && error.code === "disposed",
  );
});

test("a startup defect settles callers awaiting readiness", async () => {
  const registry = makeBrokerRegistry(identity);
  const factory: ProjectKeyFerryManagerFactory = {
    layer: () => Layer.effect(ProjectKeyFerryManager, Effect.die(new Error("fixture defect"))),
  };
  const lease = await Effect.runPromise(registry.acquire(factory, options()));
  await assert.rejects(
    Effect.runPromise(lease.ensureReady.pipe(Effect.timeout("2 seconds"))),
    (error) => error instanceof VarlockError && error.code === "start_failed",
  );
  await Effect.runPromise(lease.release);
});

test("disposing an entry during a refresh settles callers awaiting the refresh", async () => {
  const registry = makeBrokerRegistry(identity);
  let refreshing = false;
  const factory = factoryFor(() =>
    manager({
      refreshReady: Effect.sync(() => {
        refreshing = true;
      }).pipe(Effect.andThen(Effect.never)),
    }),
  );
  const lease = await Effect.runPromise(registry.acquire(factory, options()));
  await Effect.runPromise(lease.ensureReady);
  const waiting = Effect.runPromise(lease.refreshReady.pipe(Effect.timeout("2 seconds")));
  await waitForFlag(() => refreshing, "refresh to begin");
  await Effect.runPromise(lease.release);
  await assert.rejects(
    waiting,
    (error) => error instanceof VarlockError && error.code === "disposed",
  );
});

test("subscription replays READY and never exposes environment canaries", async () => {
  const registry = makeBrokerRegistry(identity);
  const factory = factoryFor(() => manager());
  const before = await Effect.runPromise(registry.acquire(factory, options()));
  const early = await Effect.runPromise(before.subscribe);
  await Effect.runPromise(before.ensureReady);
  const event = await Effect.runPromise(
    Stream.runHead(early.changes).pipe(Effect.timeout("1 second")),
  );
  assert.deepEqual(Option.getOrUndefined(event), readyStatus);
  const after = await Effect.runPromise(before.subscribe);
  assert.deepEqual(await Effect.runPromise(after.current), readyStatus);
  assert.doesNotMatch(JSON.stringify(event), /secret-canary/);
  await Effect.runPromise(before.release);
});

test("refreshReady is synchronous-safe and concurrent callers share one atomic result", async () => {
  let refreshes = 0;
  const refreshed: SafeStatus = { ...readyStatus, generation: 2 };
  const registry = makeBrokerRegistry(identity);
  const factory = factoryFor(() =>
    manager({
      refreshReady: Effect.gen(function* () {
        refreshes += 1;
        yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 5)));
        return { status: refreshed, environment: { TOKEN: "secret-canary-2" } };
      }),
    }),
  );
  const leases = await Effect.runPromise(
    Effect.all([registry.acquire(factory, options()), registry.acquire(factory, options())]),
  );
  await Effect.runPromise(leases[0].ensureReady);
  const results = await Effect.runPromise(
    Effect.all(
      leases.map((lease) => lease.refreshReady),
      { concurrency: "unbounded" },
    ),
  );
  assert.equal(refreshes, 1);
  assert.deepEqual(results, [
    { status: refreshed, environment: { TOKEN: "secret-canary-2" } },
    { status: refreshed, environment: { TOKEN: "secret-canary-2" } },
  ]);
  await Effect.runPromise(Effect.all(leases.map((lease) => lease.release)));
});

test("refresh broadcasts STARTING before backend work and gates new leases on the new generation", async () => {
  const gate = await Effect.runPromise(Deferred.make<void>());
  const refreshed: SafeStatus = { ...readyStatus, generation: 2 };
  const registry = makeBrokerRegistry(identity);
  const factory = factoryFor(() =>
    manager({
      refreshReady: Deferred.await(gate).pipe(
        Effect.map(() => ({ status: refreshed, environment: { TOKEN: "secret-canary-2" } })),
      ),
    }),
  );
  const first = await Effect.runPromise(registry.acquire(factory, options()));
  await Effect.runPromise(first.ensureReady);
  const subscription = await Effect.runPromise(first.subscribe);
  const refreshing = Effect.runPromise(first.refreshReady);
  const pending = await Effect.runPromise(
    Stream.runHead(subscription.changes).pipe(Effect.timeout("1 second")),
  );
  assert.equal(Option.getOrUndefined(pending)?.phase, "starting");
  const second = await Effect.runPromise(registry.acquire(factory, options()));
  await assert.rejects(Effect.runPromise(second.ensureReady.pipe(Effect.timeout("5 millis"))));
  await Effect.runPromise(Deferred.succeed(gate, undefined));
  assert.deepEqual(await refreshing, {
    status: refreshed,
    environment: { TOKEN: "secret-canary-2" },
  });
  assert.deepEqual(await Effect.runPromise(second.ensureReady), {
    status: refreshed,
    environment: { TOKEN: "secret-canary-2" },
  });
  await Effect.runPromise(Effect.all([first.release, second.release]));
});

test("refresh failure is shared and publishes only safe failed status", async () => {
  let refreshes = 0;
  const registry = makeBrokerRegistry(identity);
  const factory = factoryFor(() =>
    manager({
      refreshReady: Effect.gen(function* () {
        refreshes += 1;
        return yield* Effect.fail(failure("refresh_failed"));
      }),
    }),
  );
  const leases = await Effect.runPromise(
    Effect.all([registry.acquire(factory, options()), registry.acquire(factory, options())]),
  );
  await Effect.runPromise(leases[0].ensureReady);
  const errors = await Promise.all(
    leases.map(async (lease) => {
      try {
        await Effect.runPromise(lease.refreshReady);
        return undefined;
      } catch (error) {
        return error;
      }
    }),
  );
  assert.equal(refreshes, 1);
  assert.ok(
    errors.every((error) => error instanceof VarlockError && error.code === "refresh_failed"),
  );
  const status = await Effect.runPromise(leases[1].status);
  assert.equal(status.phase, "failed");
  assert.doesNotMatch(JSON.stringify(status), /secret-canary/);
  await Effect.runPromise(Effect.all(leases.map((lease) => lease.release)));
});

test("interrupting one waiter does not cancel shared startup and release is idempotent", async () => {
  let disposals = 0;
  const readyGate = await Effect.runPromise(Deferred.make<void>());
  const registry = makeBrokerRegistry(identity);
  const factory = factoryFor(() =>
    manager({
      ensureReady: Deferred.await(readyGate).pipe(
        Effect.map(() => ({ status: readyStatus, environment: { TOKEN: "secret-canary" } })),
      ),
      dispose: Effect.sync(() => void disposals++),
    }),
  );
  const first = await Effect.runPromise(registry.acquire(factory, options()));
  const second = await Effect.runPromise(registry.acquire(factory, options()));
  await assert.rejects(Effect.runPromise(first.ensureReady.pipe(Effect.timeout("1 millis"))));
  await Effect.runPromise(first.release);
  assert.equal(await Effect.runPromise(Deferred.succeed(readyGate, undefined)), true);
  await Effect.runPromise(second.ensureReady);
  await Effect.runPromise(second.release);
  await Effect.runPromise(second.release);
  assert.equal(disposals, 1);
});

test("queued release is not starved by new acquires", async () => {
  const lockHeld = await Effect.runPromise(Deferred.make<void>());
  let enteredCanonicalize = false;
  let disposed = false;
  const registry = makeBrokerRegistry({
    canonicalize: (value) =>
      value === "blocked"
        ? Effect.sync(() => {
            enteredCanonicalize = true;
          }).pipe(Effect.andThen(Deferred.await(lockHeld)), Effect.as(value))
        : Effect.succeed(value),
  });
  const factory = factoryFor(() =>
    manager({
      dispose: Effect.sync(() => {
        disposed = true;
      }),
    }),
  );
  const first = await Effect.runPromise(registry.acquire(factory, options({ owner: "first" })));
  await Effect.runPromise(first.ensureReady);

  // Keep the registry gate occupied while the final release queues behind it.
  // The runtime scheduler decides whether a newly runnable fiber gets a turn
  // before the semaphore's wake task, so the old barging implementation is not
  // guaranteed to lose deterministically. This still checks the observable
  // contract: queued same-key acquires cannot prevent final disposal.
  const blocker = Effect.runFork(
    registry
      .acquire(factory, options({ projectDirectory: "blocked" as any }))
      .pipe(Effect.flatMap((lease) => lease.release)),
  );
  await waitForFlag(() => enteredCanonicalize, "blocked acquire to hold the registry gate");
  const release = Effect.runPromise(first.release);
  let acquiredBeforeRelease = 0;
  const acquirers = Array.from({ length: 32 }, () =>
    Effect.runFork(
      registry.acquire(factory, options({ owner: "first" })).pipe(
        Effect.tap(() => Effect.sync(() => acquiredBeforeRelease++)),
        Effect.flatMap((lease) => lease.release),
      ),
    ),
  );
  await Effect.runPromise(Deferred.succeed(lockHeld, undefined));

  await Promise.race([
    release,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("queued release was starved by new acquires")), 500),
    ),
  ]);
  assert.equal(acquiredBeforeRelease, 0);
  assert.equal(disposed, true);
  for (const fiber of acquirers) await Effect.runPromise(Fiber.interrupt(fiber));
  await Effect.runPromise(Fiber.interrupt(blocker));
});

test("last-release cleanup is outside the registry gate and same-key reacquire waits for a fresh entry", async () => {
  const disposeGate = await Effect.runPromise(Deferred.make<void>());
  let disposeStarted = false;
  let builds = 0;
  const registry = makeBrokerRegistry(identity);
  const factory = factoryFor(() => {
    builds += 1;
    return manager({
      dispose: Effect.gen(function* () {
        disposeStarted = true;
        if (builds === 1) yield* Deferred.await(disposeGate);
      }),
    });
  });
  const first = await Effect.runPromise(registry.acquire(factory, options({ owner: "A" })));
  await Effect.runPromise(first.ensureReady);
  const closing = Effect.runPromise(first.release);
  await waitForFlag(() => disposeStarted, "disposal to begin");

  const other = await Effect.runPromise(registry.acquire(factory, options({ owner: "B" })));
  await Effect.runPromise(other.ensureReady);
  await Effect.runPromise(other.release);

  const sameKey = Effect.runFork(registry.acquire(factory, options({ owner: "A" })));
  await Effect.runPromise(Effect.sleep("5 millis"));
  assert.equal(builds, 2);
  await Effect.runPromise(Deferred.succeed(disposeGate, undefined));
  await closing;
  const next = await Effect.runPromise(Fiber.join(sameKey));
  await Effect.runPromise(next.ensureReady);
  assert.equal(builds, 3);
  await Effect.runPromise(next.release);
});

test("dispose callbacks can reenter the registry for another key", async () => {
  let callbackCompleted = false;
  let nestedDispose = false;
  const registry = makeBrokerRegistry(identity);
  const factory = factoryFor(() =>
    manager({
      dispose: Effect.gen(function* () {
        if (nestedDispose) return;
        nestedDispose = true;
        const nested = yield* registry.acquire(factory, options({ owner: "nested" }));
        yield* nested.ensureReady;
        yield* nested.release;
        callbackCompleted = true;
      }),
    }),
  );
  const lease = await Effect.runPromise(registry.acquire(factory, options({ owner: "owner" })));
  await Effect.runPromise(lease.ensureReady);
  await Effect.runPromise(lease.release);
  assert.equal(callbackCompleted, true);
});

test("retry reports unavailable entries and waits for an entry that is closing", async () => {
  const disposeGate = await Effect.runPromise(Deferred.make<void>());
  let disposeStarted = false;
  const registry = makeBrokerRegistry(identity);
  const factory = factoryFor(() =>
    manager({
      dispose: Effect.gen(function* () {
        disposeStarted = true;
        yield* Deferred.await(disposeGate);
      }),
    }),
  );

  await assert.rejects(Effect.runPromise(registry.retry(factory, options())), VarlockError);
  const lease = await Effect.runPromise(registry.acquire(factory, options()));
  await Effect.runPromise(lease.ensureReady);
  await assert.rejects(Effect.runPromise(registry.retry(factory, options())), VarlockError);

  const closing = Effect.runPromise(lease.release);
  await waitForFlag(() => disposeStarted, "disposal to begin");
  const retrying = Effect.runPromise(registry.retry(factory, options()));
  await assert.rejects(
    Effect.runPromise(registry.retry(factory, options()).pipe(Effect.timeout("5 millis"))),
  );
  await Effect.runPromise(Deferred.succeed(disposeGate, undefined));
  await closing;
  await assert.rejects(retrying, VarlockError);
});
