import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Effect, Fiber, Layer } from "effect";
import { ProjectKeyFerryManager, projectDirectory, VarlockError } from "../src/contracts.js";
import {
  Process,
  ProcessError,
  type ManagedProcess,
  type ProcessService,
  type RunInput,
  type RunResult,
} from "../src/services/process.js";
import { makeProjectKeyFerryManager } from "../src/varlock/manager.js";
import {
  ownershipDirectory,
  ownershipFileOps,
  readOwnershipRecords,
} from "../src/varlock/ownership.js";

const cwd = process.cwd();

type Fixture = {
  calls: string[][];
  lifecycle: unknown[];
  stopResults: boolean[];
  alive: boolean;
  reloadFails: boolean;
  blockEnvironment: boolean;
  environmentStarted?: () => void;
  service: ProcessService;
};

function fixture(root: string): Fixture {
  const f = {} as Fixture;
  f.calls = [];
  f.lifecycle = [];
  f.stopResults = [];
  f.alive = true;
  f.reloadFails = false;
  f.blockEnvironment = false;
  const session: {
    id: string;
    uuid: string;
    ownerPid: number;
    cwd: string;
    startedAt: string;
    updatedAt: string;
    egressMode: "strict";
    env: Record<string, string>;
    placeholderOverrides: { OPENAI_API_KEY: string };
  } = {
    id: "captured-uuid",
    uuid: "captured-uuid",
    ownerPid: 7123,
    cwd,
    startedAt: "2026-11-06T10:00:00.000Z",
    updatedAt: "2026-11-06T10:00:00.000Z",
    egressMode: "strict",
    env: {
      HTTP_PROXY: "http://127.0.0.1:43821",
      HTTPS_PROXY: "http://127.0.0.1:43821",
      NODE_EXTRA_CA_CERTS: join(root, "ca-cert.pem"),
    },
    placeholderOverrides: { OPENAI_API_KEY: "placeholder" },
  };
  f.service = {
    spawn: (input) =>
      Effect.sync(() => {
        const certDir = input.args[input.args.indexOf("--cert-dir") + 1]!;
        mkdirSync(certDir, { recursive: true });
        writeFileSync(join(certDir, "ca-cert.pem"), "fixture");
        session.env.NODE_EXTRA_CA_CERTS = join(certDir, "ca-cert.pem");
        const process: ManagedProcess = {
          pid: 7123,
          completion: Effect.never,
          health: Effect.sync(() => ({
            pid: 7123,
            running: f.alive,
            ...(f.alive ? {} : { exit: { code: 1, signal: null } }),
          })),
          stop: Effect.void,
        };
        return process;
      }),
    run: (input: RunInput): Effect.Effect<RunResult, ProcessError> => {
      f.calls.push([...input.args]);
      if (input.args.includes("stop")) {
        const succeeded = f.stopResults.shift() ?? true;
        return succeeded
          ? Effect.succeed({ code: 0, signal: null, stdout: "", stderr: "" })
          : Effect.fail(
              new ProcessError({ phase: "exit", code: "non-zero", message: "private detail" }),
            );
      }
      if (input.args.includes("reload") && f.reloadFails)
        return Effect.fail(
          new ProcessError({ phase: "exit", code: "non-zero", message: "private reload detail" }),
        );
      if (input.args.includes("status"))
        return Effect.succeed({
          code: 0,
          signal: null,
          stdout: JSON.stringify([session]),
          stderr: "",
        });
      if (input.args.includes("env") && f.blockEnvironment) {
        f.environmentStarted?.();
        return Effect.never;
      }
      if (input.args.includes("env"))
        return Effect.succeed({
          code: 0,
          signal: null,
          stdout: JSON.stringify({ ...session.env, OPENAI_API_KEY: "placeholder" }),
          stderr: "",
        });
      return Effect.succeed({ code: 0, signal: null, stdout: "", stderr: "" });
    },
  };
  return f;
}

function layer(f: Fixture, root: string) {
  return makeProjectKeyFerryManager(
    {
      projectDirectory: projectDirectory(cwd),
      adapter: {
        command: ["varlock"],
        environmentKeys: ["OPENAI_API_KEY"],
        ownershipDirectory: ownershipDirectory(root),
        startupTimeoutMs: 1_000,
        pollIntervalMs: 10,
        lifecycleLogger: (event) => f.lifecycle.push(event),
      },
    },
    Layer.succeed(Process, Process.of(f.service)),
  );
}

async function withManager<A>(
  f: Fixture,
  root: string,
  run: (m: ProjectKeyFerryManager["Service"]) => Effect.Effect<A, VarlockError>,
) {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        return yield* run(yield* ProjectKeyFerryManager);
      }).pipe(Effect.provide(layer(f, root))),
    ),
  );
}

async function records(root: string) {
  return readOwnershipRecords(ownershipFileOps(ownershipDirectory(root)));
}

function stops(f: Fixture) {
  return f.calls.filter((call) => call[0] === "proxy" && call[1] === "stop");
}

test("interrupted startup keeps a captured session and ownership after stop failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "key-ferry-stop-failure-"));
  const f = fixture(root);
  f.stopResults.push(false, false);
  let release!: () => void;
  const started = new Promise<void>((resolve) => (release = resolve));
  f.blockEnvironment = true;
  f.environmentStarted = release;
  const result = await withManager(f, root, (m) =>
    Effect.gen(function* () {
      const startup = yield* Effect.forkScoped(m.ensureStarted);
      yield* Effect.promise(() => started);
      yield* Fiber.interrupt(startup);
      return yield* m.status;
    }),
  );
  assert.deepEqual(
    stops(f).map((call) => call.at(-1)),
    ["captured-uuid", "captured-uuid"],
  );
  assert.equal((await records(root)).length, 1);
  assert.deepEqual(f.lifecycle, [
    { event: "stop-failed", proxySessionId: "captured-uuid" },
    { event: "stop-failed", proxySessionId: "captured-uuid" },
  ]);
  assert.equal(result.proxySessionId, "captured-uuid");
  await rm(root, { recursive: true, force: true });
});

test("interrupted startup clears ownership and session after stop success", async () => {
  const root = await mkdtemp(join(tmpdir(), "key-ferry-stop-success-"));
  const f = fixture(root);
  f.stopResults.push(true);
  let release!: () => void;
  const started = new Promise<void>((resolve) => (release = resolve));
  f.blockEnvironment = true;
  f.environmentStarted = release;
  const result = await withManager(f, root, (m) =>
    Effect.gen(function* () {
      const startup = yield* Effect.forkScoped(m.ensureStarted);
      yield* Effect.promise(() => started);
      yield* Fiber.interrupt(startup);
      return yield* m.status;
    }),
  );
  assert.deepEqual(
    stops(f).map((call) => call.at(-1)),
    ["captured-uuid"],
  );
  assert.equal((await records(root)).length, 0);
  assert.equal(result.proxySessionId, undefined);
  await rm(root, { recursive: true, force: true });
});

test("refresh stop failure retains ownership and dispose retries the same UUID", async () => {
  const root = await mkdtemp(join(tmpdir(), "key-ferry-refresh-stop-"));
  const f = fixture(root);
  f.stopResults.push(false, true);
  f.reloadFails = true;
  const result = await withManager(f, root, (m) =>
    Effect.gen(function* () {
      yield* m.ensureStarted;
      const failure = yield* m.refresh.pipe(Effect.flip);
      const failed = yield* m.status;
      yield* m.dispose;
      const stopped = yield* m.status;
      return { failure, failed, stopped };
    }),
  );
  assert.equal(result.failure.code, "refresh_failed");
  assert.equal(result.failed.proxySessionId, "captured-uuid");
  assert.equal(result.stopped.proxySessionId, undefined);
  assert.deepEqual(
    stops(f).map((call) => call.at(-1)),
    ["captured-uuid", "captured-uuid"],
  );
  assert.equal((await records(root)).length, 0);
  assert.deepEqual(f.lifecycle, [{ event: "stop-failed", proxySessionId: "captured-uuid" }]);
  await rm(root, { recursive: true, force: true });
});

test("dispose retries a failed stop and then clears the captured session", async () => {
  const root = await mkdtemp(join(tmpdir(), "key-ferry-dispose-stop-"));
  const f = fixture(root);
  f.stopResults.push(false, true);
  const result = await withManager(f, root, (m) =>
    Effect.gen(function* () {
      yield* m.ensureStarted;
      yield* m.dispose;
      const failed = yield* m.status;
      yield* m.dispose;
      return { failed, stopped: yield* m.status };
    }),
  );
  assert.equal(result.failed.proxySessionId, "captured-uuid");
  assert.equal(result.stopped.proxySessionId, undefined);
  assert.deepEqual(
    stops(f).map((call) => call.at(-1)),
    ["captured-uuid", "captured-uuid"],
  );
  assert.equal((await records(root)).length, 0);
  await rm(root, { recursive: true, force: true });
});

test("a stale session with failed stop is retained and never starts a second proxy", async () => {
  const root = await mkdtemp(join(tmpdir(), "key-ferry-stale-stop-"));
  const f = fixture(root);
  f.stopResults.push(false, false, false);
  const result = await withManager(f, root, (m) =>
    Effect.gen(function* () {
      yield* m.ensureStarted;
      f.alive = false;
      const degraded = yield* m.status;
      const retry = yield* m.ensureStarted.pipe(Effect.flip);
      return { degraded, retry };
    }),
  );
  assert.equal(result.degraded.proxySessionId, "captured-uuid");
  assert.equal(result.retry.code, "unavailable");
  assert.equal(f.calls.filter((call) => call.includes("start")).length, 0);
  assert.equal((await records(root)).length, 1);
  await rm(root, { recursive: true, force: true });
});
