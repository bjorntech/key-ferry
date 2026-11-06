import { test } from "bun:test";
import assert from "node:assert/strict";
import { Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import { makeBrokerRegistry, type BrokerLogEvent } from "../src/broker-registry.js";
import {
  ProjectKeyFerryManager,
  projectDirectory,
  type ProjectKeyFerryManagerFactory,
} from "../src/contracts.js";
import { reapOwnershipRecords, type OwnershipFileOps } from "../src/varlock/ownership.js";

const directory = projectDirectory("/fake/project");
const adapter = {
  command: ["varlock"],
  environmentKeys: ["OP_SERVICE_ACCOUNT_TOKEN", "TOKEN"],
  startupTimeoutMs: 100,
  commandTimeoutMs: 100,
  reloadTimeoutMs: 100,
  pollIntervalMs: 10,
  requireStrictEgress: true,
};

function fakeFactory(statusPid = 4242): ProjectKeyFerryManagerFactory {
  return {
    layer: () => {
      const status = {
        phase: "ready" as const,
        projectDirectory: directory,
        generation: 1,
        pid: statusPid,
        proxySessionId: "session-fake",
      };
      return Layer.succeed(ProjectKeyFerryManager, {
        status: Effect.succeed(status),
        ensureStarted: Effect.succeed(status),
        ensureReady: Effect.succeed({ status, environment: {} }),
        environment: Effect.succeed({}),
        refresh: Effect.succeed(status),
        refreshReady: Effect.succeed({ status, environment: {} }),
        dispose: Effect.succeed(undefined),
        withExclusive: (effect: any) => effect,
      });
    },
  };
}

function options(sessionID = "session-fake") {
  return { projectDirectory: directory, owner: "key-ferry", sessionID, adapter } as any;
}

test("startup reaping is idempotent and a fake reaper sees one pass", async () => {
  let passes = 0;
  const ops = {
    readdir: async () => {
      passes += 1;
      return [];
    },
  } as unknown as OwnershipFileOps;
  const verifier = {
    isAlive: async () => false,
    startTime: async () => undefined,
    command: async () => undefined,
    stop: async () => undefined,
  };
  await Promise.all([reapOwnershipRecords(verifier, ops), reapOwnershipRecords(verifier, ops)]);
  // This is the deterministic contract for the startup seam: callers must share
  // one in-flight pass rather than independently scanning the ownership dir.
  assert.equal(passes, 1, "startup reaper must run one pass per process");
});

test("reaper failures are non-fatal and log a constant-shaped event", async () => {
  const events: BrokerLogEvent[] = [];
  const registry = makeBrokerRegistry({
    canonicalize: (value) => Effect.succeed(value),
    schemaHash: () => Effect.succeed("schema"),
    logger: (event) => events.push(event),
  });
  const throwingOps = {
    readdir: async () => {
      throw new Error("DO_NOT_LEAK_THIS_REAPER_ERROR");
    },
  } as unknown as OwnershipFileOps;
  const result = await reapOwnershipRecords(
    {
      isAlive: async () => false,
      startTime: async () => undefined,
      command: async () => undefined,
      stop: async () => undefined,
    },
    throwingOps,
  );
  const lease = await Effect.runPromise(registry.acquire(fakeFactory(), options()));
  assert.equal(result.reaped, 0);
  assert.equal(lease !== undefined, true, "startup/acquire remains usable after reaper failure");
  const serialized = JSON.stringify(events);
  assert.equal(serialized.includes("DO_NOT_LEAK_THIS_REAPER_ERROR"), false);
  assert.ok(
    events.some((event) => event.event === "stale-skipped" || event.event === "stale-reaped"),
  );
  await Effect.runPromise(lease.release);
  await Effect.runPromise(registry.shutdown);
});

test("lifecycle logger emits the complete broker sequence with redacted identity", async () => {
  const events: BrokerLogEvent[] = [];
  const registry = makeBrokerRegistry({
    canonicalize: (value) => Effect.succeed(value),
    schemaHash: () => Effect.succeed("schema"),
    idleTimeoutMs: 100,
    logger: (event) => events.push(event),
  });
  const factory = fakeFactory();
  await Effect.runPromise(
    Effect.gen(function* () {
      const first = yield* registry.acquire(factory, options());
      yield* first.ensureReady;
      yield* first.release;
      yield* TestClock.adjust("50 millis");
      const second = yield* registry.acquire(factory, options());
      yield* second.release;
      yield* TestClock.adjust("100 millis");
    }).pipe(Effect.provide(TestClock.layer())),
  );

  assert.deepEqual(
    events.map(({ event }) => event),
    [
      "start",
      "ready",
      "release",
      "idle-scheduled",
      "reused",
      "release",
      "idle-scheduled",
      "disposed",
    ],
  );
  for (const event of events) {
    assert.equal(event.scope, "project");
    assert.equal(event.directory, directory);
    assert.match(event.keyHash, /^[a-f0-9]{12}$/);
    assert.equal(event.keyHash.includes("varlock"), false);
    if (event.event === "start" || event.event === "ready") assert.equal(event.pid, 4242);
  }
  assert.equal(
    events.every((event) => "proxySessionId" in event),
    true,
  );
  await Effect.runPromise(registry.shutdown);
});

test("lifecycle events never contain environment, schema refs, or stderr", async () => {
  process.env.OP_SERVICE_ACCOUNT_TOKEN = "ops_FAKEFAKEFAKE_SECRET";
  process.env.TOKEN = "sk-test-123456";
  const events: BrokerLogEvent[] = [];
  const registry = makeBrokerRegistry({
    canonicalize: (value) => Effect.succeed(value),
    schemaHash: () => Effect.succeed("op://vault/item/field"),
    logger: (event) => events.push(event),
  });
  const lease = await Effect.runPromise(registry.acquire(fakeFactory(), options()));
  const serialized = JSON.stringify(events);
  for (const secret of [
    "ops_FAKEFAKEFAKE_SECRET",
    "sk-test-123456",
    "op://vault/item/field",
    "Bearer abc.def.ghi",
  ]) {
    for (let length = 8; length <= secret.length; length += 1)
      assert.equal(
        serialized.includes(secret.slice(0, length)),
        false,
        `leaked substring of ${secret}`,
      );
  }
  await Effect.runPromise(lease.release);
  await Effect.runPromise(registry.shutdown);
  delete process.env.OP_SERVICE_ACCOUNT_TOKEN;
  delete process.env.TOKEN;
});

test("matching and mismatched stale records produce redacted stale events", async () => {
  const events: BrokerLogEvent[] = [];
  const registry = makeBrokerRegistry({ logger: (event) => events.push(event) });
  const record = {
    brokerKeyHash: "a".repeat(64),
    version: 2,
    sessionUuid: "session-fake",
    starterPid: 123,
    starterStartTime: "start",
    cwd: directory,
    created: new Date(0).toISOString(),
  } as const;
  const files = new Map([[`${record.brokerKeyHash}.json`, JSON.stringify(record)]]);
  const ops = {
    readdir: async () => [...files.keys()],
    readFile: async (name: string) => files.get(name.split("/").pop()!)!,
    rm: async (name: string) => {
      files.delete(name.split("/").pop()!);
    },
  } as unknown as OwnershipFileOps;
  const result = await reapOwnershipRecords(
    {
      status: async () => {
        throw new Error("status unavailable");
      },
      stop: async () => undefined,
    },
    ops,
  );
  assert.equal(result.skipped, 1);
  assert.ok(events.some((event) => event.event === "stale-skipped"));
  assert.equal(JSON.stringify(events).includes(record.sessionUuid), false);
  await Effect.runPromise(registry.shutdown);
});
