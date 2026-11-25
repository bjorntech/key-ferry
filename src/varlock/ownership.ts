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
  realpath,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, basename, resolve } from "node:path";
import { promisify } from "node:util";

// Keep the wire versions understood by 0.1.17. That release validates the
// version but ignores unknown JSON fields, so the host identity is additive.
export const OWNERSHIP_RECORD_VERSION = 2;
export const PROXY_LEDGER_VERSION = 1;
export const ORPHAN_GRACE_MS = 60_000;
export const START_TIME_TOLERANCE_MS = 5_000;

/** Converts ISO, `ps lstart`, epoch, and our canonical values to milliseconds. */
export function normalizeStartTime(value: string | undefined): number | undefined {
  if (!value) return undefined;
  return parseCanonicalStart(value) ?? parseNumericStart(value) ?? parseDateStart(value);
}
function parseCanonicalStart(value: string): number | undefined {
  const match = /^ms:(\d+)$/.exec(value);
  return match ? Number(match[1]) : undefined;
}
function parseNumericStart(value: string): number | undefined {
  if (!/^\d+$/.test(value)) return undefined;
  const numeric = Number(value);
  return numeric < 100_000_000_000 ? numeric * 1_000 : numeric;
}
function parseDateStart(value: string): number | undefined {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function canonicalStartTime(value: string | undefined): string | undefined {
  const normalized = normalizeStartTime(value);
  return normalized === undefined ? value : `ms:${Math.round(normalized)}`;
}

export function startTimesMatch(
  actual: string | undefined,
  expected: string | undefined,
  toleranceMs = START_TIME_TOLERANCE_MS,
): boolean {
  if (!actual || !expected) return false;
  const actualMs = normalizeStartTime(actual);
  const expectedMs = normalizeStartTime(expected);
  if (actualMs !== undefined && expectedMs !== undefined)
    return Math.abs(actualMs - expectedMs) <= toleranceMs;
  // Opaque values occur only in legacy fixtures/records. They are never
  // compared with a timestamp from another source.
  return actual === expected;
}
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
  readonly certDirectory?: string;
  readonly hostPid?: number;
  readonly hostStartTime?: string;
}

export interface ProxyLedgerEntry {
  readonly version: 1 | 2;
  readonly sessionUuid: string;
  readonly proxyPid: number;
  readonly proxyStartTime?: string;
  readonly ownerPid: number;
  readonly ownerStartTime?: string;
  readonly cwd: string;
  readonly created: string;
  readonly retiredAt?: string;
  readonly certDirectory?: string;
  readonly hostPid?: number;
  readonly hostStartTime?: string;
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
  return (
    (value?.version === 1 || value?.version === 2) &&
    validLedgerIdentity(value) &&
    validLedgerMetadata(value)
  );
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
    version: OWNERSHIP_RECORD_VERSION,
    brokerKeyHash: record.brokerKeyHash,
    sessionUuid,
    starterPid,
    ...optionalStartTime(starterStartTime),
    cwd: record.cwd ?? directory,
    created: record.created,
    ...optionalRecordFields(record),
  };
}
function optionalRecordFields(record: BrokerOwnershipRecord) {
  return {
    ...optionalField("proxyPid", record.proxyPid),
    ...optionalField("proxyStartTime", record.proxyStartTime),
    ...optionalField("certDirectory", record.certDirectory),
    ...optionalField("hostPid", record.hostPid),
    ...optionalField("hostStartTime", record.hostStartTime),
  };
}
function optionalField(key: string, value: unknown): Record<string, unknown> {
  return value === undefined ? {} : { [key]: value };
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
  readonly parentPid?: (pid: number) => Promise<number | undefined>;
  readonly initCommand?: () => Promise<readonly string[] | undefined>;
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
      readonly env?: Readonly<Record<string, string>>;
      readonly pid?: number;
      readonly startTime?: string;
    }[]
  >;
  readonly stop: (record: BrokerOwnershipRecord) => Promise<void>;
  readonly now?: () => number;
  readonly tempDirectory?: string;
  readonly listProcesses?: () => Promise<
    readonly { pid: number; command: readonly string[] }[] | undefined
  >;
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
    env?: Readonly<Record<string, string>>;
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
  await sweepCertDirectories(records, sessions, verifier, ops);
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
    env?: Readonly<Record<string, string>>;
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
    env?: Readonly<Record<string, string>>;
    pid?: number;
    startTime?: string;
    startedAt?: string;
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
    env?: Readonly<Record<string, string>>;
    pid?: number;
    startTime?: string;
    startedAt?: string;
  },
  proxyPid: number,
  ledger: ProxyLedgerEntry[],
  verifier: OwnershipVerifier,
): Promise<{ entry: ProxyLedgerEntry | undefined; ownerPid: number } | undefined> {
  const entry = ledger.find((item) =>
    matchesLedgerEntry(item, session.uuid, proxyPid, session.startTime),
  );
  if (!orphanLedgerMatches(ledger, session.uuid, proxyPid, entry)) return undefined;
  if (!(await hasPositiveOwnership(entry, session, proxyPid, verifier))) return undefined;
  if (await ledgerHostIsAlive(entry, proxyPid, verifier)) return undefined;
  const ownerPid = entry?.ownerPid ?? proxyPid;
  if (await liveLedgerOwner(entry, ownerPid, verifier)) return undefined;
  return orphanOwnerCandidate(entry, ownerPid, session, proxyPid, verifier);
}
async function liveLedgerOwner(
  entry: ProxyLedgerEntry | undefined,
  ownerPid: number,
  verifier: OwnershipVerifier,
): Promise<boolean> {
  return (
    entry?.ownerPid !== undefined && (await ownerAlive(ownerPid, entry.ownerStartTime, verifier))
  );
}
async function orphanOwnerCandidate(
  entry: ProxyLedgerEntry | undefined,
  ownerPid: number,
  session: { startedAt?: string; startTime?: string },
  proxyPid: number,
  verifier: OwnershipVerifier,
): Promise<{ entry: ProxyLedgerEntry | undefined; ownerPid: number } | undefined> {
  return (await verifiedOrphanProcess(session, proxyPid, verifier))
    ? { entry, ownerPid }
    : undefined;
}
function orphanLedgerMatches(
  ledger: ProxyLedgerEntry[],
  uuid: string,
  pid: number,
  entry: ProxyLedgerEntry | undefined,
): boolean {
  return !hasMismatchedLedgerEntry(ledger, uuid, pid, entry);
}
function hasMismatchedLedgerEntry(
  ledger: ProxyLedgerEntry[],
  uuid: string,
  pid: number,
  entry: ProxyLedgerEntry | undefined,
): boolean {
  return ledger.some(
    (item) => item.sessionUuid === uuid && item.proxyPid === pid && item !== entry,
  );
}
async function ledgerHostIsAlive(
  entry: ProxyLedgerEntry | undefined,
  proxyPid: number,
  verifier: OwnershipVerifier,
): Promise<boolean> {
  if (!entry) return false;
  const hostPid = entry.hostPid ?? entry.ownerPid;
  const hostStart = entry.hostStartTime ?? entry.ownerStartTime;
  return (
    hostPid !== undefined && (await liveHostPid(hostPid, hostStart, entry, proxyPid, verifier))
  );
}
async function liveHostPid(
  hostPid: number,
  hostStart: string | undefined,
  entry: ProxyLedgerEntry,
  proxyPid: number,
  verifier: OwnershipVerifier,
): Promise<boolean> {
  if (!(await ownerAlive(hostPid, hostStart, verifier))) return false;
  return entry.hostPid !== undefined || !legacySelfOwnership(entry, proxyPid);
}

function legacySelfOwnership(entry: ProxyLedgerEntry | undefined, proxyPid: number): boolean {
  return entry !== undefined && entry.ownerPid === proxyPid;
}

async function verifiedOrphanProcess(
  session: {
    startedAt?: string;
    startTime?: string;
    keyFerryMarker?: string;
    env?: Readonly<Record<string, string>>;
  },
  proxyPid: number,
  verifier: OwnershipVerifier,
): Promise<boolean> {
  const identity = await readOrphanIdentity(proxyPid, verifier);
  return (
    identity !== undefined &&
    (await isVerifiedInit(verifier)) &&
    isProxyStartCommand(identity.command) &&
    orphanAgeElapsed(session.startedAt, verifier.now?.() ?? Date.now())
  );
}
async function readOrphanIdentity(
  pid: number,
  verifier: OwnershipVerifier,
): Promise<{ command: readonly string[] } | undefined> {
  if (!hasOrphanIdentityVerifiers(verifier)) return undefined;
  if (!(await verifier.isAlive(pid))) return undefined;
  return readVerifiedOrphanCommand(pid, verifier);
}
async function readVerifiedOrphanCommand(
  pid: number,
  verifier: OwnershipVerifier & {
    command: NonNullable<OwnershipVerifier["command"]>;
    parentPid: NonNullable<OwnershipVerifier["parentPid"]>;
    processEnv: NonNullable<OwnershipVerifier["processEnv"]>;
  },
): Promise<{ command: readonly string[] } | undefined> {
  const command = await verifier.command(pid);
  if (!command || !(await parentIsInit(pid, verifier))) return undefined;
  return hasProxyMarker(await verifier.processEnv(pid)) ? { command } : undefined;
}
function hasOrphanIdentityVerifiers(
  verifier: OwnershipVerifier,
): verifier is OwnershipVerifier &
  Required<Pick<OwnershipVerifier, "isAlive" | "command" | "parentPid" | "processEnv">> {
  return Boolean(verifier.isAlive && verifier.command && verifier.parentPid && verifier.processEnv);
}
function hasProxyMarker(env: Readonly<Record<string, string>> | undefined): boolean {
  return env?.KEY_FERRY_PROXY_MARKER === "key-ferry";
}
async function parentIsInit(pid: number, verifier: OwnershipVerifier): Promise<boolean> {
  return (await verifier.parentPid?.(pid)) === 1;
}
function orphanAgeElapsed(startedAt: string | undefined, now: number): boolean {
  if (!startedAt) return false;
  const started = Date.parse(startedAt);
  return Number.isFinite(started) && now - started >= ORPHAN_GRACE_MS;
}

function isProxyStartCommand(command: readonly string[]): boolean {
  const proxy = command.findIndex((part) => part === "proxy");
  const start =
    proxy < 0 ? -1 : command.findIndex((part, index) => index > proxy && part === "start");
  const cert = command.findIndex((part) => part === "--cert-dir");
  return validProxyCommandShape(command, proxy, start, cert) && validCertDir(command[cert + 1]!);
}
function validProxyCommandShape(
  command: readonly string[],
  proxy: number,
  start: number,
  cert: number,
): boolean {
  if (!hasProxyArguments(proxy, start, cert, command.length)) return false;
  const executable = basename(command[0] ?? "");
  return executable === "varlock" && command[proxy - 1] === executable;
}
function hasProxyArguments(proxy: number, start: number, cert: number, length: number): boolean {
  return proxy >= 1 && start >= 0 && cert >= 0 && cert + 1 < length;
}
function validCertDir(directory: string): boolean {
  return directory.startsWith(`${tmpdir()}/`) && basename(directory).startsWith("key-ferry-cert-");
}

// These are known PID-1 reapers commonly used by Linux hosts/containers.
// Anything else (including node, bun, and opencode) is not trusted as init.
const LINUX_INIT_NAMES = new Set([
  "systemd",
  "init",
  "tini",
  "dumb-init",
  "docker-init",
  "catatonit",
  "s6-svscan",
]);

async function isVerifiedInit(verifier: OwnershipVerifier): Promise<boolean> {
  if (!verifier.initCommand) return false;
  const command = await verifier.initCommand().catch(() => undefined);
  if (!command?.length) return false;
  const executable = basename(command[0]!);
  if (process.platform === "darwin") return executable === "launchd";
  return process.platform === "linux" && LINUX_INIT_NAMES.has(executable);
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
    const record = makeOrphanRecord(session, entry, ownerPid);
    if (await hostIdentityVetoesStop(record, verifier)) {
      result.skipped++;
      return;
    }
    await verifier.stop(record);
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
    (entry.proxyStartTime === undefined ||
      start === undefined ||
      startTimesMatch(start, entry.proxyStartTime))
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
    ...(entry?.hostPid === undefined ? {} : { hostPid: entry.hostPid }),
    ...(entry?.hostStartTime === undefined ? {} : { hostStartTime: entry.hostStartTime }),
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
  return startTimesMatch(actual, expected);
}

/**
 * A host identity is a hard veto immediately before every destructive stop.
 * Missing host evidence is fail-closed; a PID reuse mismatch is not considered
 * a live host.
 */
async function hostIdentityVetoesStop(
  record: BrokerOwnershipRecord,
  verifier: OwnershipVerifier,
): Promise<boolean> {
  if (record.hostPid === undefined) return false;
  if (!record.hostStartTime || !verifier.isAlive || !verifier.startTime) return true;
  return await hostIdentityMatches(record.hostPid, record.hostStartTime, verifier);
}
async function hostIdentityMatches(
  pid: number,
  expected: string,
  verifier: OwnershipVerifier,
): Promise<boolean> {
  const alive = await safeAlive(pid, verifier);
  if (!alive) return false;
  try {
    return startTimesMatch(await verifier.startTime!(pid), expected);
  } catch {
    return true;
  }
}
async function safeAlive(pid: number, verifier: OwnershipVerifier): Promise<boolean> {
  try {
    return await verifier.isAlive!(pid);
  } catch {
    return true;
  }
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
      if (await hostIdentityVetoesStop(record, verifier)) {
        skipped++;
        continue;
      }
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
  return !alive || !startTimesMatch(start, record.starterStartTime) || command === undefined;
}
async function reapActiveRecords(
  records: BrokerOwnershipRecord[],
  sessions: readonly {
    uuid: string;
    endedAt?: string;
    ownerPid?: number;
    cwd?: string;
    keyFerryMarker?: string;
    startedAt?: string;
    startTime?: string;
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
  sessions: readonly {
    uuid: string;
    endedAt?: string;
    ownerPid?: number;
    startedAt?: string;
    startTime?: string;
    keyFerryMarker?: string;
  }[],
  verifier: OwnershipVerifier,
  ops: OwnershipFileOps,
): Promise<{ reaped: number; skipped: number }> {
  const active = sessions.find((s) => s.uuid === record.sessionUuid && !s.endedAt);
  if (!active) {
    await removeInactiveRecord(record, verifier, ops);
    return { reaped: 1, skipped: 0 };
  }
  return reapActiveSession(record, active, verifier, ops);
}
async function reapActiveSession(
  record: BrokerOwnershipRecord,
  active: {
    ownerPid?: number;
    startedAt?: string;
    startTime?: string;
  },
  verifier: OwnershipVerifier,
  ops: OwnershipFileOps,
): Promise<{ reaped: number; skipped: number }> {
  const proxyPid = active.ownerPid ?? record.proxyPid ?? record.starterPid;
  const orphan = await maybeReapLegacyActive(record, active, proxyPid, verifier, ops);
  if (orphan) return orphan;
  if (await activeOwnerStillValid(record, active, proxyPid, verifier)) return skippedReap();
  return reapOwnedRecord(record, verifier, ops);
}
async function activeOwnerStillValid(
  record: BrokerOwnershipRecord,
  active: { ownerPid?: number; startedAt?: string; startTime?: string },
  proxyPid: number,
  verifier: OwnershipVerifier,
): Promise<boolean> {
  if (await starterStillOwned(record, verifier)) return true;
  return record.hostPid !== undefined && !(await verifiedOrphanProcess(active, proxyPid, verifier));
}
function skippedReap(): { reaped: number; skipped: number } {
  return { reaped: 0, skipped: 1 };
}
async function maybeReapLegacyActive(
  record: BrokerOwnershipRecord,
  active: { ownerPid?: number; startedAt?: string; startTime?: string },
  proxyPid: number,
  verifier: OwnershipVerifier,
  ops: OwnershipFileOps,
): Promise<{ reaped: number; skipped: number } | undefined> {
  if (!legacyRecord(record) || proxyPid !== record.starterPid) return undefined;
  return reapLegacyActive(record, active, verifier, ops);
}
async function reapLegacyActive(
  record: BrokerOwnershipRecord,
  active: { ownerPid?: number; startedAt?: string; startTime?: string },
  verifier: OwnershipVerifier,
  ops: OwnershipFileOps,
): Promise<{ reaped: number; skipped: number } | undefined> {
  const pid = active.ownerPid ?? record.proxyPid ?? record.starterPid;
  return (await verifiedOrphanProcess(active, pid, verifier))
    ? reapOwnedRecord(record, verifier, ops)
    : undefined;
}

function legacyRecord(record: BrokerOwnershipRecord): boolean {
  return record.hostPid === undefined;
}

async function removeInactiveRecord(
  record: BrokerOwnershipRecord,
  verifier: OwnershipVerifier,
  ops: OwnershipFileOps,
): Promise<void> {
  const proxyPid = record.proxyPid ?? (legacyRecord(record) ? record.starterPid : undefined);
  if (proxyPid !== undefined && (await inactiveProxyRemains(proxyPid, record, verifier))) return;
  await retireInactiveLedger(record, verifier, ops);
  await removeOwnershipRecord(record.brokerKeyHash, ops);
  lifecycleLoggers.forEach((l) =>
    l({ event: "stale-reaped", keyHash: record.brokerKeyHash.slice(0, 12), directory: record.cwd }),
  );
}
async function inactiveProxyRemains(
  pid: number,
  record: BrokerOwnershipRecord,
  verifier: OwnershipVerifier,
): Promise<boolean> {
  if (!(await proxyIsAlive(pid, record, verifier))) return false;
  if (await hostIdentityVetoesStop(record, verifier)) return true;
  if (!(await inactiveProxyVerified(pid, record, verifier))) return true;
  await verifier.stop(record);
  return await proxyIsAlive(pid, record, verifier);
}
async function inactiveProxyVerified(
  pid: number,
  record: BrokerOwnershipRecord,
  verifier: OwnershipVerifier,
): Promise<boolean> {
  if (!verifier.command) return false;
  const command = await verifier.command(pid);
  if (!command) return false;
  return verifiedOrphanProcess(
    { startedAt: record.created, startTime: record.proxyStartTime },
    pid,
    verifier,
  );
}

export async function proxyIsAlive(
  pid: number,
  record: BrokerOwnershipRecord,
  verifier: OwnershipVerifier,
): Promise<boolean> {
  if (!verifier.isAlive || !(await verifier.isAlive(pid))) return false;
  if (!record.proxyStartTime || !verifier.startTime) return true;
  return startTimesMatch(await verifier.startTime(pid), record.proxyStartTime);
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
    if (await hostIdentityVetoesStop(record, verifier)) return { reaped: 0, skipped: 1 };
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

async function readParentPid(pid: number): Promise<number | undefined> {
  return readParentPidUnsafe(pid).catch(() => undefined);
}
function readParentPidUnsafe(pid: number): Promise<number | undefined> {
  return process.platform === "linux" ? readLinuxParentPid(pid) : readPsParentPid(pid);
}
async function readLinuxParentPid(pid: number): Promise<number | undefined> {
  const stat = await readFile(`/proc/${pid}/stat`, "utf8");
  const end = stat.lastIndexOf(") ");
  const parent = Number(stat.slice(end + 2).split(" ")[1]);
  return Number.isSafeInteger(parent) ? parent : undefined;
}
async function readPsParentPid(pid: number): Promise<number | undefined> {
  const result = await exec("ps", ["-o", "ppid=", "-p", String(pid)], { timeout: 2_000 });
  const parent = Number(result.stdout.trim());
  return Number.isSafeInteger(parent) ? parent : undefined;
}

async function readProcessCommand(pid: number): Promise<readonly string[] | undefined> {
  try {
    const result = await exec("ps", ["-o", "command=", "-p", String(pid)], { timeout: 2_000 });
    return result.stdout.trim().split(/\s+/);
  } catch {
    return undefined;
  }
}

async function listLiveProcesses(): Promise<
  readonly { pid: number; command: readonly string[] }[] | undefined
> {
  try {
    const result = await exec("ps", ["-axo", "pid=,command="], { timeout: 2_000 });
    return result.stdout
      .split("\n")
      .map((line) => line.trim())
      .flatMap((line) => {
        const match = /^(\d+)\s+(.*)$/.exec(line);
        return match ? [{ pid: Number(match[1]), command: match[2]!.split(/\s+/) }] : [];
      });
  } catch {
    return undefined;
  }
}

function certDirectoryFromCommand(command: readonly string[]): string | undefined {
  const index = command.findIndex((part) => part === "--cert-dir");
  if (index < 0 || index + 1 >= command.length) return undefined;
  const value = command[index + 1]!;
  return basename(value).startsWith("key-ferry-cert-") ? value : undefined;
}

async function sweepCertDirectories(
  records: readonly BrokerOwnershipRecord[],
  sessions: readonly { env?: Readonly<Record<string, string>> }[],
  verifier: OwnershipVerifier,
  ops: OwnershipFileOps,
): Promise<void> {
  const candidates = await sweepCandidates(verifier, ops);
  if (!candidates) return;
  for (const candidate of candidates)
    await sweepCandidate(candidate.path, candidate.uid, records, sessions, verifier, ops);
}
async function sweepCandidates(
  verifier: OwnershipVerifier,
  ops: OwnershipFileOps,
): Promise<{ path: string; uid: number | undefined }[] | undefined> {
  if (!verifier.listProcesses) return undefined;
  const root = await sweepRoot(verifier);
  if (!root) return undefined;
  const names = await readCandidateNames(root, ops);
  if (!names) return undefined;
  const uid = currentUid();
  return names.map((name) => ({ path: join(root, name), uid }));
}
async function sweepRoot(verifier: OwnershipVerifier): Promise<string | undefined> {
  return canonicalPath(verifier.tempDirectory ?? tmpdir());
}
function currentUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}
async function readCandidateNames(
  root: string,
  ops: OwnershipFileOps,
): Promise<string[] | undefined> {
  try {
    return (await (ops.readdir ?? readdir)(root)).filter((name) =>
      name.startsWith("key-ferry-cert-"),
    );
  } catch {
    return undefined;
  }
}
async function sweepCandidate(
  path: string,
  uid: number | undefined,
  records: readonly BrokerOwnershipRecord[],
  sessions: readonly { env?: Readonly<Record<string, string>> }[],
  verifier: OwnershipVerifier,
  ops: OwnershipFileOps,
): Promise<void> {
  try {
    if (await shouldSweepCandidate(path, uid, records, sessions, verifier, ops))
      await ops.rm(path, { recursive: true, force: true });
  } catch {
    /* Best effort; never make reaping fail. */
  }
}
async function shouldSweepCandidate(
  path: string,
  uid: number | undefined,
  records: readonly BrokerOwnershipRecord[],
  sessions: readonly { env?: Readonly<Record<string, string>> }[],
  verifier: OwnershipVerifier,
  ops: OwnershipFileOps,
): Promise<boolean> {
  if (!(await ownedOldDirectory(path, uid, verifier, ops))) return false;
  const candidate = await canonicalPath(path);
  if (!candidate || candidate !== path) return false;
  if (await referencedCandidate(candidate, records, sessions, verifier)) return false;
  return ownedOldDirectory(path, uid, verifier, ops);
}
async function removeIfStillOwned(
  path: string,
  uid: number | undefined,
  verifier: OwnershipVerifier,
  ops: OwnershipFileOps,
): Promise<void> {
  if (await ownedOldDirectory(path, uid, verifier, ops))
    await ops.rm(path, { recursive: true, force: true });
}
async function ownedOldDirectory(
  path: string,
  uid: number | undefined,
  verifier: OwnershipVerifier,
  ops: OwnershipFileOps,
): Promise<boolean> {
  const info = await (ops.lstat ?? lstat)(path);
  return validOwnedDirectory(info, uid) && oldEnough(info.mtimeMs, verifier);
}
function validOwnedDirectory(info: any, uid: number | undefined): boolean {
  return !info.isSymbolicLink() && info.isDirectory() && (uid === undefined || info.uid === uid);
}
function oldEnough(mtimeMs: number, verifier: OwnershipVerifier): boolean {
  return (verifier.now?.() ?? Date.now()) - mtimeMs >= ORPHAN_GRACE_MS;
}
async function referencedCandidate(
  candidate: string,
  records: readonly BrokerOwnershipRecord[],
  sessions: readonly { env?: Readonly<Record<string, string>> }[],
  verifier: OwnershipVerifier,
): Promise<boolean> {
  const processes = await verifier.listProcesses!();
  if (!processes) return true;
  const referenced = await referencedCertDirectories(records, sessions, processes);
  return referenced.has(candidate);
}

async function canonicalPath(path: string): Promise<string | undefined> {
  try {
    return await realpath(resolve(path));
  } catch {
    return resolve(path).replace(/^\/var(?=\/)/, "/private/var");
  }
}

async function referencedCertDirectories(
  records: readonly BrokerOwnershipRecord[],
  sessions: readonly { env?: Readonly<Record<string, string>> }[],
  processes: readonly { command: readonly string[] }[],
): Promise<Set<string>> {
  const values = [
    ...processes.flatMap((process) => certDirectoryFromCommand(process.command) ?? []),
    ...records.flatMap((record) => (record.certDirectory ? [record.certDirectory] : [])),
    ...sessions.flatMap((session) => sessionCertDirectory(session.env)),
  ];
  const result = new Set<string>();
  for (const value of values) {
    const canonical = await canonicalPath(value);
    if (canonical) result.add(canonical);
  }
  return result;
}
function sessionCertDirectory(env?: Readonly<Record<string, string>>): string[] {
  const value = env?.NODE_EXTRA_CA_CERTS?.replace(/\/ca-cert\.pem$/, "");
  return value ? [value] : [];
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
        return canonicalStartTime(result.stdout.trim());
      } catch {
        return undefined;
      }
    },
    processEnv: (pid) => readProcessEnvironment(pid),
    parentPid: (pid) => readParentPid(pid),
    initCommand: () => readProcessCommand(1),
    listProcesses: () => listLiveProcesses(),
    tempDirectory: tmpdir(),
    command: (pid) => readProcessCommand(pid),
  };
  return reapOwnershipRecords(verifier, ops)
    .then(() => undefined)
    .catch(() => undefined);
}

export async function starterStillOwned(
  record: BrokerOwnershipRecord,
  verifier: OwnershipVerifier,
): Promise<boolean> {
  return record.hostPid !== undefined
    ? hostStillOwned(record, verifier)
    : legacyStarterStillOwned(record, verifier);
}
async function hostStillOwned(
  record: BrokerOwnershipRecord,
  verifier: OwnershipVerifier,
): Promise<boolean> {
  if (!record.hostStartTime || !verifier.isAlive || !verifier.startTime) return false;
  if (!(await verifier.isAlive(record.hostPid!))) return false;
  return startTimesMatch(await verifier.startTime!(record.hostPid!), record.hostStartTime);
}
async function legacyStarterStillOwned(
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
    startTimesMatch(start, expectedStart),
    command,
    executableMatches,
    JSON.stringify(startPrefix) === JSON.stringify(["proxy", "start"]),
  ].every(Boolean);
}
