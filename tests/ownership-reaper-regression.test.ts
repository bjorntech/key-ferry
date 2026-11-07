import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ownershipDirectory,
  ownershipFileOps,
  readOwnershipRecords,
  reapOwnershipRecords,
  writeOwnershipRecord,
} from "../src/varlock/ownership.js";

const record = (hash: string) => ({
  version: 2 as const,
  brokerKeyHash: hash,
  sessionUuid: `session-${hash}`,
  starterPid: 42,
  starterStartTime: "start",
  cwd: "/project",
  created: new Date(0).toISOString(),
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "key-ferry-reaper-regression-"));
  const ops = ownershipFileOps(ownershipDirectory(root));
  return { root, ops };
}

describe("ownership reaper regressions", () => {
  test("keeps a record when stop succeeds but the session survives", async () => {
    const { root, ops } = await fixture();
    try {
      const item = record("a".repeat(64));
      await writeOwnershipRecord(item, ops);
      const result = await reapOwnershipRecords(
        {
          isAlive: async () => false,
          startTime: async () => undefined,
          command: async () => undefined,
          status: async () => [{ uuid: item.sessionUuid }],
          stop: async () => undefined,
        },
        ops,
      );
      expect(result.skipped).toBe(1);
      expect((await readOwnershipRecords(ops)).length).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("retries a stop-pending record on a later reaper pass", async () => {
    const { root, ops } = await fixture();
    try {
      const item = record("d".repeat(64));
      await writeOwnershipRecord(item, ops);
      let active = true;
      let stops = 0;
      const verifier = {
        isAlive: async () => false,
        status: async () => (active ? [{ uuid: item.sessionUuid }] : []),
        stop: async () => {
          stops++;
          if (stops > 1) active = false;
        },
      };
      expect((await reapOwnershipRecords(verifier, ops)).skipped).toBe(1);
      // The first pass leaves the stop-pending record; the next pass retries
      // the exact session and removes it once status confirms disappearance.
      expect(stops).toBe(1);
      expect((await readOwnershipRecords(ops)).length).toBe(1);
      expect((await reapOwnershipRecords(verifier, ownershipFileOps(ops.directory!))).reaped).toBe(
        1,
      );
      expect((await readOwnershipRecords(ops)).length).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("does not stop a live owner, but treats a reused PID as dead", async () => {
    const { root, ops } = await fixture();
    try {
      const live = record("b".repeat(64));
      const reused = { ...record("c".repeat(64)), starterPid: 43 };
      await writeOwnershipRecord(live, ops);
      await writeOwnershipRecord(reused, ops);
      const stopped: string[] = [];
      await reapOwnershipRecords(
        {
          isAlive: async () => true,
          startTime: async (pid) => (pid === 42 ? "start" : "other"),
          command: async () => ["varlock", "proxy", "start"],
          status: async () => [{ uuid: live.sessionUuid }, { uuid: reused.sessionUuid }],
          stop: async (item) => stopped.push(item.sessionUuid),
        },
        ops,
      );
      expect(stopped).toEqual([reused.sessionUuid]);
      expect((await readOwnershipRecords(ops)).map((item) => item.sessionUuid)).toEqual([
        live.sessionUuid,
        reused.sessionUuid,
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("does not retain a completed pass for a later reaper call", async () => {
    const { root, ops } = await fixture();
    try {
      const live = record("b".repeat(64));
      const reused = { ...record("c".repeat(64)), starterPid: 43 };
      await writeOwnershipRecord(live, ops);
      await writeOwnershipRecord(reused, ops);
      let statusCalls = 0;
      const verifier = {
        isAlive: async () => true,
        startTime: async (pid: number) => (pid === 42 ? "start" : "other"),
        command: async () => ["varlock", "proxy", "start"],
        status: async () => {
          statusCalls++;
          return [{ uuid: live.sessionUuid }, { uuid: reused.sessionUuid }];
        },
        stop: async () => undefined,
      };
      await reapOwnershipRecords(verifier, ops);
      await reapOwnershipRecords(verifier, ops);
      expect(statusCalls).toBe(8);
      expect((await readOwnershipRecords(ops)).map((item) => item.sessionUuid)).toEqual([
        live.sessionUuid,
        reused.sessionUuid,
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("sorts ownership records independently of directory enumeration order", async () => {
    const { root, ops } = await fixture();
    try {
      const live = record("b".repeat(64));
      const reused = { ...record("c".repeat(64)), starterPid: 43 };
      await writeOwnershipRecord(live, ops);
      await writeOwnershipRecord(reused, ops);
      const reversedOps = {
        ...ops,
        readdir: async (directory: string) => (await ops.readdir(directory)).reverse(),
      };
      expect((await readOwnershipRecords(reversedOps)).map((item) => item.sessionUuid)).toEqual([
        live.sessionUuid,
        reused.sessionUuid,
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("only reaps a recordless session with an explicit marker", async () => {
    const { root, ops } = await fixture();
    try {
      let stopped = "";
      const sessions = [
        { uuid: "marked", ownerPid: 9, cwd: "/project", keyFerryMarker: "key-ferry" },
        { uuid: "ambiguous", ownerPid: 10, cwd: "/project" },
      ];
      await reapOwnershipRecords(
        {
          isAlive: async () => false,
          status: async () => sessions,
          stop: async (item) => {
            stopped = item.sessionUuid;
            sessions.splice(0, 1);
          },
        },
        ops,
      );
      expect(stopped).toBe("marked");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
