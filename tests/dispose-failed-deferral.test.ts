import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { makeBrokerRegistry } from "../src/broker-registry.js";
import { ProjectKeyFerryManager, projectDirectory } from "../src/contracts.js";
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
  reapOwnershipRecords,
} from "../src/varlock/ownership.js";

const cwd = process.cwd();

function fixture(root: string) {
  const calls: string[][] = [];
  const stopResults: boolean[] = [];
  let starts = 0;
  let sessionUuid = "";
  let certPath = "";
  const service: ProcessService = {
    spawn: (input) =>
      Effect.sync(() => {
        starts += 1;
        sessionUuid = `captured-session-${starts}`;
        const certDir = input.args[input.args.indexOf("--cert-dir") + 1]!;
        mkdirSync(certDir, { recursive: true });
        writeFileSync(join(certDir, "ca-cert.pem"), "fixture");
        certPath = join(certDir, "ca-cert.pem");
        const session = {
          id: sessionUuid,
          uuid: sessionUuid,
          ownerPid: 7123,
          cwd,
          startedAt: "2026-11-06T10:00:00.000Z",
          updatedAt: "2026-11-06T10:00:00.000Z",
          egressMode: "strict" as const,
          env: {
            HTTP_PROXY: "http://127.0.0.1:43821",
            HTTPS_PROXY: "http://127.0.0.1:43821",
            NODE_EXTRA_CA_CERTS: join(certDir, "ca-cert.pem"),
          },
          placeholderOverrides: { OPENAI_API_KEY: "placeholder" },
        };
        const process: ManagedProcess = {
          pid: 7123,
          completion: Effect.never,
          health: Effect.succeed({ pid: 7123, running: true }),
          stop: Effect.void,
        };
        return process;
      }),
    run: (input: RunInput): Effect.Effect<RunResult, ProcessError> => {
      calls.push([...input.args]);
      if (input.args.includes("stop")) {
        const succeeded = stopResults.shift() ?? true;
        return succeeded
          ? Effect.succeed({ code: 0, signal: null, stdout: "", stderr: "" })
          : Effect.fail(
              new ProcessError({ phase: "exit", code: "non-zero", message: "PRIVATE_STOP_DETAIL" }),
            );
      }
      if (input.args.includes("status"))
        return Effect.succeed({
          code: 0,
          signal: null,
          stdout: JSON.stringify([
            {
              id: sessionUuid,
              uuid: sessionUuid,
              ownerPid: 7123,
              cwd,
              startedAt: "2026-11-06T10:00:00.000Z",
              updatedAt: "2026-11-06T10:00:00.000Z",
              egressMode: "strict",
              env: {},
              placeholderOverrides: {},
            },
          ]),
          stderr: "",
        });
      if (input.args.includes("env"))
        return Effect.succeed({
          code: 0,
          signal: null,
          stdout: JSON.stringify({
            HTTP_PROXY: "http://127.0.0.1:43821",
            HTTPS_PROXY: "http://127.0.0.1:43821",
            NODE_EXTRA_CA_CERTS: certPath,
          }),
          stderr: "",
        });
      return Effect.succeed({ code: 0, signal: null, stdout: "", stderr: "" });
    },
  };
  const layer = makeProjectKeyFerryManager(
    {
      projectDirectory: projectDirectory(cwd),
      adapter: {
        command: ["varlock"],
        environmentKeys: [],
        ownershipDirectory: ownershipDirectory(root),
        startupTimeoutMs: 1_000,
        pollIntervalMs: 10,
        lifecycleLogger: () => undefined,
      },
    },
    Layer.succeed(Process, Process.of(service)),
  );
  return { calls, layer, session: () => sessionUuid, starts: () => starts, stopResults };
}

function failingFactoryLayer(layer: Layer.Layer<ProjectKeyFerryManager>) {
  return Layer.effect(
    ProjectKeyFerryManager,
    Effect.gen(function* () {
      const manager = yield* ProjectKeyFerryManager;
      return {
        ...manager,
        dispose: Effect.fail(new Error("PRIVATE_DISPOSE_DETAIL")),
      };
    }),
  ).pipe(Layer.provide(layer));
}

const options = (directory: string) =>
  ({
    projectDirectory: projectDirectory(cwd),
    owner: "key-ferry",
    adapter: {
      command: ["varlock"],
      environmentKeys: [],
      startupTimeoutMs: 1_000,
      pollIntervalMs: 10,
      idleTimeoutMs: 0,
    },
  }) as any;

test("failed release defers cleanup to startup reaper without losing registry state", async () => {
  const root = await mkdtemp(join(tmpdir(), "key-ferry-dispose-failed-"));
  const directory = ownershipDirectory(root);
  const f = fixture(root);
  const events: any[] = [];
  const registry = makeBrokerRegistry({
    idleTimeoutMs: 0,
    now: () => 1_000,
    canonicalize: (value) => Effect.succeed(value),
    schemaHash: () => Effect.succeed("schema"),
    logger: (event) => events.push(event),
  });
  f.stopResults.push(false, false);
  const lease = await Effect.runPromise(
    registry.acquire({ layer: () => failingFactoryLayer(f.layer) }, options(directory)),
  );
  await Effect.runPromise(lease.ensureReady);
  const captured = f.session();
  await Effect.runPromise(lease.release);
  const records = await readOwnershipRecords(ownershipFileOps(directory));
  assert.equal(records[0]?.sessionUuid, captured);
  assert.equal(f.starts(), 1);
  const failed = events.filter((event) => event.event === "dispose-failed");
  assert.equal(failed.length, 1);
  for (const field of ["scope", "directory", "keyHash", "proxySessionId"])
    assert.ok(field in failed[0]);
  assert.equal(failed[0].proxySessionId, captured);
  assert.equal(failed[0].directory, projectDirectory(cwd));
  assert.equal(JSON.stringify(failed).includes("PRIVATE_STOP_DETAIL"), false);
  assert.equal(JSON.stringify(failed).includes(captured), true);

  const stopCalls: string[] = [];
  const reaped = await reapOwnershipRecords(
    {
      status: async () => [{ uuid: captured }],
      stop: async (record) => stopCalls.push(record.sessionUuid),
    },
    ownershipFileOps(directory),
  );
  assert.deepEqual(reaped, { reaped: 1, skipped: 0 });
  assert.deepEqual(stopCalls, [captured]);
  assert.deepEqual(await readOwnershipRecords(ownershipFileOps(directory)), []);
  assert.ok(events.some((event) => event.event === "stale-reaped"));
  await Effect.runPromise(registry.shutdown);
  await rm(root, { recursive: true, force: true });
});

test("failed registry shutdown also keeps ownership for the reaper", async () => {
  const root = await mkdtemp(join(tmpdir(), "key-ferry-dispose-failed-shutdown-"));
  const directory = ownershipDirectory(root);
  const f = fixture(root);
  const events: any[] = [];
  const registry = makeBrokerRegistry({
    now: () => 2_000,
    canonicalize: (value) => Effect.succeed(value),
    schemaHash: () => Effect.succeed("schema"),
    logger: (event) => events.push(event),
  });
  f.stopResults.push(false, false);
  const lease = await Effect.runPromise(
    registry.acquire({ layer: () => failingFactoryLayer(f.layer) }, options(directory)),
  );
  await Effect.runPromise(lease.ensureReady);
  const captured = f.session();
  await Effect.runPromise(registry.shutdown);
  assert.equal((await readOwnershipRecords(ownershipFileOps(directory)))[0]?.sessionUuid, captured);
  const failed = events.filter((event) => event.event === "dispose-failed");
  assert.equal(failed.length, 1);
  assert.equal(failed[0].proxySessionId, captured);
  assert.equal(JSON.stringify(failed).includes("PRIVATE_STOP_DETAIL"), false);
  await rm(root, { recursive: true, force: true });
});
