import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Context, Effect, Fiber, Layer } from "effect";
import { ProjectKeyFerryManager, VarlockError, projectDirectory } from "../src/contracts.js";
import { makePlugin } from "../src/plugin.js";
import {
  Process,
  ProcessError,
  type ManagedProcess,
  type ProcessExit,
  type ProcessService,
  type RunInput,
  type RunResult,
  type SpawnInput,
} from "../src/services/process.js";
import { makeProjectKeyFerryManager } from "../src/varlock/manager.js";

const proxyEnv = {
  HTTP_PROXY: "http://127.0.0.1:43821",
  HTTPS_PROXY: "http://127.0.0.1:43821",
  NODE_EXTRA_CA_CERTS: "/tmp/varlock/ca-cert.pem",
  OPENAI_API_KEY: "sk-placeholder",
};
const fixtureProject = process.cwd();

type Fake = {
  readonly service: ProcessService;
  readonly starts: number[];
  readonly stops: number[];
  readonly runs: string[][];
  alive: boolean;
  reloadFails: boolean;
  dieOnReload: boolean;
  hideSessionOnReload: boolean;
  badEnvironmentOnReload: boolean;
  spawnFails: boolean;
  spawnCertDir?: string;
  strict: boolean;
  certMode: number;
  certKind: "owned" | "outside" | "symlink";
  healthGate?: Promise<void>;
  healthStarted?: () => void;
};

function fakeProcess(): Fake {
  const state: Fake = {} as Fake;
  state.starts = [];
  state.stops = [];
  state.runs = [];
  state.alive = true;
  state.reloadFails = false;
  state.dieOnReload = false;
  state.hideSessionOnReload = false;
  state.badEnvironmentOnReload = false;
  state.spawnFails = false;
  state.strict = true;
  state.certMode = 0o600;
  state.certKind = "owned";
  const exit: ProcessExit = { code: null, signal: null };
  let certPath = "/tmp/varlock/ca-cert.pem";
  const managed = (input: SpawnInput): ManagedProcess => ({
    pid: 9001,
    completion: Effect.never,
    health: Effect.suspend(() =>
      state.healthGate
        ? Effect.promise(() => {
            state.healthStarted?.();
            return state.healthGate!.then(() => ({
              pid: 9001,
              running: state.alive,
              ...(state.alive ? {} : { exit }),
            }));
          })
        : Effect.sync(() => ({
            pid: 9001,
            running: state.alive,
            ...(state.alive ? {} : { exit }),
          })),
    ),
    stop: Effect.sync(() => {
      if (state.alive) {
        state.stops.push(9001);
        state.alive = false;
      }
    }),
  });
  state.service = {
    spawn: (input: SpawnInput) =>
      Effect.gen(function* () {
        const index = input.args.indexOf("--cert-dir");
        state.spawnCertDir = index >= 0 ? input.args[index + 1] : undefined;
        if (state.spawnFails)
          return yield* Effect.fail(
            new ProcessError({ phase: "spawn", code: "spawn-failed", message: "safe" }),
          );
        state.starts.push(9001);
        const certDir = index >= 0 ? input.args[index + 1] : undefined;
        if (certDir) {
          certPath = `${certDir}/ca-cert.pem`;
          mkdirSync(certDir, { recursive: true, mode: 0o700 });
          const outsidePath = `/tmp/key-ferry-external-cert-${process.pid}.pem`;
          if (state.certKind === "outside") {
            certPath = outsidePath;
            writeFileSync(certPath, "fixture", { mode: state.certMode });
            chmodSync(certPath, state.certMode);
          } else if (state.certKind === "symlink") {
            writeFileSync(outsidePath, "fixture", { mode: state.certMode });
            chmodSync(outsidePath, state.certMode);
            symlinkSync(outsidePath, certPath);
          } else {
            writeFileSync(certPath, "fixture", { mode: state.certMode });
            chmodSync(certPath, state.certMode);
          }
        }
        return managed(input);
      }),
    run: (input: RunInput): Effect.Effect<RunResult, ProcessError> => {
      if (input.args.includes("proxy") && input.args.includes("reload") && state.reloadFails) {
        return Effect.fail(new ProcessError({ phase: "exit", code: "non-zero", message: "safe" }));
      }
      return Effect.sync(() => {
        state.runs.push([...input.args]);
        if (input.args.includes("proxy") && input.args.includes("reload") && state.dieOnReload)
          state.alive = false;
        const args = input.args.join(" ");
        if (input.args.includes("proxy") && input.args.includes("status")) {
          if (state.hideSessionOnReload && state.runs.some((run) => run.includes("reload")))
            return { code: 0, signal: null, stdout: "[]", stderr: "" };
          const record = {
            id: "abc12",
            uuid: "session-1",
            ownerPid: 9001,
            cwd: fixtureProject,
            startedAt: "2026-10-16T10:00:00.000Z",
            updatedAt: "2026-10-16T10:00:01.000Z",
            egressMode: state.strict ? "strict" : "permissive",
            env: { ...proxyEnv, NODE_EXTRA_CA_CERTS: certPath },
            placeholderOverrides: { OPENAI_API_KEY: "sk-placeholder" },
            endpointToken: "CONTROL_CANARY",
            dataPlaneToken: "DATA_CANARY",
          };
          return {
            code: 0,
            signal: null,
            stdout: JSON.stringify([record]),
            stderr: "banner must not be parsed",
          };
        }
        if (args.includes("proxy env"))
          return {
            code: 0,
            signal: null,
            stdout:
              state.badEnvironmentOnReload && state.runs.some((run) => run.includes("reload"))
                ? "{}"
                : JSON.stringify({ ...proxyEnv, NODE_EXTRA_CA_CERTS: certPath }),
            stderr: "",
          };
        return { code: 0, signal: null, stdout: "", stderr: "" };
      });
    },
  };
  return state;
}

function layer(
  fake: Fake,
  extra: Record<string, unknown> = {},
  fileOps?: { mkdtemp: typeof mkdtemp; realpath: typeof realpath; rm: typeof rm },
) {
  return makeProjectKeyFerryManager(
    {
      projectDirectory: projectDirectory(fixtureProject),
      adapter: {
        environmentKeys: ["OPENAI_API_KEY"],
        startupTimeoutMs: 500,
        pollIntervalMs: 10,
        ...extra,
      },
    },
    Layer.succeed(Process, Process.of(fake.service)),
    fileOps,
  );
}

async function inManager<A>(
  fake: Fake,
  effect: (manager: ProjectKeyFerryManager["Service"]) => Effect.Effect<A, VarlockError>,
) {
  const program = Effect.gen(function* () {
    const manager = yield* ProjectKeyFerryManager;
    return yield* effect(manager);
  }).pipe(Effect.provide(layer(fake)));
  return Effect.runPromise(Effect.scoped(program));
}

async function inManagerWithLayer<A>(
  fake: Fake,
  fileOps: { mkdtemp: typeof mkdtemp; realpath: typeof realpath; rm: typeof rm },
  effect: (manager: ProjectKeyFerryManager["Service"]) => Effect.Effect<A, VarlockError>,
) {
  const program = Effect.gen(function* () {
    const manager = yield* ProjectKeyFerryManager;
    return yield* effect(manager);
  }).pipe(Effect.provide(layer(fake, {}, fileOps)));
  return Effect.runPromise(Effect.scoped(program));
}

async function runRealPlugin(fake: Fake, operation: "startup" | "refresh") {
  let handlers: any;
  let observedStatus: any;
  const editor = {
    list: () => [],
    get: () => undefined,
    update: () => undefined,
  };
  const plugin = makePlugin({ layer: () => layer(fake) });
  const context = {
    options: {},
    location: { project: { directory: fixtureProject } },
    mcp: {
      transform: (callback: (value: typeof editor) => void) => Effect.sync(() => callback(editor)),
      reload: () => Effect.void,
    },
    rpc: {
      register: (_definition: unknown, value: unknown) =>
        Effect.gen(function* () {
          handlers = value as any;
          if (operation === "refresh") {
            yield* handlers.refresh({}, { error: () => new Error("safe") });
          }
          observedStatus = yield* handlers.status({});
          return { dispose: Effect.void, events: { emit: () => Effect.void } };
        }),
    },
  } as never;
  const program = Effect.scoped(
    Effect.gen(function* () {
      yield* plugin.effect(context);
      return observedStatus;
    }),
  ).pipe(
    Effect.timeoutOrElse({
      duration: 2_000,
      orElse: () => Effect.fail(new Error(`plugin ${operation} timed out`)),
    }),
  );
  return Effect.runPromise(program);
}

test("starts lazily, returns only placeholder-backed requested keys, and disposes its child", async () => {
  const fake = fakeProcess();
  const originalRun = fake.service.run;
  const result = await inManager(fake, (manager) =>
    Effect.gen(function* () {
      const before = yield* manager.status;
      const ready = yield* manager.ensureStarted;
      const env = yield* manager.environment;
      yield* manager.dispose;
      return { before, ready, env };
    }),
  );
  assert.equal(result.before.phase, "stopped");
  assert.equal(result.ready.phase, "ready");
  assert.equal(result.env.OPENAI_API_KEY, "sk-placeholder");
  assert.equal(result.env.HTTPS_PROXY, "http://127.0.0.1:43821");
  assert.equal("endpointToken" in result.env, false);
  assert.deepEqual(fake.starts, [9001]);
  assert.deepEqual(fake.stops, [9001]);
});

test("atomically ensures readiness and returns the matching environment", async () => {
  const fake = fakeProcess();
  const result = await inManager(fake, (manager) => manager.ensureReady);
  assert.equal(result.status.phase, "ready");
  assert.equal(result.environment.OPENAI_API_KEY, "sk-placeholder");
  assert.deepEqual(fake.starts, [9001]);
});

test("atomically refreshes readiness and returns the refreshed environment", async () => {
  const fake = fakeProcess();
  const result = await inManager(fake, (manager) =>
    Effect.gen(function* () {
      yield* manager.ensureStarted;
      return yield* manager.refreshReady;
    }),
  );
  assert.equal(result.status.phase, "ready");
  assert.equal(result.environment.OPENAI_API_KEY, "sk-placeholder");
  assert.equal(fake.starts.length, 1);
});

test("concurrent atomic startup calls share one owned process", async () => {
  const fake = fakeProcess();
  const result = await inManager(fake, (manager) =>
    Effect.all([manager.ensureReady, manager.ensureReady], { concurrency: "unbounded" }),
  );
  assert.equal(result[0].status.generation, result[1].status.generation);
  assert.equal(result[0].environment.OPENAI_API_KEY, result[1].environment.OPENAI_API_KEY);
  assert.deepEqual(fake.starts, [9001]);
});

test("real plugin startup uses the manager's atomic lifecycle operation", async () => {
  const fake = fakeProcess();
  const status = await runRealPlugin(fake, "startup");
  assert.equal(status.phase, "ready");
  assert.equal(fake.starts.length, 1);
});

test("real plugin refresh uses one permit and keeps status/environment coherent", async () => {
  const fake = fakeProcess();
  const status = await runRealPlugin(fake, "refresh");
  assert.equal(status.phase, "ready");
  assert.equal(status.generation, 1);
  assert.equal(fake.starts.length, 1);
  assert.equal(fake.runs.filter((run) => run.includes("reload")).length, 1);
});

test("typed spawn failure enters failed state and can retry without an owned child", async () => {
  const fake = fakeProcess();
  fake.spawnFails = true;
  const result = await inManager(fake, (manager) =>
    Effect.gen(function* () {
      const failure = yield* manager.ensureStarted.pipe(Effect.flip);
      const failed = yield* manager.status;
      const unavailable = yield* manager.environment.pipe(Effect.flip);
      fake.spawnFails = false;
      const retry = yield* manager.ensureStarted;
      return { failure, failed, unavailable, retry };
    }),
  );
  assert.equal(result.failure.code, "start_failed");
  assert.equal(result.failed.phase, "failed");
  assert.equal(result.failed.generation, 1);
  assert.equal(result.unavailable.code, "not_ready");
  assert.equal(result.retry.phase, "ready");
  assert.equal(result.retry.generation, 1);
  assert.deepEqual(fake.stops, [9001]);
  assert.equal(existsSync(fake.spawnCertDir!), false);
});

test("accepts a Varlock public CA certificate with mode 0644", async () => {
  const fake = fakeProcess();
  fake.certMode = 0o644;
  const status = await inManager(fake, (manager) => manager.ensureStarted);
  assert.equal(status.phase, "ready");
});

test("rejects writable CA certificates but retains containment checks", async () => {
  for (const mode of [0o664, 0o666]) {
    const fake = fakeProcess();
    fake.certMode = mode;
    await assert.rejects(
      inManager(fake, (manager) => manager.ensureStarted),
      (error: unknown) => error instanceof VarlockError && error.code === "protocol_error",
    );
    assert.deepEqual(fake.stops, [9001]);
  }
  for (const kind of ["outside", "symlink"] as const) {
    const fake = fakeProcess();
    fake.certKind = kind;
    await assert.rejects(
      inManager(fake, (manager) => manager.ensureStarted),
      (error: unknown) => error instanceof VarlockError && error.code === "protocol_error",
    );
    unlinkSync(`/tmp/key-ferry-external-cert-${process.pid}.pem`);
  }
});

test("rejects permissive egress and cleans up the owned process", async () => {
  const fake = fakeProcess();
  fake.strict = false;
  await assert.rejects(
    inManager(fake, (manager) => manager.ensureStarted),
    (error: unknown) => error instanceof VarlockError && error.code === "invalid_config",
  );
  assert.deepEqual(fake.stops, [9001]);
});

test("does not adopt another PID/session and reports startup timeout safely", async () => {
  const fake = fakeProcess();
  fake.service.run = (input: RunInput) =>
    Effect.sync(() => ({
      code: 0,
      signal: null,
      stdout:
        input.args.includes("proxy") && input.args.includes("status")
          ? "[]"
          : JSON.stringify(proxyEnv),
      stderr: "raw-secret-canary",
    }));
  await assert.rejects(
    inManager(fake, (manager) => manager.ensureStarted),
    (error: unknown) => error instanceof VarlockError && error.code === "timeout",
  );
  assert.equal(fake.stops.length, 1);
});

test("refresh failure closes the environment capability and increments generation", async () => {
  const fake = fakeProcess();
  const result = await inManager(fake, (manager) =>
    Effect.gen(function* () {
      yield* manager.ensureStarted;
      const before = yield* manager.status;
      fake.reloadFails = true;
      const failure = yield* manager.refresh.pipe(Effect.flip);
      const after = yield* manager.status;
      const closed = yield* manager.environment.pipe(Effect.flip);
      return { before, failure, after, closed };
    }),
  );
  assert.equal(result.failure.code, "refresh_failed");
  assert.equal(result.after.phase, "failed");
  assert.ok(result.after.generation > result.before.generation);
  assert.equal(result.closed.code, "not_ready");
});

test("refresh starts a stopped manager through the readiness transition", async () => {
  const fake = fakeProcess();
  const result = await inManager(fake, (manager) => manager.refresh);
  assert.equal(result.phase, "ready");
  assert.equal(fake.starts.length, 1);
});

test("refresh rejects an ended owned session", async () => {
  const fake = fakeProcess();
  fake.hideSessionOnReload = true;
  const result = await inManager(fake, (manager) =>
    Effect.gen(function* () {
      yield* manager.ensureStarted;
      const failure = yield* manager.refresh.pipe(Effect.flip);
      const status = yield* manager.status;
      return { failure, status };
    }),
  );
  assert.equal(result.failure.code, "refresh_failed");
  assert.equal(result.status.phase, "failed");
});

test("refresh maps environment handshake failures and rejects permissive egress", async () => {
  const malformed = fakeProcess();
  malformed.badEnvironmentOnReload = true;
  const malformedResult = await inManager(malformed, (manager) =>
    Effect.gen(function* () {
      yield* manager.ensureStarted;
      return yield* manager.refresh.pipe(Effect.flip);
    }),
  );
  assert.equal(malformedResult.code, "refresh_failed");

  const permissive = fakeProcess();
  const permissiveResult = await inManager(permissive, (manager) =>
    Effect.gen(function* () {
      yield* manager.ensureStarted;
      permissive.strict = false;
      return yield* manager.refresh.pipe(Effect.flip);
    }),
  );
  assert.equal(permissiveResult.code, "refresh_failed");
});

test("refresh after disposal remains unavailable", async () => {
  const fake = fakeProcess();
  const result = await inManager(fake, (manager) =>
    Effect.gen(function* () {
      yield* manager.dispose;
      const start = yield* manager.ensureStarted.pipe(Effect.flip);
      const refresh = yield* manager.refresh.pipe(Effect.flip);
      return { start, refresh };
    }),
  );
  assert.equal(result.start.code, "disposed");
  assert.equal(result.refresh.code, "disposed");
});

test("serializes concurrent starts to one owned process", async () => {
  const fake = fakeProcess();
  const result = await inManager(fake, (manager) =>
    Effect.all([manager.ensureStarted, manager.ensureStarted], { concurrency: "unbounded" }),
  );
  assert.equal(fake.starts.length, 1);
  assert.equal(result[0].phase, "ready");
  assert.equal(result[1].phase, "ready");
});

test("unexpected process death clears readiness without throwing status", async () => {
  const fake = fakeProcess();
  const result = await inManager(fake, (manager) =>
    Effect.gen(function* () {
      yield* manager.ensureStarted;
      fake.alive = false;
      const status = yield* manager.status;
      return status;
    }),
  );
  assert.equal(result.phase, "degraded");
  assert.equal(result.error?.code, "unavailable");
});

test("cancelling preflight health preserves the previously ready capability", async () => {
  const fake = fakeProcess();
  let release!: () => void;
  const healthGate = new Promise<void>((resolve) => (release = resolve));
  let healthStarted!: () => void;
  const started = new Promise<void>((resolve) => (healthStarted = resolve));
  const result = await inManager(fake, (manager) =>
    Effect.gen(function* () {
      yield* manager.ensureStarted;
      const before = yield* manager.status;
      fake.healthGate = healthGate;
      fake.healthStarted = healthStarted;
      const startup = yield* Effect.forkScoped(manager.ensureStarted);
      yield* Effect.promise(() => started);
      yield* Fiber.interrupt(startup);
      fake.healthGate = undefined;
      release();
      const after = yield* manager.status;
      const environment = yield* manager.environment;
      return { before, after, environment };
    }),
  );

  assert.equal(result.before.phase, "ready");
  assert.equal(result.after.phase, "ready");
  assert.equal(result.after.generation, result.before.generation);
  assert.equal(result.after.pid, result.before.pid);
  assert.equal(result.environment.OPENAI_API_KEY, "sk-placeholder");
  assert.deepEqual(fake.starts, [9001]);
  assert.deepEqual(fake.stops, [9001]);
});

test("failed canonical cert-path setup is coherent and retryable", async () => {
  const fake = fakeProcess();
  const originalRun = fake.service.run;
  let signalStarted!: () => void;
  const started = new Promise<void>((resolve) => (signalStarted = resolve));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let failCanonical = false;
  let candidate!: string;
  const fileOps = {
    mkdtemp: async (prefix: string) => {
      candidate = await mkdtemp(prefix);
      return candidate;
    },
    realpath: async (path: string) => {
      if (failCanonical) throw new Error("injected realpath failure");
      return realpath(path);
    },
    rm,
  };
  fake.service.run = (input: RunInput) => {
    if (input.args.includes("proxy") && input.args.includes("status")) {
      signalStarted();
      return Effect.promise(() => gate.then(() => Effect.runPromise(originalRun(input))));
    }
    return originalRun(input);
  };
  const result = await inManagerWithLayer(fake, fileOps, (manager) =>
    Effect.gen(function* () {
      const startup = yield* Effect.forkScoped(manager.ensureStarted);
      yield* Effect.promise(() => started);
      yield* Fiber.interrupt(startup);
      failCanonical = true;
      release();
      const failure = yield* manager.ensureStarted.pipe(Effect.flip);
      const failed = yield* manager.status;
      failCanonical = false;
      const retry = yield* manager.ensureStarted;
      return { failure, failed, retry };
    }),
  );

  assert.equal(result.failure.code, "start_failed");
  assert.equal(result.failed.phase, "failed");
  assert.equal(result.retry.phase, "ready");
  assert.equal(existsSync(candidate), false);
  assert.deepEqual(fake.starts, [9001, 9001]);
});

test("late cert-directory creation after cancellation is finalized and retryable", async () => {
  const fake = fakeProcess();
  let resolveCreation!: (directory: string) => void;
  let signalCreationStarted!: () => void;
  const creationStarted = new Promise<void>((resolve) => (signalCreationStarted = resolve));
  let first = true;
  let lateDirectory!: string;
  let retryDirectory!: string;
  const fileOps = {
    mkdtemp: (prefix: string) => {
      if (!first) {
        return mkdtemp(prefix).then((directory) => {
          retryDirectory = directory;
          return directory;
        });
      }
      first = false;
      signalCreationStarted();
      return new Promise<string>((resolve) => (resolveCreation = resolve));
    },
    realpath,
    rm,
  };
  const result = await inManagerWithLayer(fake, fileOps, (manager) =>
    Effect.gen(function* () {
      const startup = yield* Effect.forkScoped(manager.ensureStarted);
      yield* Effect.promise(() => creationStarted);
      yield* Effect.sync(() => startup.interruptUnsafe());
      yield* Effect.yieldNow;
      lateDirectory = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "key-ferry-late-")));
      resolveCreation(lateDirectory);
      yield* Effect.exit(Fiber.join(startup));
      const interrupted = yield* manager.status;
      const retry = yield* manager.ensureStarted;
      return { interrupted, retry };
    }),
  );

  assert.equal(result.interrupted.phase, "failed");
  assert.equal(result.interrupted.generation, 1);
  assert.equal(result.retry.phase, "ready");
  assert.notEqual(retryDirectory, lateDirectory);
  assert.equal(existsSync(lateDirectory), false);
});

test("cert cleanup failure retains the path for finalizer retry", async () => {
  const fake = fakeProcess();
  const originalRun = fake.service.run;
  let signalStarted!: () => void;
  const started = new Promise<void>((resolve) => (signalStarted = resolve));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const directories: string[] = [];
  let failRemove = true;
  const fileOps = {
    mkdtemp: async (prefix: string) => {
      const directory = await mkdtemp(prefix);
      directories.push(directory);
      return directory;
    },
    realpath,
    rm: async (path: string, options: Parameters<typeof rm>[1]) => {
      if (failRemove) {
        failRemove = false;
        throw new Error("injected rm failure");
      }
      return rm(path, options);
    },
  };
  fake.service.run = (input: RunInput) => {
    if (input.args.includes("proxy") && input.args.includes("status")) {
      signalStarted();
      return Effect.promise(() => gate.then(() => Effect.runPromise(originalRun(input))));
    }
    return originalRun(input);
  };

  await inManagerWithLayer(fake, fileOps, (manager) =>
    Effect.gen(function* () {
      const startup = yield* Effect.forkScoped(manager.ensureReady);
      yield* Effect.promise(() => started);
      yield* Fiber.interrupt(startup);
      release();
      return yield* manager.ensureReady;
    }),
  );

  assert.equal(directories.length, 2);
  assert.equal(existsSync(directories[0]!), false);
  assert.equal(existsSync(directories[1]!), false);
});

test("interrupting startup stops the acquired handle and invalidates its capability", async () => {
  const fake = fakeProcess();
  const originalRun = fake.service.run;
  let signalStarted!: () => void;
  const started = new Promise<void>((resolve) => (signalStarted = resolve));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  fake.service.run = (input: RunInput) => {
    if (input.args.includes("proxy") && input.args.includes("status")) {
      signalStarted();
      return Effect.promise(() => gate.then(() => Effect.runPromise(originalRun(input))));
    }
    return originalRun(input);
  };

  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const manager = yield* ProjectKeyFerryManager;
        const startup = yield* Effect.forkScoped(manager.ensureReady);
        yield* Effect.promise(() => started);
        const firstCertDirectory = fake.spawnCertDir!;
        yield* Fiber.interrupt(startup);
        const interrupted = yield* manager.status;
        release();
        const retry = yield* manager.ensureReady;
        return { interrupted, retry, firstCertDirectory };
      }).pipe(Effect.provide(layer(fake))),
    ),
  );

  assert.equal(result.interrupted.phase, "failed");
  assert.equal(result.interrupted.generation, 1);
  assert.equal(result.interrupted.error?.code, "timeout");
  assert.equal(result.retry.status.phase, "ready");
  assert.equal(fake.starts.length, 2);
  assert.deepEqual(fake.stops, [9001]);
  assert.equal(existsSync(result.firstCertDirectory), false);
});

test("interrupting spawn cleanup leaves no claimed handle and keeps the permit usable", async () => {
  const fake = fakeProcess();
  let signalSpawn!: () => void;
  const spawned = new Promise<void>((resolve) => (signalSpawn = resolve));
  fake.service.spawn = () => Effect.sync(signalSpawn).pipe(Effect.andThen(Effect.never));
  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const manager = yield* ProjectKeyFerryManager;
        const startup = yield* Effect.forkScoped(manager.ensureStarted);
        yield* Effect.promise(() => spawned);
        yield* Fiber.interrupt(startup);
        return yield* manager.status;
      }).pipe(Effect.provide(layer(fake))),
    ),
  );

  assert.equal(result.phase, "failed");
  assert.equal(result.generation, 1);
  assert.equal(fake.stops.length, 0);
});

test("interrupting refresh closes the old environment capability", async () => {
  const fake = fakeProcess();
  const originalRun = fake.service.run;
  let signalReload!: () => void;
  const reloading = new Promise<void>((resolve) => (signalReload = resolve));
  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const manager = yield* ProjectKeyFerryManager;
        // Establish readiness before replacing the fake command behavior.
        fake.service.run = (input: RunInput) => {
          if (input.args.includes("reload")) {
            signalReload();
            return Effect.never;
          }
          return originalRun(input);
        };
        yield* manager.ensureStarted;
        const refresh = yield* Effect.forkScoped(manager.refresh);
        yield* Effect.promise(() => reloading);
        yield* Fiber.interrupt(refresh);
        const status = yield* manager.status;
        const environment = yield* manager.environment.pipe(Effect.flip);
        return { status, environment };
      }).pipe(Effect.provide(layer(fake))),
    ),
  );

  assert.equal(result.status.phase, "failed");
  assert.equal(result.status.generation, 1);
  assert.equal(result.environment.code, "not_ready");
  assert.deepEqual(fake.stops, [9001]);
});
