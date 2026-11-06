import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Effect, Layer } from "effect";
import { ProjectKeyFerryManager, projectDirectory, VarlockError } from "../src/contracts.js";
import {
  Process,
  ProcessError,
  type ManagedProcess,
  type ProcessService,
} from "../src/services/process.js";
import { makeProjectKeyFerryManager } from "../src/varlock/manager.js";
import {
  ownershipDirectory,
  ownershipFileOps,
  readOwnershipRecords,
  reapOwnershipRecords,
  writeOwnershipRecord,
} from "../src/varlock/ownership.js";

const record = {
  version: 2 as const,
  brokerKeyHash: "a".repeat(64),
  sessionUuid: "captured-session",
  starterPid: process.pid,
  cwd: process.cwd(),
  created: new Date().toISOString(),
};

test("ownership write failure is fail-closed and leaves no record", async () => {
  const root = await mkdtemp(join(tmpdir(), "key-ferry-startup-cleanup-"));
  const directory = ownershipDirectory(root);
  const ops = {
    ...ownershipFileOps(directory),
    writeFile: async () => {
      throw new Error("fixture write failure");
    },
  };
  await assert.rejects(writeOwnershipRecord(record, ops), /fixture write failure/);
  assert.deepEqual(await readdir(directory), []);
  await rm(root, { recursive: true, force: true });
});

test("insecure ownership directory is rejected without exposing the cause", async () => {
  const root = await mkdtemp(join(tmpdir(), "key-ferry-startup-cleanup-"));
  const directory = ownershipDirectory(root);
  await writeFile(directory, "not a directory");
  const errors: unknown[] = [];
  assert.deepEqual(
    await readOwnershipRecords(ownershipFileOps(directory), (error) => errors.push(error)),
    [],
  );
  assert.equal(errors.length, 1);
  assert.equal((errors[0] as Error).message, "ownership directory unavailable");
  await rm(root, { recursive: true, force: true });
});

test("captured-session cleanup fixtures preserve the UUID and record lifecycle", async () => {
  const root = await mkdtemp(join(tmpdir(), "key-ferry-startup-cleanup-"));
  const ops = ownershipFileOps(ownershipDirectory(root));
  await writeOwnershipRecord(record, ops);
  const records = await readOwnershipRecords(ops);
  assert.equal(records[0]?.sessionUuid, "captured-session");
  await rm(root, { recursive: true, force: true });
});

test("legacy ownership reaper removes stale records without stopping", async () => {
  const root = await mkdtemp(join(tmpdir(), "key-ferry-legacy-reaper-"));
  const ops = ownershipFileOps(ownershipDirectory(root));
  await writeOwnershipRecord({ ...record, starterStartTime: "old" }, ops);
  let stopped = false;
  const result = await reapOwnershipRecords(
    {
      isAlive: async () => false,
      startTime: async () => "old",
      command: async () => ["varlock", "proxy", "start"],
      stop: async () => {
        stopped = true;
      },
    },
    ops,
  );
  assert.deepEqual(result, { reaped: 0, skipped: 1 });
  assert.equal(stopped, false);
  assert.deepEqual(await readOwnershipRecords(ops), []);
  await rm(root, { recursive: true, force: true });
});

test("legacy ownership reaper stops and removes a matching live record", async () => {
  const root = await mkdtemp(join(tmpdir(), "key-ferry-legacy-reaper-"));
  const ops = ownershipFileOps(ownershipDirectory(root));
  await writeOwnershipRecord({ ...record, starterStartTime: "live" }, ops);
  let stopped = false;
  const result = await reapOwnershipRecords(
    {
      isAlive: async () => true,
      startTime: async () => "live",
      command: async () => ["varlock", "proxy", "start"],
      stop: async () => {
        stopped = true;
      },
    },
    ops,
  );
  assert.deepEqual(result, { reaped: 1, skipped: 0 });
  assert.equal(stopped, true);
  assert.deepEqual(await readOwnershipRecords(ops), []);
  await rm(root, { recursive: true, force: true });
});

function managerFixture(
  directory: string,
  mode: "strict" | "permissive",
  envFailure = false,
  command = "varlock",
) {
  const calls: string[][] = [];
  const lifecycle: unknown[] = [];
  let failStop = false;
  let certPath = "";
  const session = {
    id: "startup-session",
    uuid: "startup-session",
    ownerPid: 5151,
    cwd: process.cwd(),
    startedAt: "2026-11-06T10:00:00.000Z",
    updatedAt: "2026-11-06T10:00:00.000Z",
    egressMode: mode,
    env: {
      HTTP_PROXY: "http://127.0.0.1:43821",
      HTTPS_PROXY: "http://127.0.0.1:43821",
      NODE_EXTRA_CA_CERTS: "/tmp/placeholder/ca-cert.pem",
    },
    placeholderOverrides: { OPENAI_API_KEY: "placeholder" },
  };
  const service: ProcessService = {
    spawn: (input) =>
      Effect.tryPromise(async () => {
        const certDir = input.args[input.args.indexOf("--cert-dir") + 1]!;
        certPath = join(certDir, "ca-cert.pem");
        await mkdir(certDir, { recursive: true, mode: 0o700 });
        await writeFile(certPath, "fixture", { mode: 0o600 });
        return {
          pid: 5151,
          completion: Effect.never,
          health: Effect.succeed({ pid: 5151, running: true }),
          stop: Effect.void,
        } satisfies ManagedProcess;
      }),
    run: (input) =>
      Effect.gen(function* () {
        calls.push([...input.args]);
        if (input.args.includes("stop")) {
          if (failStop)
            return yield* Effect.fail(
              new ProcessError({ phase: "exit", code: "non-zero", message: "private stop detail" }),
            );
          return { code: 0, signal: null, stdout: "", stderr: "" };
        }
        if (input.args.includes("status"))
          return { code: 0, signal: null, stdout: JSON.stringify([session]), stderr: "" };
        if (input.args.includes("env") && envFailure)
          return yield* Effect.fail(
            new ProcessError({ phase: "exit", code: "non-zero", message: "private env detail" }),
          );
        return {
          code: 0,
          signal: null,
          stdout: JSON.stringify({
            ...session.env,
            NODE_EXTRA_CA_CERTS: certPath,
            OPENAI_API_KEY: "placeholder",
          }),
          stderr: "",
        };
      }),
  };
  const layer = makeProjectKeyFerryManager(
    {
      projectDirectory: projectDirectory(process.cwd()),
      adapter: {
        command: [command],
        environmentKeys: ["OPENAI_API_KEY"],
        ownershipDirectory: directory,
        lifecycleLogger: (event) => lifecycle.push(event),
      },
    },
    Layer.succeed(Process, Process.of(service)),
  );
  return { calls, lifecycle, setFailStop: () => (failStop = true), layer };
}

async function withFixture<A>(
  layer: Layer.Layer<ProjectKeyFerryManager, VarlockError, never>,
  f: (m: ProjectKeyFerryManager["Service"]) => Effect.Effect<A, VarlockError>,
) {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        return yield* f(yield* ProjectKeyFerryManager);
      }).pipe(Effect.provide(layer)),
    ),
  );
}

test("egress validation failure stops captured session and removes ownership", async () => {
  const root = await mkdtemp(join(tmpdir(), "key-ferry-egress-cleanup-"));
  const directory = ownershipDirectory(root);
  const command = join(root, "varlock-fixture.sh");
  await writeFile(
    command,
    `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify([
      {
        id: "startup-session",
        uuid: "startup-session",
        ownerPid: 5151,
        cwd: process.cwd(),
        startedAt: "2026-11-06T10:00:00.000Z",
        updatedAt: "2026-11-06T10:00:00.000Z",
        egressMode: "permissive",
        env: {
          HTTP_PROXY: "http://127.0.0.1:43821",
          HTTPS_PROXY: "http://127.0.0.1:43821",
          NODE_EXTRA_CA_CERTS: "/tmp/fixture/ca-cert.pem",
        },
        placeholderOverrides: { OPENAI_API_KEY: "placeholder" },
      },
    ])}'\nexit 1\n`,
  );
  await chmod(command, 0o700);
  const fixture = managerFixture(directory, "permissive", false, command);
  await assert.rejects(
    withFixture(fixture.layer, (m) => m.ensureStarted),
    (error: VarlockError) => error.code === "invalid_config",
  );
  assert.deepEqual(
    fixture.calls.filter((args) => args.includes("stop")).map((args) => args.at(-1)),
    ["startup-session"],
  );
  assert.deepEqual(await readOwnershipRecords(ownershipFileOps(directory)), []);
  await rm(root, { recursive: true, force: true });
});

test("egress cleanup stop failure retains ownership and logs no raw error", async () => {
  const root = await mkdtemp(join(tmpdir(), "key-ferry-egress-stop-failure-"));
  const directory = ownershipDirectory(root);
  const command = join(root, "varlock-fixture.sh");
  await writeFile(
    command,
    `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify([
      {
        id: "startup-session",
        uuid: "startup-session",
        ownerPid: 5151,
        cwd: process.cwd(),
        startedAt: "2026-11-06T10:00:00.000Z",
        updatedAt: "2026-11-06T10:00:00.000Z",
        egressMode: "permissive",
        env: {
          HTTP_PROXY: "http://127.0.0.1:43821",
          HTTPS_PROXY: "http://127.0.0.1:43821",
          NODE_EXTRA_CA_CERTS: "/tmp/fixture/ca-cert.pem",
        },
        placeholderOverrides: { OPENAI_API_KEY: "placeholder" },
      },
    ])}'\nexit 1\n`,
  );
  await chmod(command, 0o700);
  const fixture = managerFixture(directory, "permissive", false, command);
  fixture.setFailStop();
  await assert.rejects(
    withFixture(fixture.layer, (m) => m.ensureStarted),
    (error: VarlockError) => error.code === "invalid_config",
  );
  assert.deepEqual(fixture.lifecycle[0], {
    event: "stop-failed",
    proxySessionId: "startup-session",
  });
  assert.ok(fixture.lifecycle.every((event) => JSON.stringify(event).includes("startup-session")));
  const records = await readOwnershipRecords(ownershipFileOps(directory));
  assert.equal(records[0]?.sessionUuid, "startup-session");
  await rm(root, { recursive: true, force: true });
});

test("environment read failure after capture uses the same cleanup", async () => {
  const root = await mkdtemp(join(tmpdir(), "key-ferry-env-cleanup-"));
  const directory = ownershipDirectory(root);
  const fixture = managerFixture(directory, "strict", true);
  await assert.rejects(
    withFixture(fixture.layer, (m) => m.ensureStarted),
    (error: VarlockError) => error.code === "unavailable" && !error.message.includes("private"),
  );
  assert.deepEqual(
    fixture.calls.filter((args) => args.includes("stop")).map((args) => args.at(-1)),
    ["startup-session"],
  );
  assert.deepEqual(await readOwnershipRecords(ownershipFileOps(directory)), []);
  await rm(root, { recursive: true, force: true });
});

test("ownership unavailable status exposes only its fixed diagnostic", async () => {
  const root = await mkdtemp(join(tmpdir(), "key-ferry-ownership-unavailable-"));
  const directory = join(root, "record-store");
  await writeFile(directory, "not a directory");
  const fixture = managerFixture(directory, "strict");
  const status = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const m = yield* ProjectKeyFerryManager;
        yield* m.ensureStarted.pipe(Effect.catch(() => Effect.void));
        return yield* m.status;
      }).pipe(Effect.provide(fixture.layer)),
    ),
  );
  assert.equal(status.error?.code, "ownership_unavailable");
  assert.equal(status.error?.message, "Key Ferry ownership directory is unavailable");
  assert.equal(status.error?.stderrTail, undefined);
  await rm(root, { recursive: true, force: true });
});
