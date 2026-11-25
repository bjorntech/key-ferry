import { describe, expect, test } from "bun:test";
import { lstat, mkdtemp, mkdir, rm, symlink, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendProxyLedgerEntry,
  canonicalStartTime,
  ownershipDirectory,
  ownershipFileOps,
  proxyIsAlive,
  readProxyLedger,
  startTimesMatch,
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

function psLstart(date: Date): string {
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${weekdays[date.getDay()]} ${months[date.getMonth()]} ${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}:${pad(date.getSeconds())} ${date.getFullYear()}`;
}

describe("ownership reaper regressions", () => {
  const verifiedInit = process.platform === "darwin" ? ["launchd"] : ["init"];
  test("normalizes ISO, ps lstart, and canonical start times with tolerance", () => {
    const iso = "2026-11-25T10:00:00.000Z";
    const lstart = psLstart(new Date("2026-11-25T10:00:04.000Z"));
    expect(canonicalStartTime(iso)).toBe("ms:1795600800000");
    expect(startTimesMatch(lstart, canonicalStartTime(iso))).toBe(true);
    expect(startTimesMatch("2026-11-25T10:00:06.000Z", canonicalStartTime(iso))).toBe(false);
  });

  test("keeps the 0.1.17 wire shape while carrying additive host identity", async () => {
    const { root, ops } = await fixture();
    try {
      const item = {
        version: 2 as const,
        brokerKeyHash: "b".repeat(64),
        sessionUuid: "compat",
        starterPid: 901,
        starterStartTime: "ms:1795600800000",
        proxyPid: 901,
        proxyStartTime: "ms:1795600800000",
        hostPid: 902,
        hostStartTime: "ms:1795600800000",
        cwd: "/project",
        created: new Date().toISOString(),
      };
      await writeOwnershipRecord(item, ops);
      await appendProxyLedgerEntry(
        {
          version: 1,
          sessionUuid: "compat",
          proxyPid: 901,
          proxyStartTime: item.proxyStartTime,
          ownerPid: 901,
          ownerStartTime: item.proxyStartTime,
          hostPid: 902,
          hostStartTime: item.hostStartTime,
          cwd: "/project",
          created: item.created,
        },
        ops,
        ops.ledgerPath,
      );
      const record = JSON.parse(
        await ops.readFile(join(ops.directory!, `${item.brokerKeyHash}.json`), "utf8"),
      );
      const oldRecordAccepts = (value: any) =>
        value.version === 2 &&
        Number.isSafeInteger(value.starterPid) &&
        typeof value.sessionUuid === "string" &&
        typeof value.cwd === "string" &&
        typeof value.created === "string";
      expect(oldRecordAccepts(record)).toBe(true);
      expect((await readProxyLedger(ops, ops.ledgerPath))[0]?.version).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("requires a verified init identity before reaping PPID 1", async () => {
    const { root, ops } = await fixture();
    try {
      const session = {
        uuid: "recordless",
        ownerPid: 9,
        startedAt: new Date(Date.now() - 120_000).toISOString(),
      };
      let active = true;
      const base = {
        isAlive: async (pid: number) => pid === 9,
        command: async () => [
          "varlock",
          "proxy",
          "start",
          "--cert-dir",
          join(tmpdir(), "key-ferry-cert-old"),
        ],
        processEnv: async () => ({ KEY_FERRY_PROXY_MARKER: "key-ferry" }),
        parentPid: async () => 1,
        status: async () => (active ? [session] : []),
        stop: async () => {
          active = false;
        },
      };
      await reapOwnershipRecords({ ...base, initCommand: async () => ["opencode"] }, ops);
      expect(active).toBe(true);
      await reapOwnershipRecords({ ...base, initCommand: async () => undefined }, ops);
      expect(active).toBe(true);
      await reapOwnershipRecords(
        { ...base, command: async () => undefined, initCommand: async () => verifiedInit },
        ops,
      );
      expect(active).toBe(true);
      await reapOwnershipRecords(
        { ...base, parentPid: async () => undefined, initCommand: async () => verifiedInit },
        ops,
      );
      expect(active).toBe(true);
      await reapOwnershipRecords({ ...base, initCommand: async () => verifiedInit }, ops);
      expect(active).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

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
        {
          uuid: "marked",
          ownerPid: 9,
          cwd: "/project",
          keyFerryMarker: "key-ferry",
          startedAt: new Date(Date.now() - 120_000).toISOString(),
        },
        { uuid: "ambiguous", ownerPid: 10, cwd: "/project" },
      ];
      await reapOwnershipRecords(
        {
          isAlive: async (pid) => pid === 9,
          command: async () => [
            "varlock",
            "proxy",
            "start",
            "--cert-dir",
            join(tmpdir(), "key-ferry-cert-old"),
          ],
          processEnv: async () => ({ KEY_FERRY_PROXY_MARKER: "key-ferry" }),
          parentPid: async () => 1,
          initCommand: async () => (process.platform === "darwin" ? ["launchd"] : ["init"]),
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

  test("does not reap a legacy proxy with a live non-root parent", async () => {
    const { root, ops } = await fixture();
    try {
      const item = record("e".repeat(64));
      await writeOwnershipRecord(item, ops);
      const stopped: string[] = [];
      await reapOwnershipRecords(
        {
          isAlive: async () => true,
          startTime: async () => "start",
          command: async () => [
            "varlock",
            "proxy",
            "start",
            "--cert-dir",
            join(tmpdir(), "key-ferry-cert-live"),
          ],
          processEnv: async () => ({ KEY_FERRY_PROXY_MARKER: "key-ferry" }),
          parentPid: async () => 1234,
          status: async () => [
            { uuid: item.sessionUuid, ownerPid: 42, startedAt: new Date(0).toISOString() },
          ],
          stop: async () => stopped.push(item.sessionUuid),
        },
        ops,
      );
      expect(stopped).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("does not reap a v3 sidecar whose host identity is alive", async () => {
    const { root, ops } = await fixture();
    try {
      const item = {
        ...record("1".repeat(64)),
        version: 2 as const,
        starterPid: 1234,
        starterStartTime: "host-start",
        proxyPid: 99,
        proxyStartTime: "proxy-start",
        hostPid: 1234,
        hostStartTime: "host-start",
      };
      await writeOwnershipRecord(item, ops);
      const stopped: string[] = [];
      await reapOwnershipRecords(
        {
          isAlive: async (pid) => pid === 1234 || pid === 99,
          startTime: async (pid) => (pid === 1234 ? "host-start" : "proxy-start"),
          command: async () => ["opencode", "serve", "--stdio"],
          status: async () => [
            { uuid: item.sessionUuid, ownerPid: 99, startedAt: new Date(0).toISOString() },
          ],
          stop: async () => stopped.push(item.sessionUuid),
        },
        ops,
      );
      expect(stopped).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("preserves evidence when status misses a live proxy", async () => {
    const { root, ops } = await fixture();
    try {
      const item = { ...record("f".repeat(64)), proxyPid: 99, proxyStartTime: "proxy" };
      await writeOwnershipRecord(item, ops);
      await reapOwnershipRecords(
        {
          isAlive: async (pid) => pid === 99,
          startTime: async () => "proxy",
          status: async () => [],
          command: async () => ["varlock", "proxy", "start"],
          stop: async () => {
            throw new Error("must not stop");
          },
        },
        ops,
      );
      expect((await readOwnershipRecords(ops)).length).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("status-absent records never stop a live or unreadable host", async () => {
    for (const unreadable of [false, true]) {
      const { root, ops } = await fixture();
      try {
        const item = {
          ...record((unreadable ? "2" : "3").repeat(64)),
          hostPid: 1234,
          hostStartTime: "host-start",
          proxyPid: 99,
          proxyStartTime: "proxy-start",
        };
        await writeOwnershipRecord(item, ops);
        let stopped = false;
        await reapOwnershipRecords(
          {
            isAlive: async (pid) => pid === 1234 || pid === 99,
            startTime: async (pid) =>
              unreadable ? undefined : pid === 1234 ? "host-start" : "proxy-start",
            status: async () => [],
            command: async () => ["varlock", "proxy", "start"],
            stop: async () => {
              stopped = true;
            },
          },
          ops,
        );
        expect(stopped).toBe(false);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });

  test("ledger orphan path also consults the live-host veto", async () => {
    const { root, ops } = await fixture();
    try {
      await appendProxyLedgerEntry(
        {
          version: 1,
          sessionUuid: "ledger-host",
          proxyPid: 99,
          ownerPid: 99,
          hostPid: 1234,
          hostStartTime: "host-start",
          cwd: "/project",
          created: new Date(0).toISOString(),
        },
        ops,
        ops.ledgerPath,
      );
      let stopped = false;
      await reapOwnershipRecords(
        {
          isAlive: async () => true,
          startTime: async () => "host-start",
          status: async () => [
            {
              uuid: "ledger-host",
              ownerPid: 99,
              startedAt: new Date(0).toISOString(),
            },
          ],
          stop: async () => {
            stopped = true;
          },
        },
        ops,
      );
      expect(stopped).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("host PID reuse beyond tolerance is treated as a dead host", async () => {
    const { root, ops } = await fixture();
    try {
      const item = {
        ...record("4".repeat(64)),
        hostPid: 1234,
        hostStartTime: "2026-11-25T10:00:00.000Z",
        proxyPid: 99,
        proxyStartTime: "proxy-start",
      };
      await writeOwnershipRecord(item, ops);
      let active = true;
      let stopped = false;
      await reapOwnershipRecords(
        {
          isAlive: async () => true,
          startTime: async (pid) => (pid === 1234 ? "2026-11-25T10:01:00.000Z" : "proxy-start"),
          status: async () =>
            active
              ? [{ uuid: item.sessionUuid, ownerPid: 99, startedAt: new Date(0).toISOString() }]
              : [],
          command: async () => [
            "varlock",
            "proxy",
            "start",
            "--cert-dir",
            join(tmpdir(), "key-ferry-cert-old"),
          ],
          processEnv: async () => ({ KEY_FERRY_PROXY_MARKER: "key-ferry" }),
          parentPid: async () => 1,
          initCommand: async () => verifiedInit,
          stop: async () => {
            stopped = true;
            active = false;
          },
        },
        ops,
      );
      expect(stopped).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("proxy liveness accepts mixed start-time formats", async () => {
    const record = {
      ...({} as any),
      proxyStartTime: "ms:1795600800000",
    };
    await expect(
      proxyIsAlive(99, record, {
        isAlive: async () => true,
        startTime: async () => psLstart(new Date("2026-11-25T10:00:04.000Z")),
        stop: async () => undefined,
      }),
    ).resolves.toBe(true);
  });

  test("sweeps only old unreferenced cert directories", async () => {
    const { root, ops } = await fixture();
    try {
      const old = join(root, "key-ferry-cert-old");
      const referenced = join(root, "key-ferry-cert-referenced");
      const recent = join(root, "key-ferry-cert-recent");
      const link = join(root, "key-ferry-cert-link");
      await mkdir(old);
      await mkdir(referenced);
      await mkdir(recent);
      await symlink(old, link);
      const oldTime = new Date(Date.now() - 120_000);
      await utimes(old, oldTime, oldTime);
      await utimes(referenced, oldTime, oldTime);
      await reapOwnershipRecords(
        {
          status: async () => [],
          stop: async () => undefined,
          listProcesses: async () => [
            {
              pid: 1,
              command: [
                "varlock",
                "proxy",
                "start",
                "--cert-dir",
                referenced.replace(/^\/private/, ""),
              ],
            },
          ],
          tempDirectory: root,
        },
        ops,
      );
      await expect(lstat(old)).rejects.toThrow();
      expect((await lstat(referenced)).isDirectory()).toBe(true);
      expect((await lstat(recent)).isDirectory()).toBe(true);
      expect((await lstat(link)).isSymbolicLink()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("does not sweep when the live process listing is unavailable", async () => {
    const { root, ops } = await fixture();
    try {
      const old = join(root, "key-ferry-cert-listing-failure");
      await mkdir(old);
      const oldTime = new Date(Date.now() - 120_000);
      await utimes(old, oldTime, oldTime);
      await reapOwnershipRecords(
        {
          status: async () => [],
          stop: async () => undefined,
          listProcesses: async () => undefined,
          tempDirectory: root,
        },
        ops,
      );
      expect((await lstat(old)).isDirectory()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("keeps a cert directory owned by another uid", async () => {
    const { root, ops } = await fixture();
    try {
      const candidate = join(root, "key-ferry-cert-wrong-uid");
      await mkdir(candidate);
      const oldTime = new Date(Date.now() - 120_000);
      await utimes(candidate, oldTime, oldTime);
      const realLstat = ops.lstat!;
      const wrappedOps = {
        ...ops,
        lstat: async (path: string) => {
          const info = await realLstat(path);
          if (path.endsWith("key-ferry-cert-wrong-uid"))
            return {
              ...info,
              uid: (process.getuid?.() ?? 0) + 1,
            };
          return info;
        },
      };
      await reapOwnershipRecords(
        {
          status: async () => [],
          stop: async () => undefined,
          listProcesses: async () => [],
          tempDirectory: root,
        },
        wrappedOps,
      );
      expect((await lstat(candidate)).isDirectory()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
