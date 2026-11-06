import { test } from "bun:test";
import assert from "node:assert/strict";
import { Clock, Deferred, Effect, Exit, Fiber, Layer, Option, Queue, Scope } from "effect";
import { TestClock } from "effect/testing";
import { makeBrokerRegistry, retryDelayMs } from "../src/broker-registry.js";
import { ProjectKeyFerryManager, projectDirectory, VarlockError } from "../src/contracts.js";
import { loadScopedConfiguration } from "../src/scoped-config.js";
import { makeScopedController } from "../src/scoped-controller.js";

const configurationFor = (directory: string, token: string) =>
  loadScopedConfiguration(
    { projectConfig: { enabled: true, activation: "auto" }, servers: {} },
    { project: { directory } },
    {
      readFile: async () =>
        JSON.stringify({ enabled: true, servers: { selected: { env: [token] } } }),
      realpath: async (path) => path,
    },
  );

const readyFactory = (directory: string) => {
  let generations = 0;
  return {
    layer: () => {
      const generation = ++generations;
      const status = { phase: "ready" as const, projectDirectory: directory, generation };
      return Layer.succeed(ProjectKeyFerryManager, {
        status: Effect.succeed(status),
        ensureStarted: Effect.succeed(status),
        ensureReady: Effect.succeed({ status, environment: { TOKEN: "placeholder" } }),
        environment: Effect.succeed({ TOKEN: "placeholder" }),
        refresh: Effect.succeed(status),
        refreshReady: Effect.succeed({ status, environment: { TOKEN: "placeholder" } }),
        dispose: Effect.void,
        withExclusive: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
      });
    },
  };
};

type WatchEvent = { type: "load"; tick: number } | { type: "reload"; ok: boolean };

const takeWatchEvent = (events: Queue.Queue<WatchEvent>, label: string) =>
  Effect.gen(function* () {
    for (let i = 0; i < 1000; i++) {
      const event = yield* Queue.poll(events);
      if (Option.isSome(event)) return event.value;
      yield* Effect.yieldNow;
      yield* Effect.promise(() => Promise.resolve());
    }
    return yield* Effect.fail(new Error(`timed out waiting for ${label}`));
  });

const stepWatch = (events: Queue.Queue<WatchEvent>, seconds: number, reloads = 0) =>
  Effect.gen(function* () {
    yield* Effect.yieldNow;
    yield* TestClock.adjust(`${seconds} seconds`);
    let load = yield* takeWatchEvent(events, "load");
    while (load.type === "reload") load = yield* takeWatchEvent(events, "load");
    for (let i = 0; i < reloads; i++) {
      let reload = yield* takeWatchEvent(events, "reload");
      while (reload.type === "load") reload = yield* takeWatchEvent(events, "reload");
    }
  });

test("config watch retains a sanitized load failure and continues after a valid change", async () => {
  const directory = projectDirectory("/project");
  const configuration = await configurationFor(directory, "TOKEN");
  const nextConfiguration = await configurationFor(directory, "NEXT_TOKEN");
  let loads = 0;
  let nextConfigurationReady = false;
  let events: Queue.Queue<WatchEvent> | undefined;
  let watching = false;
  const signal = (event: WatchEvent) => {
    if (watching && events) Effect.runSync(Queue.offer(events, event));
  };
  const scope = await Effect.runPromise(Scope.make());
  const controller = makeScopedController({
    configuration,
    factory: readyFactory(directory),
    registry: makeBrokerRegistry({ canonicalize: (path) => Effect.succeed(path) }),
    scope,
    reload: () => Effect.sync(() => signal({ type: "reload", ok: true })),
    watchIntervalMs: 1_000,
    startEmptyGlobal: false,
  });
  await Effect.runPromise(controller.start);
  events = await Effect.runPromise(Queue.unbounded<WatchEvent>());
  const program = Effect.gen(function* () {
    watching = true;
    const watch = yield* controller.watch(async () => {
      loads++;
      signal({ type: "load", tick: loads });
      if (loads === 1) throw new Error("raw secret should not escape");
      return nextConfigurationReady ? nextConfiguration : configuration;
    });
    yield* Effect.yieldNow;
    assert.deepEqual(
      { ...controller.configuration().project?.servers.selected },
      { TOKEN: "TOKEN" },
    );
    yield* stepWatch(events!, 2);
    const failed = yield* controller.status;
    assert.ok(loads > 1);
    assert.equal(JSON.stringify(failed).includes("raw secret"), false);
    assert.ok(failed.lastFailureAt ?? failed.scopes?.some((scope) => scope.lastFailureAt));
    nextConfigurationReady = true;
    yield* stepWatch(events!, 1, 3);
    assert.deepEqual(
      { ...controller.configuration().project?.servers.selected },
      {
        NEXT_TOKEN: "NEXT_TOKEN",
      },
    );
    assert.deepEqual((yield* controller.status).diagnostics ?? [], []);
    yield* Fiber.interrupt(watch);
    yield* controller.dispose;
  });
  try {
    await Effect.runPromise(Effect.provide(program, TestClock.layer()));
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }
});

test("config watch backs off persistent apply failures and retries a new fingerprint promptly", async () => {
  const directory = projectDirectory("/project");
  const configuration = await configurationFor(directory, "TOKEN");
  const aConfiguration = await configurationFor(directory, "A");
  const nextConfiguration = await configurationFor(directory, "B");
  let fingerprint: "A" | "B" = "A";
  let loads = 0;
  let applies = 0;
  let failApply = true;
  let events: Queue.Queue<WatchEvent> | undefined;
  let watching = false;
  const signal = (event: WatchEvent) => {
    if (watching && events) Effect.runSync(Queue.offer(events, event));
  };
  const configurations = { A: aConfiguration, B: nextConfiguration };
  const scope = await Effect.runPromise(Scope.make());
  const controller = makeScopedController({
    configuration,
    factory: readyFactory(directory),
    registry: makeBrokerRegistry({ canonicalize: (path) => Effect.succeed(path) }),
    scope,
    reload: () =>
      Effect.sync(() => {
        applies++;
      }).pipe(
        Effect.flatMap(() => (failApply ? Effect.fail(new Error("apply failed")) : Effect.void)),
        Effect.tapError(() => Effect.sync(() => signal({ type: "reload", ok: false }))),
        Effect.tap(() => Effect.sync(() => signal({ type: "reload", ok: true }))),
      ),
    watchIntervalMs: 1_000,
    startEmptyGlobal: false,
  });
  await Effect.runPromise(controller.start);
  events = await Effect.runPromise(Queue.unbounded<WatchEvent>());
  const result = await Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        // start may finish its initial reconciliation on the next scheduler turn.
        yield* Effect.yieldNow;
        watching = true;
        const watch = yield* controller.watch(async () => {
          loads++;
          signal({ type: "load", tick: loads });
          return configurations[fingerprint];
        });
        const retryTimes = [1, 6, 16, 36, 76, 156, 316];
        let previous = 0;
        let lastAFailureAt = 0;
        for (const retryTime of retryTimes) {
          yield* stepWatch(events!, retryTime - previous, 2);
          previous = retryTime;
          lastAFailureAt = yield* Clock.currentTimeMillis;
        }
        const beforeChange = applies;
        assert.ok(beforeChange >= 15 && beforeChange <= 17);
        assert.deepEqual(
          { ...controller.configuration().project?.servers.selected },
          { TOKEN: "TOKEN" },
        );
        // The seventh A failure is at 316s; its capped retry deadline is 616s.
        const retryDeadline = lastAFailureAt + retryDelayMs(7);
        fingerprint = "B";
        failApply = false;
        yield* stepWatch(events!, 1, 3);
        const firstBApplyAt = yield* Clock.currentTimeMillis;
        assert.ok(firstBApplyAt < retryDeadline);
        const afterChange = applies;
        assert.equal(afterChange, beforeChange + 3);
        assert.deepEqual({ ...controller.configuration().project?.servers.selected }, { B: "B" });
        yield* Fiber.interrupt(watch);
        yield* controller.dispose;
        return { beforeChange, afterChange, loads };
      }),
      TestClock.layer(),
    ),
  );
  assert.ok(result.loads > 1);
  assert.ok(result.beforeChange >= 15 && result.beforeChange <= 17);
  await Effect.runPromise(Scope.close(scope, Exit.void));
});

const testConfiguration = () =>
  loadScopedConfiguration(
    { projectConfig: { activation: "auto" }, servers: { selected: { env: ["TOKEN"] } } },
    { project: { directory: projectDirectory("/project") } },
    { readFile: async () => "", realpath: async (path) => path },
  );

test("observer failure clear preserves failure retry metadata", async () => {
  const configuration = await testConfiguration();
  const scope = await Effect.runPromise(Scope.make());
  const failure = new VarlockError({ code: "start_failed", message: "failed", retryable: true });
  const status = {
    phase: "ready" as const,
    projectDirectory: projectDirectory("/project"),
    generation: 1,
  };
  const controller = makeScopedController({
    configuration,
    factory: {
      layer: () =>
        Layer.succeed(ProjectKeyFerryManager, {
          status: Effect.succeed(status),
          ensureStarted: Effect.succeed(status),
          ensureReady: Effect.fail(failure),
          environment: Effect.succeed({}),
          refresh: Effect.succeed(status),
          refreshReady: Effect.fail(failure),
          dispose: Effect.void,
          withExclusive: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
        }),
    },
    registry: makeBrokerRegistry({ canonicalize: (path) => Effect.succeed(path) }),
    scope,
    reload: () => Effect.void,
    startEmptyGlobal: true,
  });
  await Effect.runPromise(controller.start);
  await Effect.runPromise(Effect.yieldNow);
  const current = controller.runtimes.get("global")?.status;
  assert.ok(current.lastFailureAt);
  assert.ok(current.nextRetryAt);
  await Effect.runPromise(controller.dispose);
  await Effect.runPromise(Scope.close(scope, Exit.void));
});

test("initial acquire failure records failure retry metadata", async () => {
  const configuration = await testConfiguration();
  const scope = await Effect.runPromise(Scope.make());
  const controller = makeScopedController({
    configuration,
    factory: { layer: () => Layer.fail(new Error("unavailable")) },
    registry: makeBrokerRegistry({ canonicalize: () => Effect.fail(new Error("unavailable")) }),
    scope,
    reload: () => Effect.void,
    startEmptyGlobal: true,
  });
  await Effect.runPromise(controller.start);
  await Effect.runPromise(Effect.yieldNow);
  const current = controller.runtimes.get("global")?.status;
  assert.ok(current.lastFailureAt);
  assert.ok(current.nextRetryAt);
  await Effect.runPromise(controller.dispose);
  await Effect.runPromise(Scope.close(scope, Exit.void));
});
