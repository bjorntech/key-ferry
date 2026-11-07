import { execFile } from "node:child_process";
import {
  mkdir,
  readFile,
  readdir,
  rm,
  lstat,
  rename,
  writeFile,
  appendFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, basename } from "node:path";
import { promisify } from "node:util";

export const OWNERSHIP_RECORD_VERSION = 2;
export interface BrokerOwnershipRecord {
  readonly version?: 2;
  readonly brokerKeyHash: string;
  readonly sessionUuid: string;
  readonly starterPid: number;
  readonly starterStartTime?: string;
  readonly cwd: string;
  readonly created: string;
  /** @deprecated accepted only while reading old records, never written */
  readonly sessionId?: string;
  readonly pid?: number;
  readonly pidStartTime?: string;
  readonly command?: readonly string[];
  /** Durable identity of the daemon, retained even when the temp record is lost. */
  readonly proxyPid?: number;
  readonly proxyStartTime?: string;
}

export interface ProxyLedgerEntry {
  readonly version: 1;
  readonly sessionUuid: string;
  readonly proxyPid: number;
  readonly proxyStartTime?: string;
  readonly ownerPid: number;
  readonly ownerStartTime?: string;
  readonly cwd: string;
  readonly created: string;
  readonly retiredAt?: string;
}

export interface OwnershipFileOps {
  readonly mkdir: typeof mkdir;
  readonly readFile: typeof readFile;
  readonly readdir: typeof readdir;
  readonly rm: typeof rm;
  readonly lstat?: typeof lstat;
  readonly rename?: typeof rename;
  readonly writeFile: typeof writeFile;
  readonly appendFile?: typeof appendFile;
  /** Test seam; production uses the per-user temporary directory. */
  readonly directory?: string;
  /** Optional test seam; production ledgerPath() is durable user state. */
  readonly ledgerPath?: string;
}
const files: OwnershipFileOps = {
  mkdir,
  readFile,
  readdir,
  rm,
  lstat,
  rename,
  writeFile,
  appendFile,
};

export function ledgerPath(): string {
  const state = process.env.XDG_STATE_HOME ?? join(homedir(), "Library", "Application Support");
  return join(state, "key-ferry", "proxy-ledger.jsonl");
}

export async function appendProxyLedgerEntry(
  entry: ProxyLedgerEntry,
  ops: OwnershipFileOps = files,
  path = ledgerPath(),
): Promise<void> {
  if (!ops.appendFile) return;
  await ops.mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
  await ops.appendFile(path, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
}

export async function readProxyLedger(
  ops: OwnershipFileOps = files,
  path = ledgerPath(),
): Promise<ProxyLedgerEntry[]> {
  if (!ops.appendFile) return [];
  let text: string;
  try {
    text = await ops.readFile(path, "utf8");
  } catch {
    return [];
  }
  const entries = new Map<string, ProxyLedgerEntry>();
  for (const line of text.split("\n")) applyLedgerLine(line, entries);
  return [...entries.values()];
}

function applyLedgerLine(line: string, entries: Map<string, ProxyLedgerEntry>): void {
  try {
    const value = JSON.parse(line);
    if (!isLedgerEntry(value)) return;
    if (value.retiredAt) entries.delete(value.sessionUuid);
    else entries.set(value.sessionUuid, value);
  } catch {
    /* tolerate a torn/corrupt append */
  }
}

function isLedgerEntry(value: any): value is ProxyLedgerEntry {
  return value?.version === 1 && validLedgerIdentity(value) && validLedgerMetadata(value);
}
function validLedgerIdentity(value: any): boolean {
  return (
    typeof value.sessionUuid === "string" &&
    Number.isSafeInteger(value.proxyPid) &&
    Number.isSafeInteger(value.ownerPid)
  );
}
function validLedgerMetadata(value: any): boolean {
  return typeof value.cwd === "string" && typeof value.created === "string";
}

async function retireProxyLedgerEntry(
  entry: ProxyLedgerEntry,
  ops: OwnershipFileOps,
): Promise<void> {
  await appendProxyLedgerEntry(
    { ...entry, retiredAt: new Date().toISOString() },
    ops,
    ops.ledgerPath,
  );
}
const exec = promisify(execFile);
const inFlightByOps = new WeakMap<
  object,
  Map<string, Promise<{ reaped: number; skipped: number }>>
>();
type ReaperEvent = {
  readonly event: "stale-reaped" | "stale-skipped";
  readonly keyHash: string;
  readonly directory?: string;
};
const lifecycleLoggers = new Set<(event: ReaperEvent) => void>();
export function setOwnershipLifecycleLogger(
  logger: ((event: ReaperEvent) => void) | undefined,
): () => void {
  if (!logger) return () => undefined;
  lifecycleLoggers.add(logger);
  let active = true;
  return () => {
    if (active) lifecycleLoggers.delete(logger);
    active = false;
  };
}

export function ownershipDirectory(root = tmpdir()): string {
  const uid = typeof process.getuid === "function" ? String(process.getuid()) : "unknown";
  return join(root, `key-ferry-${uid}`);
}
export function ownershipFileOps(directory: string): OwnershipFileOps {
  return { ...files, directory };
}
function safeName(hash: string): string {
  if (!/^[a-f0-9]{8,128}$/.test(hash)) throw new TypeError("invalid broker key hash");
  return `${hash}.json`;
}

async function secureDirectory(ops: OwnershipFileOps): Promise<string> {
  const directory = ops.directory ?? ownershipDirectory();
  // Minimal injected stores may model only record files; the real implementation
  // always provides lstat and therefore always takes the security checks below.
  if (!ops.lstat) return directory;
  try {
    const info = await directoryInfo(ops, directory);
    assertSecureDirectory(info);
    return directory;
  } catch {
    for (const logger of lifecycleLoggers)
      logger({ event: "stale-skipped", keyHash: "0".repeat(12), directory });
    throw new Error("ownership directory unavailable");
  }
}

async function directoryInfo(ops: OwnershipFileOps, directory: string): Promise<any> {
  try {
    return await (ops.lstat ?? lstat)(directory);
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
    await createDirectory(ops, directory);
    return (ops.lstat ?? lstat)(directory);
  }
}

async function createDirectory(ops: OwnershipFileOps, directory: string): Promise<void> {
  try {
    await ops.mkdir(directory, { recursive: false, mode: 0o700 });
  } catch (error: any) {
    if (error?.code !== "EEXIST") throw error;
  }
}

function assertSecureDirectory(info: any): void {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  const insecure = [
    info.isSymbolicLink(),
    !info.isDirectory(),
    uid !== undefined && info.uid !== uid,
    (Number(info.mode) & 0o077) !== 0,
  ].some(Boolean);
  if (insecure) throw new Error("insecure ownership directory");
}

export async function writeOwnershipRecord(
  record: BrokerOwnershipRecord,
  ops: OwnershipFileOps = files,
): Promise<void> {
  const directory = await secureDirectory(ops);
  const target = join(directory, safeName(record.brokerKeyHash));
  const temporary = join(
    directory,
    `.${basename(target)}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  // wx prevents an attacker from replacing a file we are about to publish.
  const published = publishedRecord(record, directory);
  await ops.writeFile(temporary, `${JSON.stringify(published)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  try {
    await (ops.rename ?? rename)(temporary, target);
  } catch (error) {
    await ops.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}
function publishedRecord(record: BrokerOwnershipRecord, directory: string) {
  const sessionUuid = record.sessionUuid ?? record.sessionId;
  const starterPid = record.starterPid ?? record.pid;
  const starterStartTime = record.starterStartTime ?? record.pidStartTime;
  return {
    version: 2,
    brokerKeyHash: record.brokerKeyHash,
    sessionUuid,
    starterPid,
    ...optionalStartTime(starterStartTime),
    cwd: record.cwd ?? directory,
    created: record.created,
  };
}
function optionalStartTime(value: string | undefined): {
  starterStartTime?: string;
} {
  return value ? { starterStartTime: value } : {};
}
export async function removeOwnershipRecord(
  hash: string,
  ops: OwnershipFileOps = files,
): Promise<void> {
  const dir = await secureDirectory(ops);
  await ops.rm(join(dir, safeName(hash)), { force: true });
}

function normalize(value: any): BrokerOwnershipRecord | undefined {
  return isNormalizedRecord(value) ? value : undefined;
}
function isNormalizedRecord(value: any): boolean {
  return (
    value?.version === 2 &&
    typeof value.sessionUuid === "string" &&
    Number.isSafeInteger(value.starterPid) &&
    typeof value.cwd === "string" &&
    typeof value.created === "string"
  );
}
export async function readOwnershipRecords(
  ops: OwnershipFileOps = files,
  onError?: (error: unknown) => void,
): Promise<BrokerOwnershipRecord[]> {
  let directory: string;
  try {
    directory = await secureDirectory(ops);
  } catch {
    onError?.(new Error("ownership directory unavailable"));
    return [];
  }
  let names: string[];
  try {
    names = await ops.readdir(directory);
  } catch {
    onError?.(new Error("ownership directory unavailable"));
    return [];
  }
  const records: BrokerOwnershipRecord[] = [];
  for (const name of names.filter((item) => /^[a-f0-9]{8,128}\.json$/.test(item))) {
    const record = await readRecord(ops, join(directory, name));
    if (record) records.push(record);
  }
  // Directory enumeration order is filesystem-dependent (notably on ext4),
  // so callers must not observe readdir order as ownership-record order.
  return records.sort(
    (left, right) =>
      left.created.localeCompare(right.created) ||
      left.sessionUuid.localeCompare(right.sessionUuid),
  );
}
async function readRecord(
  ops: OwnershipFileOps,
  path: string,
): Promise<BrokerOwnershipRecord | undefined> {
  try {
    const info = ops.lstat ? await ops.lstat(path) : undefined;
    if (info && !regularRecordFile(info)) return undefined;
    const record = normalize(JSON.parse(await ops.readFile(path, "utf8")));
    await removeInvalidRecord(record, ops, path);
    return record;
  } catch {
    await ops.rm(path, { force: true }).catch(() => undefined);
    return undefined;
  }
}
async function removeInvalidRecord(
  record: BrokerOwnershipRecord | undefined,
  ops: OwnershipFileOps,
  path: string,
): Promise<void> {
  if (!record) await ops.rm(path, { force: true });
}
function regularRecordFile(info: any): boolean {
  return !info.isSymbolicLink() && info.isFile();
}

export interface OwnershipVerifier {
  readonly isAlive?: (pid: number) => Promise<boolean>;
  readonly startTime?: (pid: number) => Promise<string | undefined>;
  readonly command?: (pid: number) => Promise<readonly string[] | undefined>;
  /** Read the environment of the actual daemon PID. undefined means unknown. */
  readonly processEnv?: (pid: number) => Promise<Readonly<Record<string, string>> | undefined>;
  /** The configured executable/prefix used to launch proxy start. */
  readonly expectedCommand?: readonly string[];
  readonly status?: () => Promise<
    readonly {
      readonly uuid: string;
      readonly endedAt?: string;
      readonly ownerPid?: number;
      readonly cwd?: string;
      /** Explicit Varlock metadata, when supported by the installed CLI. */
      readonly keyFerryMarker?: string;
      readonly pid?: number;
      readonly startTime?: string;
    }[]
  >;
  readonly stop: (record: BrokerOwnershipRecord) => Promise<void>;
}
export async function reapOwnershipRecords(
  verifier: OwnershipVerifier,
  ops: OwnershipFileOps = files,
): Promise<{ reaped: number; skipped: number }> {
  const key = ops.directory ?? ownershipDirectory();
  const byDirectory = inFlightByOps.get(ops as object) ?? new Map();
  inFlightByOps.set(ops as object, byDirectory);
  const existing = byDirectory.get(key);
  if (existing) return existing;
  const operation = reapOwnershipRecordsOnce(verifier, ops).finally(() => {
    if (byDirectory.get(key) === operation) byDirectory.delete(key);
  });
  byDirectory.set(key, operation);
  return operation;
}
async function reapOwnershipRecordsOnce(
  verifier: OwnershipVerifier,
  ops: OwnershipFileOps,
): Promise<{ reaped: number; skipped: number }> {
  const records = await readOwnershipRecords(ops, () =>
    lifecycleLoggers.forEach((l) =>
      l({
        event: "stale-skipped",
        keyHash: "0".repeat(12),
        directory: ownershipDirectory(),
      }),
    ),
  );
  // The optional verifier seam preserves compatibility with small injected test
  // verifiers. The production reaper always supplies status and therefore never
  // relies on starter liveness to decide whether a daemon is owned.
  if (!verifier.status) return reapLegacyRecords(records, verifier, ops);
  let sessions: readonly {
    uuid: string;
    endedAt?: string;
    ownerPid?: number;
    cwd?: string;
    keyFerryMarker?: string;
    pid?: number;
    startTime?: string;
  }[];
  try {
    sessions = await verifier.status();
  } catch {
    for (const r of records)
      lifecycleLoggers.forEach((l) =>
        l({
          event: "stale-skipped",
          keyHash: r.brokerKeyHash.slice(0, 12),
          directory: r.cwd,
        }),
      );
    return { reaped: 0, skipped: records.length };
  }
  const result = await reapActiveRecords(records, sessions, verifier, ops);
  await reapOrphanSessions(records, sessions, verifier, ops, result);
  return result;
}

async function reapOrphanSessions(
  records: BrokerOwnershipRecord[],
  sessions: readonly {
    uuid: string;
    endedAt?: string;
    ownerPid?: number;
    cwd?: string;
    keyFerryMarker?: string;
    pid?: number;
    startTime?: string;
  }[],
  verifier: OwnershipVerifier,
  ops: OwnershipFileOps,
  result: { reaped: number; skipped: number },
): Promise<void> {
  const ledger = await readProxyLedger(ops, ops.ledgerPath);
  const recorded = new Set(records.map((record) => record.sessionUuid));
  for (const session of sessions)
    await reapOrphanSession(session, recorded, ledger, verifier, ops, result);
}

async function reapOrphanSession(
  session: {
    uuid: string;
    endedAt?: string;
    ownerPid?: number;
    cwd?: string;
    keyFerryMarker?: string;
    pid?: number;
    startTime?: string;
  },
  recorded: Set<string>,
  ledger: ProxyLedgerEntry[],
  verifier: OwnershipVerifier,
  ops: OwnershipFileOps,
  result: { reaped: number; skipped: number },
): Promise<void> {
  if (session.endedAt || recorded.has(session.uuid)) return;
  const proxyPid = session.pid ?? session.ownerPid;
  const orphan =
    proxyPid === undefined ? undefined : await findOrphanOwner(session, proxyPid, ledger, verifier);
  if (orphan)
    await stopOrphanSession(session, orphan.entry, orphan.ownerPid, verifier, ops, result);
}

async function findOrphanOwner(
  session: {
    uuid: string;
    ownerPid?: number;
    keyFerryMarker?: string;
    pid?: number;
    startTime?: string;
  },
  proxyPid: number,
  ledger: ProxyLedgerEntry[],
  verifier: OwnershipVerifier,
): Promise<{ entry: ProxyLedgerEntry | undefined; ownerPid: number } | undefined> {
  const entry = ledger.find((item) =>
    matchesLedgerEntry(item, session.uuid, proxyPid, session.startTime),
  );
  if (!(await hasPositiveOwnership(entry, session, proxyPid, verifier)) || !verifier.isAlive)
    return undefined;
  const ownerPid = entry?.ownerPid ?? session.ownerPid;
  if (ownerPid === undefined || (await ownerAlive(ownerPid, entry?.ownerStartTime, verifier)))
    return undefined;
  return { entry, ownerPid };
}

async function stopOrphanSession(
  session: { uuid: string; ownerPid?: number; cwd?: string },
  entry: ProxyLedgerEntry | undefined,
  ownerPid: number,
  verifier: OwnershipVerifier,
  ops: OwnershipFileOps,
  result: { reaped: number; skipped: number },
): Promise<void> {
  try {
    await verifier.stop(makeOrphanRecord(session, entry, ownerPid));
    if (await sessionGone(session.uuid, verifier)) {
      if (entry) await retireProxyLedgerEntry(entry, ops).catch(() => undefined);
      result.reaped++;
    } else result.skipped++;
  } catch {
    result.skipped++;
  }
}

function matchesLedgerEntry(
  entry: ProxyLedgerEntry,
  uuid: string,
  pid: number,
  start?: string,
): boolean {
  return (
    entry.sessionUuid === uuid &&
    entry.proxyPid === pid &&
    (entry.proxyStartTime === undefined || start === undefined || entry.proxyStartTime === start)
  );
}

async function hasPositiveOwnership(
  entry: ProxyLedgerEntry | undefined,
  session: { keyFerryMarker?: string },
  pid: number,
  verifier: OwnershipVerifier,
): Promise<boolean> {
  if (entry || session.keyFerryMarker === "key-ferry") return true;
  if (!verifier.processEnv) return false;
  const env = await verifier.processEnv(pid).catch(() => undefined);
  return env?.KEY_FERRY_PROXY_MARKER === "key-ferry";
}

function makeOrphanRecord(
  session: { uuid: string; ownerPid?: number; cwd?: string },
  entry: ProxyLedgerEntry | undefined,
  ownerPid: number,
): BrokerOwnershipRecord {
  return {
    version: 2,
    brokerKeyHash: "f".repeat(64),
    sessionUuid: session.uuid,
    starterPid: ownerPid,
    ...orphanStartTime(entry?.ownerStartTime, "starterStartTime"),
    cwd: entry?.cwd ?? session.cwd ?? "",
    created: entry?.created ?? new Date().toISOString(),
    ...optionalNumber(entry?.proxyPid, "proxyPid"),
    ...orphanStartTime(entry?.proxyStartTime, "proxyStartTime"),
  };
}

function orphanStartTime(value: string | undefined, key: "starterStartTime" | "proxyStartTime") {
  return value ? { [key]: value } : {};
}
function optionalNumber(value: number | undefined, key: "proxyPid") {
  return value === undefined ? {} : { [key]: value };
}

async function ownerAlive(
  pid: number,
  expected: string | undefined,
  verifier: OwnershipVerifier,
): Promise<boolean> {
  if (!verifier.isAlive || !(await verifier.isAlive(pid))) return false;
  if (!expected || !verifier.startTime) return true;
  const actual = await verifier.startTime(pid);
  return actual === expected;
}
async function reapLegacyRecords(
  records: BrokerOwnershipRecord[],
  verifier: OwnershipVerifier,
  ops: OwnershipFileOps,
) {
  let reaped = 0,
    skipped = 0;
  for (const record of records) {
    if (await legacyRecordIsStale(record, verifier)) {
      skipped++;
      await removeOwnershipRecord(record.brokerKeyHash, ops);
    } else {
      await verifier.stop(record);
      await removeOwnershipRecord(record.brokerKeyHash, ops);
      reaped++;
    }
  }
  return { reaped, skipped };
}
async function legacyRecordIsStale(
  record: BrokerOwnershipRecord,
  verifier: OwnershipVerifier,
): Promise<boolean> {
  const alive = (await verifier.isAlive?.(record.starterPid)) ?? false;
  const start = await verifier.startTime?.(record.starterPid);
  const command = await verifier.command?.(record.starterPid);
  return !alive || start !== record.starterStartTime || command === undefined;
}
async function reapActiveRecords(
  records: BrokerOwnershipRecord[],
  sessions: readonly {
    uuid: string;
    endedAt?: string;
    ownerPid?: number;
    cwd?: string;
    keyFerryMarker?: string;
  }[],
  verifier: OwnershipVerifier,
  ops: OwnershipFileOps,
) {
  let reaped = 0,
    skipped = 0;
  for (const record of records) {
    const result = await reapActiveRecord(record, sessions, verifier, ops);
    reaped += result.reaped;
    skipped += result.skipped;
  }
  return { reaped, skipped };
}

async function reapActiveRecord(
  record: BrokerOwnershipRecord,
  sessions: readonly { uuid: string; endedAt?: string }[],
  verifier: OwnershipVerifier,
  ops: OwnershipFileOps,
): Promise<{ reaped: number; skipped: number }> {
  const active = sessions.find((s) => s.uuid === record.sessionUuid && !s.endedAt);
  if (!active) {
    await removeInactiveRecord(record, verifier, ops);
    return { reaped: 1, skipped: 0 };
  }
  if (await starterStillOwned(record, verifier)) return { reaped: 0, skipped: 1 };
  return reapOwnedRecord(record, verifier, ops);
}

async function removeInactiveRecord(
  record: BrokerOwnershipRecord,
  verifier: OwnershipVerifier,
  ops: OwnershipFileOps,
): Promise<void> {
  await retireInactiveLedger(record, verifier, ops);
  await removeOwnershipRecord(record.brokerKeyHash, ops);
  lifecycleLoggers.forEach((l) =>
    l({ event: "stale-reaped", keyHash: record.brokerKeyHash.slice(0, 12), directory: record.cwd }),
  );
}

async function retireInactiveLedger(
  record: BrokerOwnershipRecord,
  verifier: OwnershipVerifier,
  ops: OwnershipFileOps,
): Promise<void> {
  if (await sessionGone(record.sessionUuid, verifier)) {
    const ledger = await readProxyLedger(ops, ops.ledgerPath);
    await retireLedgerEntry(ledger, record.sessionUuid, ops);
  }
}

async function retireLedgerEntry(
  ledger: ProxyLedgerEntry[],
  sessionUuid: string,
  ops: OwnershipFileOps,
): Promise<void> {
  const entry = ledger.find((item) => item.sessionUuid === sessionUuid);
  if (entry) await retireProxyLedgerEntry(entry, ops).catch(() => undefined);
}

async function reapOwnedRecord(
  record: BrokerOwnershipRecord,
  verifier: OwnershipVerifier,
  ops: OwnershipFileOps,
): Promise<{ reaped: number; skipped: number }> {
  try {
    await verifier.stop(record);
    if (!(await sessionGone(record.sessionUuid, verifier))) return { reaped: 0, skipped: 1 };
    await removeOwnershipRecord(record.brokerKeyHash, ops);
    const ledger = await readProxyLedger(ops, ops.ledgerPath);
    const entry = ledger.find((item) => item.sessionUuid === record.sessionUuid);
    if (entry) await retireProxyLedgerEntry(entry, ops).catch(() => undefined);
    lifecycleLoggers.forEach((l) =>
      l({
        event: "stale-reaped",
        keyHash: record.brokerKeyHash.slice(0, 12),
        directory: record.cwd,
      }),
    );
    return { reaped: 1, skipped: 0 };
  } catch {
    return { reaped: 0, skipped: 1 };
  }
}

const REAP_VERIFY_ATTEMPTS = 3;
const REAP_VERIFY_DELAY_MS = 50;

async function sessionGone(sessionUuid: string, verifier: OwnershipVerifier): Promise<boolean> {
  if (!verifier.status) return false;
  for (let attempt = 0; attempt < REAP_VERIFY_ATTEMPTS; attempt++) {
    const sessions = await verifier.status().catch(() => undefined);
    if (sessions && !sessions.some((session) => session.uuid === sessionUuid && !session.endedAt))
      return true;
    await waitForReapAttempt(attempt);
  }
  return false;
}
async function waitForReapAttempt(attempt: number): Promise<void> {
  if (attempt + 1 < REAP_VERIFY_ATTEMPTS)
    await new Promise((resolve) => setTimeout(resolve, REAP_VERIFY_DELAY_MS));
}

function normalizeProxyStatus(parsed: any) {
  const sessions = proxyStatusSessions(parsed);
  return sessions.map((session: any) => ({
    ...session,
    keyFerryMarker: session.env?.KEY_FERRY_PROXY_MARKER,
    pid: session.ownerPid,
    startTime: session.startedAt,
  }));
}

function proxyStatusSessions(parsed: any): any[] {
  return Array.isArray(parsed) ? parsed : proxyStatusFallback(parsed);
}
function proxyStatusFallback(parsed: any): any[] {
  return parsed.sessions ?? [];
}

async function readProcessEnvironment(
  pid: number,
): Promise<Readonly<Record<string, string>> | undefined> {
  try {
    const result = await exec(...processEnvironmentCommand(pid), { timeout: 2_000 });
    return parseProcessMarker(result.stdout);
  } catch {
    return undefined;
  }
}

function processEnvironmentCommand(pid: number): [string, string[]] {
  return process.platform === "darwin"
    ? ["ps", ["-Eww", "-p", String(pid), "-o", "command="]]
    : ["sh", ["-c", `tr '\0' ' ' < /proc/${pid}/environ`]];
}

function parseProcessMarker(stdout: string): Readonly<Record<string, string>> {
  const marker = stdout.match(/(?:^|\s)KEY_FERRY_PROXY_MARKER=([^\s]+)/)?.[1];
  return marker === undefined ? {} : { KEY_FERRY_PROXY_MARKER: marker };
}

export function reapStaleOwnershipRecords(
  command: string | readonly string[] = "varlock",
  ops: OwnershipFileOps = files,
): Promise<void> {
  const directory = ops.directory ?? ownershipDirectory();
  const configuredCommand = typeof command === "string" ? [command] : [...command];
  const executable = configuredCommand[0] ?? "varlock";
  const verifier: OwnershipVerifier = {
    expectedCommand: configuredCommand,
    status: async () => {
      const result = await exec(executable, ["proxy", "status", "--format", "json"], {
        timeout: 2_000,
      });
      return normalizeProxyStatus(JSON.parse(result.stdout));
    },
    stop: async (record) => {
      await exec(executable, ["proxy", "stop", "--session", record.sessionUuid], {
        timeout: 2_000,
      });
    },
    isAlive: async (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    },
    startTime: async (pid) => {
      try {
        const result = await exec("ps", ["-o", "lstart=", "-p", String(pid)], {
          timeout: 2_000,
        });
        return result.stdout.trim();
      } catch {
        return undefined;
      }
    },
    processEnv: (pid) => readProcessEnvironment(pid),
    command: async (pid) => {
      try {
        const result = await exec("ps", ["-o", "command=", "-p", String(pid)], {
          timeout: 2_000,
        });
        return result.stdout.trim().split(/\s+/);
      } catch {
        return undefined;
      }
    },
  };
  return reapOwnershipRecords(verifier, ops)
    .then(() => undefined)
    .catch(() => undefined);
}

export async function starterStillOwned(
  record: BrokerOwnershipRecord,
  verifier: OwnershipVerifier,
): Promise<boolean> {
  if (!hasStarterVerifier(record, verifier)) return false;
  const isAlive = verifier.isAlive;
  const getStartTime = verifier.startTime;
  const getCommand = verifier.command;
  if (!isAlive || !getStartTime || !getCommand) return false;
  const alive = await isAlive(record.starterPid);
  const start = await getStartTime(record.starterPid);
  const command = await getCommand(record.starterPid);
  return sameStarterIdentity(
    alive,
    start,
    command,
    record.starterStartTime,
    verifier.expectedCommand,
  );
}

export function hasStarterVerifier(
  record: BrokerOwnershipRecord,
  verifier: OwnershipVerifier,
): boolean {
  return [record.starterStartTime, verifier.isAlive, verifier.startTime, verifier.command].every(
    Boolean,
  );
}

export function sameStarterIdentity(
  alive: boolean,
  start: string | undefined,
  command: readonly string[] | undefined,
  expectedStart: string | undefined,
  expectedCommand: readonly string[] = ["varlock"],
): boolean {
  const configured = expectedCommand.length > 0 ? expectedCommand : ["varlock"];
  const executableMatches =
    command !== undefined &&
    basename(command[0] ?? "") === basename(configured[0] ?? "") &&
    configured.slice(1).every((part, index) => command[index + 1] === part);
  const startPrefix = command?.slice(configured.length, configured.length + 2);
  return [
    alive,
    start === expectedStart,
    command,
    executableMatches,
    JSON.stringify(startPrefix) === JSON.stringify(["proxy", "start"]),
  ].every(Boolean);
}
