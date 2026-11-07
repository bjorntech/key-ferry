import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import test from "node:test";
import { Duration, Effect, Fiber, Layer } from "effect";
import { TestClock } from "effect/testing";
import { ProjectKeyFerryManager, VarlockError, projectDirectory } from "../src/contracts.js";
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
import { readOwnershipRecords, removeOwnershipRecord } from "../src/varlock/ownership.js";

const cwd = process.cwd();
const env = {
  HTTP_PROXY: "http://127.0.0.1:43821",
  HTTPS_PROXY: "http://127.0.0.1:43821",
  NODE_EXTRA_CA_CERTS: "",
  OPENAI_API_KEY: "placeholder",
};

type Session = {
  id: string;
  uuid: string;
  ownerPid: number;
  cwd: string;
  startedAt: string;
  updatedAt: string;
  egressMode: "strict";
  env: typeof env;
  placeholderOverrides: { OPENAI_API_KEY: string };
};

type Harness = {
  service: ProcessService;
  runs: string[][];
  spawned: number[];
  signals: string[];
  sessions: Session[];
  failStop: boolean;
  failFirstStatus: boolean;
  lifecycle: unknown[];
  signalWaiters: Array<(signal: string) => void>;
};

const processError = () =>
  new ProcessError({ phase: "exit", code: "non-zero", message: "safe", stderr: "secret stderr" });

function makeHarness(): Harness {
  const h = {} as Harness;
  h.runs = [];
  h.spawned = [];
  h.signals = [];
  h.sessions = [];
  h.failStop = false;
  h.failFirstStatus = false;
  h.lifecycle = [];
  h.signalWaiters = [];
  let nextPid = 40_000;
  let statusCalls = 0;
  const exit: ProcessExit = { code: null, signal: null };

  const managed = (input: SpawnInput, pid: number): ManagedProcess => ({
    pid,
    completion: Effect.never,
    health: Effect.succeed({ pid, running: true }),
    stop: Effect.gen(function* () {
      h.signals.push("SIGTERM");
      h.signalWaiters.shift()?.("SIGTERM");
      yield* Effect.sleep(Duration.millis(input.terminateGraceMs ?? 500));
      h.signals.push("SIGKILL");
      h.signalWaiters.shift()?.("SIGKILL");
    }),
  });
  h.service = {
    spawn: (input: SpawnInput) =>
      Effect.sync(() => {
        const pid = nextPid++;
        h.spawned.push(pid);
        const certDir = input.args[input.args.indexOf("--cert-dir") + 1];
        if (certDir) {
          mkdirSync(certDir, { recursive: true, mode: 0o700 });
          const cert = `${certDir}/ca-cert.pem`;
          writeFileSync(cert, "fixture", { mode: 0o600 });
          env.NODE_EXTRA_CA_CERTS = cert;
        }
        h.sessions.push(session(pid, `uuid-${pid}`));
        return managed(input, pid);
      }),
    run: (input: RunInput): Effect.Effect<RunResult, ProcessError> =>
      Effect.gen(function* () {
        h.runs.push([...input.args]);
        if (input.args.includes("proxy") && input.args.includes("stop") && h.failStop)
          return yield* Effect.fail(processError());
        if (input.args.includes("proxy") && input.args.includes("stop")) {
          const uuid = input.args[input.args.indexOf("--session") + 1];
          h.sessions = h.sessions.filter((item) => item.uuid !== uuid);
        }
        if (input.args.includes("proxy") && input.args.includes("status")) {
          statusCalls += 1;
          if (h.failFirstStatus && statusCalls === 1)
            return { code: 0, signal: null, stdout: "{", stderr: "raw status stderr" };
          return { code: 0, signal: null, stdout: JSON.stringify(h.sessions), stderr: "banner" };
        }
        if (input.args.includes("proxy") && input.args.includes("env")) {
          const sessionId = input.args[input.args.indexOf("--session") + 1];
          const selected = h.sessions.find((item) => item.uuid === sessionId);
          return {
            code: 0,
            signal: null,
            stdout: JSON.stringify(selected?.env ?? env),
            stderr: "",
          };
        }
        return { code: 0, signal: null, stdout: "", stderr: "" };
      }),
  };
  return h;
}

function session(pid: number, uuid: string, sessionCwd = cwd): Session {
  return {
    id: uuid,
    uuid,
    ownerPid: pid,
    cwd: sessionCwd,
    startedAt: "2026-11-06T10:00:00.000Z",
    updatedAt: "2026-11-06T10:00:01.000Z",
    egressMode: "strict",
    env: { ...env },
    placeholderOverrides: { OPENAI_API_KEY: "placeholder" },
  };
}

function managerLayer(h: Harness) {
  return makeProjectKeyFerryManager(
    {
      projectDirectory: projectDirectory(cwd),
      adapter: {
        // Keep the startup reaper from consulting a real Varlock installation;
        // this suite supplies its own deterministic Process service.
        command: ["key-ferry-test-no-command"],
        environmentKeys: ["OPENAI_API_KEY"],
        startupTimeoutMs: 500,
        pollIntervalMs: 10,
        lifecycleLogger: (event) => h.lifecycle.push(event),
      },
    },
    Layer.succeed(Process, Process.of(h.service)),
  );
}

async function withManager<A>(
  h: Harness,
  f: (m: ProjectKeyFerryManager["Service"]) => Effect.Effect<A, VarlockError>,
) {
  const program = Effect.gen(function* () {
    const m = yield* ProjectKeyFerryManager;
    return yield* f(m);
  }).pipe(Effect.provide(managerLayer(h)));
  return Effect.runPromise(Effect.scoped(program));
}

test("concurrent managers stop only their own captured session UUID", async () => {
  const h = makeHarness();
  await Promise.all([
    withManager(h, (m) =>
      Effect.gen(function* () {
        yield* m.ensureStarted;
        yield* m.dispose;
      }),
    ),
    withManager(h, (m) =>
      Effect.gen(function* () {
        yield* m.ensureStarted;
        yield* m.dispose;
      }),
    ),
  ]);
  const stops = h.runs.filter((x) => x[0] === "proxy" && x[1] === "stop");
  assert.deepEqual(new Set(stops.map((x) => x.at(-1))), new Set(["uuid-40000", "uuid-40001"]));
});

test("starter termination sends SIGKILL after the bounded SIGTERM grace period", async () => {
  const h = makeHarness();
  const program = Effect.gen(function* () {
    const m = yield* ProjectKeyFerryManager;
    yield* m.ensureStarted;
    let resolveTerm!: (signal: string) => void;
    const term = new Promise<string>((resolve) => (resolveTerm = resolve));
    h.signalWaiters.push(resolveTerm);
    const dispose = yield* Effect.forkChild(m.dispose);
    const signal = yield* Effect.promise(() => term);
    assert.equal(signal, "SIGTERM");
    let resolveKill!: (signal: string) => void;
    const kill = new Promise<string>((resolve) => (resolveKill = resolve));
    h.signalWaiters.push(resolveKill);
    yield* TestClock.adjust("500 millis");
    const killed = yield* Effect.promise(() => kill);
    assert.equal(killed, "SIGKILL");
    yield* Fiber.join(dispose);
  }).pipe(Effect.provide(managerLayer(h)), Effect.provide(TestClock.layer()));
  await Effect.runPromise(Effect.scoped(program));
  assert.deepEqual(h.signals, ["SIGTERM", "SIGKILL"]);
});

test("dispose is idempotent", async () => {
  const h = makeHarness();
  await withManager(h, (m) =>
    Effect.gen(function* () {
      yield* m.ensureStarted;
      yield* m.dispose;
      yield* m.dispose;
    }),
  );
  assert.equal(h.runs.filter((x) => x[1] === "stop").length, 1);
  assert.equal(h.signals.length, 2);
});

test("capture failure reports a safe diagnostic and cleans only matching sessions", async () => {
  const h = makeHarness();
  h.failFirstStatus = true;
  h.sessions.push(session(99_999, "other"), session(40_000, "wrong-cwd", "/other"));
  await assert.rejects(
    withManager(h, (m) => m.ensureStarted),
    (error: VarlockError) =>
      error.code === "protocol_error" &&
      !("raw status stderr" in error) &&
      !error.message.includes("raw"),
  );
  const stops = h.runs.filter((x) => x[1] === "stop");
  assert.deepEqual(
    stops.map((x) => x.at(-1)),
    ["uuid-40000"],
  );
});

test("stop failure logs a constant-shaped event and retains ownership", async () => {
  const h = makeHarness();
  h.failStop = true;
  await withManager(h, (m) =>
    Effect.gen(function* () {
      yield* m.ensureStarted;
      yield* m.dispose;
    }),
  );
  assert.deepEqual(h.lifecycle, [
    { event: "stop-failed", proxySessionId: "uuid-40000" },
    { event: "stop-failed", proxySessionId: "uuid-40000" },
  ]);
  const records = await readOwnershipRecords();
  const retained = records.find((record) => record.sessionUuid === "uuid-40000");
  assert.ok(retained);
  await removeOwnershipRecord(retained.brokerKeyHash);
});
