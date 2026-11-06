import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, rm, lstat, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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
}

export interface OwnershipFileOps {
  readonly mkdir: typeof mkdir;
  readonly readFile: typeof readFile;
  readonly readdir: typeof readdir;
  readonly rm: typeof rm;
  readonly lstat?: typeof lstat;
  readonly rename?: typeof rename;
  readonly writeFile: typeof writeFile;
  /** Test seam; production uses the per-user temporary directory. */
  readonly directory?: string;
}
const files: OwnershipFileOps = {
  mkdir,
  readFile,
  readdir,
  rm,
  lstat,
  rename,
  writeFile,
};
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
  return records;
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
  /** The configured executable/prefix used to launch proxy start. */
  readonly expectedCommand?: readonly string[];
  readonly status?: () => Promise<readonly { readonly uuid: string; readonly endedAt?: string }[]>;
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
  const operation = reapOwnershipRecordsOnce(verifier, ops);
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
  let sessions: readonly { uuid: string; endedAt?: string }[];
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
  return reapActiveRecords(records, sessions, verifier, ops);
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
  sessions: readonly { uuid: string; endedAt?: string }[],
  verifier: OwnershipVerifier,
  ops: OwnershipFileOps,
) {
  let reaped = 0,
    skipped = 0;
  for (const record of records) {
    if (!sessions.some((s) => s.uuid === record.sessionUuid && !s.endedAt)) {
      await removeOwnershipRecord(record.brokerKeyHash, ops);
      lifecycleLoggers.forEach((l) =>
        l({
          event: "stale-reaped",
          keyHash: record.brokerKeyHash.slice(0, 12),
          directory: record.cwd,
        }),
      );
      reaped++;
      continue;
    }
    try {
      await verifier.stop(record);
      await removeOwnershipRecord(record.brokerKeyHash, ops);
      lifecycleLoggers.forEach((l) =>
        l({
          event: "stale-reaped",
          keyHash: record.brokerKeyHash.slice(0, 12),
          directory: record.cwd,
        }),
      );
      reaped++;
    } catch {
      skipped++;
    }
  }
  return { reaped, skipped };
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
      const parsed = JSON.parse(result.stdout);
      return Array.isArray(parsed) ? parsed : (parsed.sessions ?? []);
    },
    stop: async (record) => {
      await exec(executable, ["proxy", "stop", "--session", record.sessionUuid], {
        timeout: 2_000,
      });
      if (await starterStillOwned(record, verifier)) terminateStarter(record.starterPid);
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
  const byDirectory = inFlightByOps.get(ops as object) ?? new Map();
  inFlightByOps.set(ops as object, byDirectory);
  const existing = byDirectory.get(directory);
  if (existing) return existing.then(() => undefined).catch(() => undefined);
  const pass = reapOwnershipRecords(verifier, ops)
    .then(() => undefined)
    .catch(() => undefined);
  byDirectory.set(
    directory,
    pass.then(() => ({ reaped: 0, skipped: 0 })),
  );
  return pass;
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

function terminateStarter(pid: number): void {
  try {
    process.kill(pid, "SIGTERM");
  } catch {}
}
