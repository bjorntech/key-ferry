import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendProxyLedgerEntry,
  ownershipDirectory,
  ownershipFileOps,
  readProxyLedger,
  reapOwnershipRecords,
  type OwnershipVerifier,
} from "../src/varlock/ownership.js";

const session = {
  uuid: "orphan",
  ownerPid: 700,
  cwd: "/project",
  pid: 701,
  startTime: "proxy-start",
};

async function fixture(entry?: {
  ownerPid?: number;
  ownerStartTime?: string;
  proxyStartTime?: string;
}) {
  const root = await mkdtemp(join(tmpdir(), "key-ferry-ledger-"));
  const ops = {
    ...ownershipFileOps(ownershipDirectory(root)),
    ledgerPath: join(root, "ledger.jsonl"),
  };
  if (entry)
    await appendProxyLedgerEntry(
      {
        version: 1,
        sessionUuid: "orphan",
        proxyPid: 701,
        proxyStartTime: entry.proxyStartTime ?? "proxy-start",
        ownerPid: entry.ownerPid ?? 700,
        ownerStartTime: entry.ownerStartTime ?? "owner-start",
        cwd: "/project",
        created: "now",
      },
      ops,
      ops.ledgerPath,
    );
  let alive = new Set<number>([701]);
  const stopped: string[] = [];
  const verifier: OwnershipVerifier = {
    status: async () => (alive.has(701) ? [session] : []),
    isAlive: async (pid) => alive.has(pid),
    startTime: async (pid) => (pid === 700 ? "owner-start" : "proxy-start"),
    processEnv: async () => ({}),
    stop: async (record) => {
      stopped.push(record.sessionUuid);
      alive.delete(701);
    },
  };
  return {
    root,
    ops,
    verifier,
    stopped,
    setAlive: (value: boolean) => (value ? alive.add(700) : alive.delete(700)),
  };
}

test("ledger match and dead owner reaps, while a live owner is untouched", async () => {
  const dead = await fixture({});
  expect(await reapOwnershipRecords(dead.verifier, dead.ops)).toEqual({ reaped: 1, skipped: 0 });
  expect(dead.stopped).toEqual(["orphan"]);
  await rm(dead.root, { recursive: true, force: true });

  const live = await fixture({});
  live.setAlive(true);
  expect(await reapOwnershipRecords(live.verifier, live.ops)).toEqual({ reaped: 0, skipped: 0 });
  expect(live.stopped).toEqual([]);
  await rm(live.root, { recursive: true, force: true });
});

test("marker in the actual process environment is positive evidence", async () => {
  const item = await fixture({});
  const verifier = {
    ...item.verifier,
    processEnv: async () => ({ KEY_FERRY_PROXY_MARKER: "key-ferry" }),
  };
  expect(await reapOwnershipRecords(verifier, item.ops)).toEqual({ reaped: 1, skipped: 0 });
  await rm(item.root, { recursive: true, force: true });
});

test("missing evidence, PID reuse, and unreadable environment are never reaped", async () => {
  const noEvidence = await fixture();
  expect(await reapOwnershipRecords(noEvidence.verifier, noEvidence.ops)).toEqual({
    reaped: 0,
    skipped: 0,
  });
  await rm(noEvidence.root, { recursive: true, force: true });

  const reused = await fixture({ proxyStartTime: "old-proxy" });
  expect(await reapOwnershipRecords(reused.verifier, reused.ops)).toEqual({
    reaped: 0,
    skipped: 0,
  });
  await rm(reused.root, { recursive: true, force: true });

  const denied = await fixture();
  const verifier = { ...denied.verifier, processEnv: async () => undefined };
  expect(await reapOwnershipRecords(verifier, denied.ops)).toEqual({ reaped: 0, skipped: 0 });
  await rm(denied.root, { recursive: true, force: true });
});

test("corrupt ledger lines are tolerated and entries are retired after verified disappearance", async () => {
  const item = await fixture({});
  await writeFile(item.ops.ledgerPath!, "not-json\n", { flag: "a" });
  expect((await readProxyLedger(item.ops, item.ops.ledgerPath)).length).toBe(1);
  expect(await reapOwnershipRecords(item.verifier, item.ops)).toEqual({ reaped: 1, skipped: 0 });
  expect(await readProxyLedger(item.ops, item.ops.ledgerPath)).toEqual([]);
  await rm(item.root, { recursive: true, force: true });
});
