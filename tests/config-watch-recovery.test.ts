import { test } from "bun:test";
import assert from "node:assert/strict";
import { Clock, Deferred, Effect, Fiber, Layer, Scope } from "effect";
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

const tick = (seconds: number) =>
  Effect.gen(function* () {
    yield* Effect.yieldNow;
    yield* TestClock.adjust(`${seconds} seconds`);
    yield* Effect.yieldNow;
    yield* Effect.yieldNow;
    yield* Effect.promise(() => Promise.resolve());
  });

test("config watch retains a sanitized load failure and continues after a valid change", async () => {
  const directory = projectDirectory("/project");
  const configuration = await configurationFor(directory, "TOKEN");
  let loads = 0;
  let nextToken = "TOKEN";
  const scope = await Effect.runPromise(Scope.make());
  const controller = makeScopedController({
    configuration,
    factory: readyFactory(directory),
    registry: makeBrokerRegistry({ canonicalize: (path) => Effect.succeed(path) }),
    scope,
    reload: () => Effect.void,
    watchIntervalMs: 1_000,
    startEmptyGlobal: false,
  });
  await Effect.runPromise(controller.start);
  const program = Effect.gen(function* () {
    const watch = yield* controller.watch(async () => {
      loads++;
      if (loads === 1) throw new Error("raw secret should not escape");
      return configurationFor(directory, nextToken);
    });
    yield* Effect.yieldNow;
    assert.deepEqual(
      { ...controller.configuration().project?.servers.selected },
      { TOKEN: "TOKEN" },
    );
    yield* tick(2);
    const failed = yield* controller.status;
    assert.ok(loads > 1);
    assert.equal(JSON.stringify(failed).includes("raw secret"), false);
    assert.ok(failed.lastFailureAt ?? failed.scopes?.some((scope) => scope.lastFailureAt));
    nextToken = "NEXT_TOKEN";
    yield* tick(2);
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
  await Effect.runPromise(Effect.provide(program, TestClock.layer()));
});

test("config watch backs off persistent apply failures and retries a new fingerprint promptly", async () => {
  const directory = projectDirectory("/project");
  const configuration = await configurationFor(directory, "TOKEN");
  let fingerprint = "A";
  let loads = 0;
  let applies = 0;
  let failApply = true;
  let bApplied: Deferred.Deferred<void> | undefined;
  let bTarget: number | undefined;
  const scope = await Effect.runPromise(Scope.make());
  const controller = makeScopedController({
    configuration,
    factory: readyFactory(directory),
    registry: makeBrokerRegistry({ canonicalize: (path) => Effect.succeed(path) }),
    scope,
    reload: () =>
      Effect.sync(() => {
        applies++;
        return bTarget === applies && bApplied
          ? Deferred.succeed(bApplied, undefined)
          : Effect.void;
      }).pipe(
        Effect.flatMap((signal) => signal),
        Effect.flatMap(() => (failApply ? Effect.fail(new Error("apply failed")) : Effect.void)),
      ),
    watchIntervalMs: 1_000,
    startEmptyGlobal: false,
  });
  await Effect.runPromise(controller.start);
  const result = await Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const watch = yield* controller.watch(async () => {
          loads++;
          return configurationFor(directory, fingerprint);
        });
        let observedApplies = applies;
        let lastAFailureAt = 0;
        for (let i = 0; i < 600; i++) {
          yield* tick(1);
          if (applies !== observedApplies) {
            lastAFailureAt = yield* Clock.currentTimeMillis;
            observedApplies = applies;
          }
        }
        const beforeChange = applies;
        // The retry schedule is 1, 6, 16, 36, 76, 156, 316, then 616 seconds;
        // each failed replacement invokes reload for rollback as well, plus the
        // initial startup reload, so 15-17 reload calls cover this 10-minute run.
        assert.ok(
          beforeChange >= 15 && beforeChange <= 17,
          `applies=${beforeChange}, loads=${loads}`,
        );
        assert.deepEqual(
          { ...controller.configuration().project?.servers.selected },
          { TOKEN: "TOKEN" },
        );
        // The last observed A attempt is the seventh retry at 316s. Its
        // retryDelayMs(7) cap is 300s, so A's real deadline is 616s.
        const retryDeadline = lastAFailureAt + retryDelayMs(7);
        bApplied = yield* Deferred.make<void>();
        bTarget = beforeChange + 3;
        fingerprint = "B";
        failApply = false;
        for (let i = 0; i < 100 && applies < bTarget; i++) {
          yield* tick(1);
        }
        yield* Deferred.await(bApplied);
        const afterChange = applies;
        // A successful B replacement invokes reload from project acquisition,
        // observer reconciliation, and replaceProject's final reload.
        assert.equal(afterChange, beforeChange + 3);
        assert.ok((yield* Clock.currentTimeMillis) < retryDeadline);
        assert.deepEqual({ ...controller.configuration().project?.servers.selected }, { B: "B" });
        yield* Fiber.interrupt(watch);
        yield* controller.dispose;
        return { beforeChange, afterChange, loads };
      }),
      TestClock.layer(),
    ),
  );
  assert.ok(result.loads > 0);
  assert.ok(result.beforeChange >= 15 && result.beforeChange <= 17);
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
});
