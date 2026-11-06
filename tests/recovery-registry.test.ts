import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Deferred, Effect, Fiber, Layer, Scope } from "effect";
import { makeBrokerRegistry } from "../src/broker-registry.js";
import {
  ProjectKeyFerryManager,
  projectDirectory,
  VarlockError,
  type ProjectKeyFerryManagerFactory,
  type ProjectKeyFerryManagerOptions,
} from "../src/contracts.js";

const root = projectDirectory(process.cwd());
const identity = { canonicalize: (value: string) => Effect.succeed(value) };
const options = (directory = root): ProjectKeyFerryManagerOptions => ({
  projectDirectory: directory,
  adapter: { command: ["varlock"], environmentKeys: ["TOKEN"] },
});

const status = (generation = 1) => ({
  phase: "ready" as const,
  projectDirectory: root,
  generation,
});

function factoryFor(
  build: (attempt: number) => { ready: boolean; refresh: boolean },
  counters?: { starts: number; finalizers: number },
  failureGate?: Deferred.Deferred<void>,
): ProjectKeyFerryManagerFactory {
  let attempt = 0;
  return {
    layer: () => {
      const current = build(++attempt);
      const waitForFailure = failureGate && attempt > 1;
      if (counters) counters.starts++;
      const manager = {
        status: Effect.succeed(status()),
        ensureStarted: current.ready
          ? Effect.succeed(status())
          : (waitForFailure ? Deferred.await(failureGate) : Effect.void).pipe(
              Effect.andThen(
                Effect.fail(
                  new VarlockError({ code: "start_failed", message: "failed", retryable: true }),
                ),
              ),
            ),
        ensureReady: current.ready
          ? Effect.succeed({ status: status(), environment: { TOKEN: "placeholder" } })
          : (waitForFailure ? Deferred.await(failureGate) : Effect.void).pipe(
              Effect.andThen(
                Effect.fail(
                  new VarlockError({ code: "start_failed", message: "failed", retryable: true }),
                ),
              ),
            ),
        environment: Effect.succeed({ TOKEN: "placeholder" }),
        refresh: current.refresh
          ? Effect.succeed(status(2))
          : Effect.fail(
              new VarlockError({ code: "refresh_failed", message: "failed", retryable: true }),
            ),
        refreshReady: current.refresh
          ? Effect.succeed({ status: status(2), environment: { TOKEN: "placeholder" } })
          : Effect.fail(
              new VarlockError({ code: "refresh_failed", message: "failed", retryable: true }),
            ),
        dispose: Effect.sync(() => counters && counters.finalizers++),
        withExclusive: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
      };
      return Layer.effect(
        ProjectKeyFerryManager,
        Effect.gen(function* () {
          yield* Effect.addFinalizer(() => Effect.sync(() => counters && counters.finalizers++));
          return manager;
        }),
      );
    },
  };
}

test("refresh failure records metadata and retries only after its deadline", async () => {
  const counters = { starts: 0, finalizers: 0 };
  const factory = factoryFor((attempt) => ({ ready: true, refresh: attempt > 1 }), counters);
  let now = 1_000_000;
  const registry = makeBrokerRegistry({ ...identity, now: () => now });
  const lease = await Effect.runPromise(registry.acquire(factory, options()));
  await Effect.runPromise(lease.ensureReady);
  await assert.rejects(Effect.runPromise(lease.refreshReady));
  const failed = await Effect.runPromise(lease.status);
  assert.equal(failed.error?.code, "refresh_failed");
  assert.ok(failed.lastFailureAt && failed.nextRetryAt);
  const before = counters.starts;
  now = Date.parse(failed.lastFailureAt!);
  assert.equal(await Effect.runPromise(registry.retryIfDue(factory, options())), undefined);
  now = Date.parse(failed.nextRetryAt!);
  await Effect.runPromise(registry.retryIfDue(factory, options()));
  assert.equal(counters.starts, before + 1);
  await Effect.runPromise(lease.release);
});

test("backoff caps at five minutes and resets after successful recovery", async () => {
  const counters = { starts: 0, finalizers: 0 };
  let succeed = false;
  const factory = factoryFor(() => ({ ready: succeed, refresh: false }), counters);
  let now = 2_000_000;
  const registry = makeBrokerRegistry({ ...identity, now: () => now });
  const lease = await Effect.runPromise(registry.acquire(factory, options()));
  await assert.rejects(Effect.runPromise(lease.ensureReady));
  let previous = 0;
  for (let i = 0; i < 8; i++) {
    const current = await Effect.runPromise(lease.status);
    const delay = Date.parse(current.nextRetryAt!) - Date.parse(current.lastFailureAt!);
    assert.equal(delay, Math.min(300_000, 5_000 * 2 ** i));
    previous = delay;
    now = Date.parse(current.nextRetryAt!);
    await assert.rejects(Effect.runPromise(registry.retryIfDue(factory, options())));
  }
  assert.equal(previous, 300_000);
  succeed = true;
  const recovered = await Effect.runPromise(lease.status);
  now = Date.parse(recovered.nextRetryAt!);
  await Effect.runPromise(registry.retryIfDue(factory, options()));
  succeed = false;
  await assert.rejects(Effect.runPromise(lease.refreshReady));
  const failedAgain = await Effect.runPromise(lease.status);
  assert.equal(
    Date.parse(failedAgain.nextRetryAt!) - Date.parse(failedAgain.lastFailureAt!),
    5_000,
  );
  await Effect.runPromise(lease.release);
});

test("retry closes each failed scope exactly once", async () => {
  const counters = { starts: 0, finalizers: 0 };
  let succeed = false;
  const factory = factoryFor(() => ({ ready: succeed, refresh: true }), counters);
  let now = 3_000_000;
  const registry = makeBrokerRegistry({ ...identity, now: () => now });
  const lease = await Effect.runPromise(registry.acquire(factory, options()));
  await assert.rejects(Effect.runPromise(lease.ensureReady));
  for (let i = 0; i < 3; i++) {
    const current = await Effect.runPromise(lease.status);
    now = Date.parse(current.nextRetryAt!);
    await assert.rejects(Effect.runPromise(registry.retryIfDue(factory, options())));
  }
  succeed = true;
  const current = await Effect.runPromise(lease.status);
  now = Date.parse(current.nextRetryAt!);
  await Effect.runPromise(registry.retryIfDue(factory, options()));
  assert.equal(counters.finalizers, 4);
  await Effect.runPromise(lease.release);
});

test("concurrent retry callers share one startup attempt", async () => {
  const counters = { starts: 0, finalizers: 0 };
  let succeed = false;
  const factory = factoryFor(() => ({ ready: succeed, refresh: true }), counters);
  let now = 4_000_000;
  const registry = makeBrokerRegistry({ ...identity, now: () => now });
  const lease = await Effect.runPromise(registry.acquire(factory, options()));
  await assert.rejects(Effect.runPromise(lease.ensureReady));
  succeed = true;
  const current = await Effect.runPromise(lease.status);
  now = Date.parse(current.nextRetryAt!);
  await Promise.all(
    Array.from({ length: 8 }, () => Effect.runPromise(registry.retryIfDue(factory, options()))),
  );
  assert.equal(counters.starts, 2);
  await Effect.runPromise(lease.release);
});

test("concurrent explicit retries share one failing startup attempt", async () => {
  const counters = { starts: 0, finalizers: 0 };
  const gate = await Effect.runPromise(Deferred.make<void>());
  const factory = factoryFor(() => ({ ready: false, refresh: true }), counters, gate);
  let now = 5_000_000;
  const registry = makeBrokerRegistry({ ...identity, now: () => now });
  const lease = await Effect.runPromise(registry.acquire(factory, options()));
  await assert.rejects(Effect.runPromise(lease.ensureReady));
  now = Date.parse((await Effect.runPromise(lease.status)).nextRetryAt!);
  const outcomes = await Effect.runPromise(
    Effect.gen(function* () {
      const first = yield* Effect.forkChild(registry.retry(factory, options()));
      yield* Effect.yieldNow;
      const rest = yield* Effect.forEach(
        Array.from({ length: 7 }, () => registry.retry(factory, options())),
        (effect) => Effect.forkChild(effect),
        { concurrency: "unbounded" },
      );
      yield* Effect.yieldNow;
      yield* Deferred.succeed(gate, undefined);
      return yield* Effect.forEach([first, ...rest], Fiber.await, { concurrency: "unbounded" });
    }),
  );
  assert.equal(counters.starts, 2);
  assert.equal(outcomes.filter((outcome) => outcome._tag === "Failure").length, 8);
  await Effect.runPromise(lease.release);
});

test("concurrent background retries share one failing startup attempt", async () => {
  const counters = { starts: 0, finalizers: 0 };
  const gate = await Effect.runPromise(Deferred.make<void>());
  const factory = factoryFor(() => ({ ready: false, refresh: true }), counters, gate);
  let now = 6_000_000;
  const registry = makeBrokerRegistry({ ...identity, now: () => now });
  const lease = await Effect.runPromise(registry.acquire(factory, options()));
  await assert.rejects(Effect.runPromise(lease.ensureReady));
  now = Date.parse((await Effect.runPromise(lease.status)).nextRetryAt!);
  const outcomes = await Effect.runPromise(
    Effect.gen(function* () {
      const first = yield* Effect.forkChild(registry.retryIfDue(factory, options()));
      yield* Effect.yieldNow;
      const rest = yield* Effect.forEach(
        Array.from({ length: 7 }, () => registry.retryIfDue(factory, options())),
        (effect) => Effect.forkChild(effect),
        { concurrency: "unbounded" },
      );
      yield* Effect.yieldNow;
      yield* Deferred.succeed(gate, undefined);
      return yield* Effect.forEach([first, ...rest], Fiber.await, { concurrency: "unbounded" });
    }),
  );
  assert.equal(counters.starts, 2);
  assert.equal(outcomes.filter((outcome) => outcome._tag === "Failure").length, 8);
  await Effect.runPromise(lease.release);
});

test("schema and OP environment changes create a new broker and dispose idle old entries", async () => {
  const directory = projectDirectory(await mkdtemp(join(tmpdir(), "key-ferry-schema-key-")));
  await writeFile(join(directory, ".env.schema"), "TOKEN=one\n");
  const counters = { starts: 0, finalizers: 0 };
  const factory = factoryFor(() => ({ ready: true, refresh: true }), counters);
  const registry = makeBrokerRegistry(identity);
  const first = await Effect.runPromise(registry.acquire(factory, options(directory)));
  await Effect.runPromise(first.ensureReady);
  await Effect.runPromise(first.release);
  await writeFile(join(directory, ".env.schema"), "TOKEN=two\n");
  const second = await Effect.runPromise(registry.acquire(factory, options(directory)));
  await Effect.runPromise(second.ensureReady);
  assert.equal(counters.starts, 2);
  assert.equal(counters.finalizers, 2);
  await Effect.runPromise(second.release);
  await rm(directory, { recursive: true, force: true });
});

test("identical broker inputs share and active old leases stay alive across key changes", async () => {
  const directory = projectDirectory(await mkdtemp(join(tmpdir(), "key-ferry-env-key-")));
  const counters = { starts: 0, finalizers: 0 };
  const factory = factoryFor(() => ({ ready: true, refresh: true }), counters);
  const registry = makeBrokerRegistry(identity);
  const original = process.env.OP_ACCOUNT;
  try {
    process.env.OP_ACCOUNT = "account-one-secret";
    const first = await Effect.runPromise(registry.acquire(factory, options(directory)));
    const shared = await Effect.runPromise(registry.acquire(factory, options(directory)));
    await Effect.runPromise(first.ensureReady);
    await Effect.runPromise(shared.ensureReady);
    assert.equal(counters.starts, 1);
    process.env.OP_ACCOUNT = "account-two-secret";
    const changed = await Effect.runPromise(registry.acquire(factory, options(directory)));
    await Effect.runPromise(changed.ensureReady);
    assert.equal(counters.starts, 2);
    assert.equal(counters.finalizers, 0);
    const publicStatus = JSON.stringify(await Effect.runPromise(changed.status));
    assert.equal(publicStatus.includes("account-two-secret"), false);
    await Effect.runPromise(first.release);
    await Effect.runPromise(shared.release);
    await Effect.runPromise(changed.release);
  } finally {
    if (original === undefined) delete process.env.OP_ACCOUNT;
    else process.env.OP_ACCOUNT = original;
    await rm(directory, { recursive: true, force: true });
  }
});
