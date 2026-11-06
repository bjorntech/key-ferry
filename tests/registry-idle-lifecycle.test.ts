import { test } from "bun:test";
import assert from "node:assert/strict";
import { Deferred, Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import { makeBrokerRegistry, brokerRegistry } from "../src/broker-registry.js";
import { ProjectKeyFerryManager, projectDirectory, VarlockError } from "../src/contracts.js";

const directory = projectDirectory("/registry-idle-test");

const options = (idleTimeoutMs?: number, projectDirectoryValue = directory) =>
  ({
    projectDirectory: projectDirectoryValue,
    adapter: {
      command: ["varlock"],
      environmentKeys: [],
      startupTimeoutMs: 100,
      commandTimeoutMs: 100,
      reloadTimeoutMs: 100,
      pollIntervalMs: 10,
      requireStrictEgress: true,
      ...(idleTimeoutMs === undefined ? {} : { idleTimeoutMs }),
    },
  }) as any;

const run = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runPromise(Effect.provide(effect, TestClock.layer()));

function readyFactory(counters: { starts: number; disposals: number; refreshes?: number }) {
  return {
    layer: () => {
      counters.starts += 1;
      const status = {
        phase: "ready" as const,
        projectDirectory: directory,
        generation: counters.starts,
      };
      return Layer.succeed(ProjectKeyFerryManager, {
        status: Effect.succeed(status),
        ensureStarted: Effect.succeed(status),
        ensureReady: Effect.succeed({ status, environment: {} }),
        environment: Effect.succeed({}),
        refresh: Effect.sync(() => {
          counters.refreshes = (counters.refreshes ?? 0) + 1;
          return status;
        }),
        refreshReady: Effect.sync(() => {
          counters.refreshes = (counters.refreshes ?? 0) + 1;
          return { status, environment: {} };
        }),
        dispose: Effect.sync(() => void counters.disposals++),
        withExclusive: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
      });
    },
  } as any;
}

test("idle expiry is deterministic and reports the idle deadline", async () => {
  const counters = { starts: 0, disposals: 0 };
  let now = 1_000_000;
  const registry = makeBrokerRegistry({
    canonicalize: (value) => Effect.succeed(value),
    idleTimeoutMs: 100,
    now: () => now,
  });
  await run(
    Effect.gen(function* () {
      const lease = yield* registry.acquire(readyFactory(counters), options());
      yield* lease.ensureReady;
      yield* lease.release;
      const status = yield* lease.status;
      assert.equal(status.phase, "idle");
      assert.equal(status.idleUntil, new Date(now + 100).toISOString());
      yield* TestClock.adjust("99 millis");
      yield* Effect.yieldNow;
      assert.equal(counters.disposals, 0);
      now += 100;
      yield* TestClock.adjust("2 millis");
      yield* Effect.yieldNow;
      assert.equal(counters.disposals, 1);
      yield* registry.shutdown;
    }),
  );
});

test("re-acquiring an idle broker cancels disposal and reuses it", async () => {
  const counters = { starts: 0, disposals: 0 };
  const registry = makeBrokerRegistry({
    canonicalize: (value) => Effect.succeed(value),
    idleTimeoutMs: 100,
  });
  const factory = readyFactory(counters);
  await run(
    Effect.gen(function* () {
      const first = yield* registry.acquire(factory, options());
      yield* first.ensureReady;
      yield* first.release;
      const second = yield* registry.acquire(factory, options());
      yield* second.ensureReady;
      assert.equal(counters.starts, 1);
      assert.equal((yield* second.status).phase, "ready");
      yield* TestClock.adjust("200 millis");
      yield* Effect.yieldNow;
      assert.equal(counters.disposals, 0);
      yield* second.release;
      yield* registry.shutdown;
    }),
  );
});

test("a key change disposes the idle old broker immediately", async () => {
  const counters = { starts: 0, disposals: 0 };
  let schema = "one";
  const factory = readyFactory(counters);
  const registry = makeBrokerRegistry({
    canonicalize: (value) => Effect.succeed(value),
    schemaHash: () => Effect.succeed(schema),
    idleTimeoutMs: 1000,
  });
  await run(
    Effect.gen(function* () {
      const first = yield* registry.acquire(factory, options());
      yield* first.ensureReady;
      yield* first.release;
      schema = "two";
      const second = yield* registry.acquire(factory, options());
      yield* second.ensureReady;
      assert.equal(counters.starts, 2);
      assert.equal(counters.disposals, 1);
      yield* second.release;
      yield* registry.shutdown;
    }),
  );
});

test("failed brokers are disposed instead of becoming idle", async () => {
  const counters = { disposals: 0 };
  const factory = {
    layer: () =>
      Layer.succeed(ProjectKeyFerryManager, {
        status: Effect.succeed({ phase: "starting", projectDirectory: directory, generation: 0 }),
        ensureStarted: Effect.void,
        ensureReady: Effect.fail(
          new VarlockError({ code: "start_failed", message: "no", retryable: true }),
        ),
        environment: Effect.fail(new Error("no")),
        refresh: Effect.fail(new Error("no")),
        refreshReady: Effect.fail(new Error("no")),
        dispose: Effect.sync(() => void counters.disposals++),
        withExclusive: (effect: any) => effect,
      }),
  } as any;
  const registry = makeBrokerRegistry({
    canonicalize: (value) => Effect.succeed(value),
    idleTimeoutMs: 1000,
  });
  await run(
    Effect.gen(function* () {
      const lease = yield* registry.acquire(factory, options());
      yield* lease.ensureReady.pipe(Effect.ignore);
      yield* lease.release;
      assert.equal(counters.disposals, 1);
      yield* registry.shutdown;
    }),
  );
});

test("refresh remains coalesced while idle mode is enabled", async () => {
  const counters = { starts: 0, disposals: 0, refreshes: 0 };
  const registry = makeBrokerRegistry({
    canonicalize: (value) => Effect.succeed(value),
    idleTimeoutMs: 1000,
  });
  const factory = readyFactory(counters);
  await run(
    Effect.gen(function* () {
      const first = yield* registry.acquire(factory, options());
      yield* first.ensureReady;
      const second = yield* registry.acquire(factory, options());
      yield* Effect.all([first.refreshReady, second.refreshReady], { concurrency: "unbounded" });
      assert.equal(counters.starts, 1);
      assert.equal(counters.refreshes, 1);
      yield* first.release;
      yield* second.release;
      yield* registry.shutdown;
    }),
  );
});

test("shutdown disposes live and idle brokers and is idempotent", async () => {
  const counters = { starts: 0, disposals: 0 };
  const registry = makeBrokerRegistry({
    canonicalize: (value) => Effect.succeed(value),
    idleTimeoutMs: 1000,
  });
  await run(
    Effect.gen(function* () {
      const idle = yield* registry.acquire(readyFactory(counters), options());
      yield* idle.ensureReady;
      yield* idle.release;
      const live = yield* registry.acquire(
        readyFactory(counters),
        options(undefined, projectDirectory("/other")),
      );
      yield* live.ensureReady;
      yield* registry.shutdown;
      assert.equal(counters.disposals, 2);
      yield* registry.shutdown;
      yield* TestClock.adjust("2000 millis");
      yield* Effect.yieldNow;
      assert.equal(counters.disposals, 2);
    }),
  );
});

test("host shutdown hooks are installed once, invoke shutdown, and preserve foreign listeners", async () => {
  // The module singleton installs its hooks during import. Remove those first so
  // this test can measure the registry-owned hooks exactly.
  await Effect.runPromise(brokerRegistry.shutdown);
  const events = ["beforeExit", "SIGINT", "SIGTERM"] as const;
  const foreign = () => undefined;
  process.on("beforeExit", foreign);
  const baseline = Object.fromEntries(events.map((event) => [event, process.listenerCount(event)]));
  const counters = { starts: 0, disposals: 0 };
  const registry = makeBrokerRegistry({
    canonicalize: (value) => Effect.succeed(value),
    hostShutdownHooks: true,
  });
  await run(
    Effect.gen(function* () {
      const lease = yield* registry.acquire(readyFactory(counters), options());
      yield* lease.ensureReady;
      assert.equal(process.listenerCount("beforeExit"), baseline.beforeExit + 1);
      assert.equal(process.listenerCount("SIGINT"), baseline.SIGINT + 1);
      assert.equal(process.listenerCount("SIGTERM"), baseline.SIGTERM + 1);
      const handler = process.listeners("beforeExit").find((listener) => listener !== foreign)!;
      handler();
      yield* Effect.yieldNow;
      assert.equal(counters.disposals, 1);
      yield* registry.shutdown;
      for (const event of events) assert.equal(process.listenerCount(event), baseline[event]);
      assert.equal(process.listeners("beforeExit").includes(foreign), true);
    }),
  );
  process.removeListener("beforeExit", foreign);
});

test("idleTimeoutMs zero disposes immediately without an idle phase", async () => {
  const counters = { starts: 0, disposals: 0 };
  const registry = makeBrokerRegistry({
    canonicalize: (value) => Effect.succeed(value),
    idleTimeoutMs: 0,
  });
  await run(
    Effect.gen(function* () {
      const lease = yield* registry.acquire(readyFactory(counters), options());
      yield* lease.ensureReady;
      yield* lease.release;
      assert.equal(counters.disposals, 1);
      assert.notEqual((yield* lease.status).phase, "idle");
      yield* registry.shutdown;
    }),
  );
});
