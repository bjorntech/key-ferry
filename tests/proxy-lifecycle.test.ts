import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { makeBrokerRegistry } from "../src/broker-registry.js";
import {
  ProjectKeyFerryManager,
  projectDirectory,
  type ProjectKeyFerryManagerFactory,
} from "../src/contracts.js";
import {
  readOwnershipRecords,
  reapOwnershipRecords,
  removeOwnershipRecord,
  writeOwnershipRecord,
  ownershipFileOps,
  ownershipDirectory,
  type OwnershipFileOps,
} from "../src/varlock/ownership.js";

test("idle broker is reused and expires into disposal", async () => {
  const directory = projectDirectory(process.cwd());
  let builds = 0;
  let disposals = 0;
  const factory: ProjectKeyFerryManagerFactory = {
    layer: () => {
      builds += 1;
      const status = { phase: "ready" as const, projectDirectory: directory, generation: 1 };
      return Layer.succeed(ProjectKeyFerryManager, {
        status: Effect.succeed(status),
        ensureStarted: Effect.succeed(status),
        ensureReady: Effect.succeed({ status, environment: {} }),
        environment: Effect.succeed({}),
        refresh: Effect.succeed(status),
        refreshReady: Effect.succeed({ status, environment: {} }),
        dispose: Effect.sync(() => void disposals++),
        withExclusive: (effect: any) => effect,
      });
    },
  };
  const registry = makeBrokerRegistry({
    canonicalize: (value) => Effect.succeed(value),
    idleTimeoutMs: 10,
  });
  const options = {
    projectDirectory: directory,
    adapter: {
      command: ["varlock"],
      environmentKeys: [],
      startupTimeoutMs: 100,
      commandTimeoutMs: 100,
      reloadTimeoutMs: 100,
      pollIntervalMs: 10,
      requireStrictEgress: true,
    },
  } as any;
  const first = await Effect.runPromise(registry.acquire(factory, options));
  await Effect.runPromise(first.ensureReady);
  await Effect.runPromise(first.release);
  const second = await Effect.runPromise(registry.acquire(factory, options));
  assert.equal(builds, 1);
  await Effect.runPromise(second.release);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(disposals, 1);
  await Effect.runPromise(registry.shutdown);
});

test("ownership records use restrictive permissions and reap only matching identities", async () => {
  const root = await mkdtemp(join(tmpdir(), "key-ferry-ownership-test-"));
  try {
    const ops = ownershipFileOps(ownershipDirectory(root));
    const record = {
      brokerKeyHash: "a".repeat(64),
      version: 2,
      sessionUuid: "session-1",
      starterPid: 123,
      starterStartTime: "start-1",
      cwd: process.cwd(),
      created: new Date(0).toISOString(),
    } as const;
    await writeOwnershipRecord(record, ops);
    const ownershipDir = join(root, `key-ferry-${process.getuid?.() ?? "unknown"}`);
    assert.equal((await stat(ownershipDir)).mode & 0o777, 0o700);
    const recordFile = (await readdir(ownershipDir))[0]!;
    assert.equal((await stat(join(ownershipDir, recordFile))).mode & 0o777, 0o600);
    const records = await readOwnershipRecords(ops);
    assert.equal(records.length, 1);
    const result = await reapOwnershipRecords(
      {
        isAlive: async () => true,
        startTime: async () => "reused",
        status: async () => [{ uuid: record.sessionUuid }],
        stop: async () =>
          assert.fail("protocol stop should be exercised by the active-session reaper"),
      },
      ops,
    );
    assert.equal(result.skipped, 1);
    assert.deepEqual(await readOwnershipRecords(ops), [record]);
    await removeOwnershipRecord(record.brokerKeyHash, ops);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ownership reaper stops matching and removes dead records", async () => {
  const root = await mkdtemp(join(tmpdir(), "key-ferry-ownership-test-"));
  try {
    const ops = ownershipFileOps(ownershipDirectory(root));
    const base = {
      version: 2,
      sessionUuid: "session",
      starterPid: 123,
      starterStartTime: "start",
      cwd: process.cwd(),
      created: new Date(0).toISOString(),
    } as const;
    await writeOwnershipRecord({ ...base, brokerKeyHash: "b".repeat(64) }, ops);
    await writeOwnershipRecord({ ...base, brokerKeyHash: "c".repeat(64), starterPid: 456 }, ops);
    let stopped = 0;
    const result = await reapOwnershipRecords(
      {
        status: async () => [{ uuid: "session" }],
        isAlive: async (pid) => pid === 123,
        startTime: async () => "start",
        command: async () => ["varlock"],
        stop: async () => {
          stopped += 1;
        },
      },
      ops,
    );
    assert.equal(result.reaped, 2);
    assert.equal(stopped, 2);
    assert.deepEqual(await readOwnershipRecords(ops), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
