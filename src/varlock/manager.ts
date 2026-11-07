import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, mkdtemp, realpath, rm, stat, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { Duration, Effect, Layer, Scope, Semaphore } from "effect";
import {
  ProjectKeyFerryManager,
  type ProjectKeyFerryManagerFactory,
  type ProjectKeyFerryManagerOptions,
  type ProjectKeyFerryManagerService,
  type ResolvedEnvironment,
  type SafeStatus,
  VarlockError,
} from "../contracts.js";
import {
  Process,
  ProcessLive,
  type ManagedProcess,
  type ProcessError,
  type ProcessService,
} from "../services/process.js";
import { classifyStderr } from "./diagnostics.js";
import {
  removeOwnershipRecord,
  appendProxyLedgerEntry,
  reapStaleOwnershipRecords,
  writeOwnershipRecord,
  ownershipFileOps,
  ownershipDirectory,
} from "./ownership.js";
import {
  decodeSessionList,
  findOwnedSession,
  sanitizeSessionStatus,
  selectPlaceholderEnvironment,
  validateProxyWiring,
  type VarlockSessionRecord,
} from "./protocol.js";

const DEFAULT_COMMAND = ["varlock"] as const;
const DEFAULT_START_TIMEOUT = 30_000;
const DEFAULT_COMMAND_TIMEOUT = 10_000;
const DEFAULT_REFRESH_TIMEOUT = 30_000;
const DEFAULT_POLL_INTERVAL = 100;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_TIMEOUT = 10 * 60_000;
const DEFAULT_HEALTH_CHECK_INTERVAL = 1_000;

type AdapterOptions = {
  command: readonly string[];
  environmentKeys: readonly string[];
  startupTimeoutMs: number;
  commandTimeoutMs: number;
  reloadTimeoutMs: number;
  pollIntervalMs: number;
  requireStrictEgress: boolean;
  lifecycleLogger?: (event: {
    readonly event: "stop-failed";
    readonly proxySessionId?: string;
  }) => void;
  ownershipDirectory?: string;
  healthCheckIntervalMs: number;
};

type ManagerFileOps = {
  mkdtemp: typeof mkdtemp;
  realpath: typeof realpath;
  rm: typeof rm;
};

const defaultFileOps: ManagerFileOps = { mkdtemp, realpath, rm };

type ManagerState = {
  phase: SafeStatus["phase"];
  generation: number;
  process?: ManagedProcess;
  session?: VarlockSessionRecord;
  environment?: ResolvedEnvironment;
  lastRefreshAt?: string;
  error?: VarlockError;
  disposed: boolean;
};

const safeError = (
  code: ConstructorParameters<typeof VarlockError>[0]["code"],
  retryable: boolean,
): VarlockError =>
  new VarlockError({
    code,
    retryable,
    message:
      code === "ownership_unavailable"
        ? "Key Ferry ownership directory is unavailable"
        : `Varlock ${code.replaceAll("_", " ")}`,
  });

const fromProcessError = (
  error: ProcessError,
  code: "start_failed" | "refresh_failed" | "unavailable" | "timeout",
): VarlockError =>
  new VarlockError({
    code,
    retryable: error.code === "timeout" || error.code === "spawn-failed" || error.code === "io",
    message:
      error.code === "timeout" ? "Varlock command timed out" : `Varlock command ${error.code}`,
    ...(error.stderr
      ? {
          stderrTail: classifyStderr(error.stderr).message,
          stderrCode: classifyStderr(error.stderr).code,
        }
      : {}),
  });

function adapterOptions(options: ProjectKeyFerryManagerOptions): AdapterOptions {
  const raw = options.adapter ?? {};
  const command = raw.command === undefined ? [...DEFAULT_COMMAND] : raw.command;
  const environmentKeys = raw.environmentKeys;
  const [validCommand, validEnvironmentKeys] = validateAdapterArrays(command, environmentKeys);
  const ownershipDirectory = raw.ownershipDirectory;
  validateOwnershipDirectory(ownershipDirectory);
  return {
    command: [...validCommand],
    environmentKeys: [...validEnvironmentKeys],
    startupTimeoutMs: adapterNumber(
      raw,
      "startupTimeoutMs",
      DEFAULT_START_TIMEOUT,
      100,
      MAX_TIMEOUT,
    ),
    commandTimeoutMs: adapterNumber(
      raw,
      "commandTimeoutMs",
      DEFAULT_COMMAND_TIMEOUT,
      100,
      MAX_TIMEOUT,
    ),
    reloadTimeoutMs: adapterNumber(
      raw,
      "reloadTimeoutMs",
      DEFAULT_REFRESH_TIMEOUT,
      100,
      MAX_TIMEOUT,
    ),
    pollIntervalMs: adapterNumber(raw, "pollIntervalMs", DEFAULT_POLL_INTERVAL, 10, 10_000),
    requireStrictEgress: readStrictEgress(raw.requireStrictEgress),
    ...(ownershipDirectory === undefined ? {} : { ownershipDirectory }),
    healthCheckIntervalMs: adapterNumber(
      raw,
      "healthCheckIntervalMs",
      DEFAULT_HEALTH_CHECK_INTERVAL,
      100,
      MAX_TIMEOUT,
    ),
    ...readLifecycleLogger(raw),
  };
}

function validateAdapterArrays(command: unknown, environmentKeys: unknown): [string[], string[]] {
  if (!validCommandArray(command) || !validEnvironmentKeyArray(environmentKeys))
    throw safeError("invalid_config", false);
  return [command, environmentKeys];
}

function validateOwnershipDirectory(value: unknown): asserts value is string | undefined {
  if (value !== undefined && (typeof value !== "string" || value.length === 0))
    throw safeError("invalid_config", false);
}

function adapterNumber(
  raw: Record<string, unknown>,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = raw[name];
  if (value === undefined) return fallback;
  if (!validAdapterNumber(value, min, max)) throw safeError("invalid_config", false);
  return value;
}
function validAdapterNumber(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}

function readLifecycleLogger(
  raw: Record<string, unknown>,
): Pick<AdapterOptions, "lifecycleLogger"> {
  return typeof raw.lifecycleLogger === "function"
    ? {
        lifecycleLogger: raw.lifecycleLogger as AdapterOptions["lifecycleLogger"],
      }
    : {};
}

function validCommandArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 32 &&
    value.every(
      (v) => typeof v === "string" && v.length > 0 && v.length <= 1024 && !v.includes("\0"),
    )
  );
}

function validEnvironmentKeyArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= 128 &&
    value.every(
      (v) => typeof v === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(v) && v.length <= 256,
    )
  );
}

function readStrictEgress(value: unknown): boolean {
  if (value !== undefined && typeof value !== "boolean") throw safeError("invalid_config", false);
  return value ?? true;
}

function safeProjectDirectory(value: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 16_384 ||
    value.includes("\0")
  )
    throw safeError("invalid_config", false);
  return value;
}

function parseEnvironmentOutput(raw: string): Readonly<Record<string, string>> {
  if (Buffer.byteLength(raw, "utf8") > MAX_OUTPUT_BYTES) throw safeError("protocol_error", false);
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw safeError("protocol_error", false);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw safeError("protocol_error", false);
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  const keys = Object.keys(value as object);
  if (keys.length > 512) throw safeError("protocol_error", false);
  for (const key of keys) {
    if (
      key === "__proto__" ||
      key === "prototype" ||
      key === "constructor" ||
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ||
      key.length > 256
    )
      throw safeError("protocol_error", false);
    const item = (value as Record<string, unknown>)[key];
    if (typeof item !== "string" || item.length > 16_384 || item.includes("\0"))
      throw safeError("protocol_error", false);
    result[key] = item;
  }
  return result;
}

function statusSnapshot(state: ManagerState, projectDirectory: string): SafeStatus {
  return {
    phase: state.phase,
    projectDirectory: projectDirectory as SafeStatus["projectDirectory"],
    generation: state.generation,
    ...statusOptionalFields(state),
  };
}

function statusOptionalFields(state: ManagerState): Partial<SafeStatus> {
  return {
    ...(state.process ? { pid: state.process.pid } : {}),
    ...(state.session ? { sessionId: state.session.uuid, proxySessionId: state.session.uuid } : {}),
    ...statusEndpointField(state),
    ...(state.lastRefreshAt ? { lastRefreshAt: state.lastRefreshAt } : {}),
    ...(state.error ? { error: state.error } : {}),
  };
}

function statusEndpointField(state: ManagerState): Partial<SafeStatus> {
  if (!state.session) return {};
  try {
    return { endpoint: validateProxyWiring(state.session.env).proxyUrl };
  } catch {
    return {};
  }
}

function commandParts(options: AdapterOptions, args: readonly string[]) {
  return {
    executable: options.command[0]!,
    args: [...options.command.slice(1), ...args],
  };
}

function runCommand(
  process: ProcessService,
  options: AdapterOptions,
  cwd: string,
  args: readonly string[],
  timeoutMs: number,
  environment: Readonly<Record<string, string>>,
): Effect.Effect<{ stdout: string; stderr: string }, VarlockError> {
  const parts = commandParts(options, args);
  return process
    .run({
      ...parts,
      cwd,
      env: environment,
      maxBytes: MAX_OUTPUT_BYTES,
      timeoutMs,
    })
    .pipe(
      Effect.mapError((error) =>
        fromProcessError(error, error.code === "timeout" ? "timeout" : "unavailable"),
      ),
      Effect.map(({ stdout, stderr }) => ({ stdout, stderr })),
    );
}

function candidatesForOwner(
  records: readonly VarlockSessionRecord[],
  pid: number,
  cwd: string,
): readonly VarlockSessionRecord[] {
  return records.filter(
    (record) => record.ownerPid === pid && record.cwd === cwd && record.endedAt === undefined,
  );
}

type RefreshReadiness = {
  state: ManagerState;
  healthCheck: () => Effect.Effect<void, VarlockError>;
  start: () => Effect.Effect<SafeStatus, VarlockError>;
};

function requireRefreshProcess(state: ManagerState): Effect.Effect<void, VarlockError> {
  if (!state.process || !state.session) return Effect.fail(safeError("not_ready", true));
  return Effect.void;
}

function prepareStart(
  state: ManagerState,
  healthCheck: (force?: boolean) => Effect.Effect<void, VarlockError>,
  snapshot: () => SafeStatus,
): Effect.Effect<SafeStatus | undefined, VarlockError> {
  if (state.disposed) return Effect.fail(safeError("disposed", false));
  if (!state.process || !state.session) return Effect.succeed(undefined);
  return healthCheck(true).pipe(Effect.flatMap(() => prepareExistingStart(state, snapshot)));
}

function prepareExistingStart(
  state: ManagerState,
  snapshot: () => SafeStatus,
): Effect.Effect<SafeStatus | undefined, VarlockError> {
  if (!state.process || !state.session) return Effect.succeed(undefined);
  if (state.phase === "ready") return Effect.succeed(snapshot());
  return Effect.fail(startFailure(state.error));
}
function startFailure(error: VarlockError | undefined): VarlockError {
  return error ?? safeError("not_ready", true);
}

function requireRefreshSession(
  state: ManagerState,
): Effect.Effect<VarlockSessionRecord, VarlockError> {
  if (!state.process || !state.session) return Effect.fail(safeError("not_ready", true));
  return Effect.succeed(state.session);
}

function ensureRefreshReadiness({
  state,
  healthCheck,
  start,
}: RefreshReadiness): Effect.Effect<void, VarlockError> {
  return Effect.gen(function* () {
    if (state.disposed) return yield* Effect.fail(safeError("disposed", false));
    yield* healthCheck();
    if (!state.process || !state.session || state.phase !== "ready") yield* start();
    yield* requireRefreshProcess(state);
  });
}

function completeRefreshHandshake(
  reload: Effect.Effect<unknown, VarlockError>,
  readStatus: Effect.Effect<readonly VarlockSessionRecord[], VarlockError>,
  session: VarlockSessionRecord,
  ownerPid: number,
  projectDirectory: string,
  readEnvironment: (
    session: VarlockSessionRecord,
  ) => Effect.Effect<ResolvedEnvironment, VarlockError>,
): Effect.Effect<
  { session: VarlockSessionRecord; environment: ResolvedEnvironment },
  VarlockError
> {
  return Effect.gen(function* () {
    yield* reload;
    const records = yield* readStatus;
    const next = findOwnedSession(records, {
      ownerPid,
      sessionUuid: session.uuid,
      projectDirectory,
    });
    if (!next) return yield* Effect.fail(safeError("refresh_failed", true));
    const environment = yield* readEnvironment(next).pipe(
      Effect.mapError(() => safeError("refresh_failed", true)),
    );
    return { session: next, environment };
  });
}

function validateRefreshCapability(
  state: ManagerState,
  session: VarlockSessionRecord,
  requireStrictEgress: boolean,
  healthCheck: () => Effect.Effect<void, VarlockError>,
  clearCapability: (phase: SafeStatus["phase"], error?: VarlockError) => void,
): Effect.Effect<void, VarlockError> {
  return Effect.gen(function* () {
    yield* healthCheck();
    if (!state.process || state.phase !== "ready")
      return yield* Effect.fail(safeError("refresh_failed", true));
    if (requireStrictEgress && session.egressMode !== "strict") {
      const error = safeError("refresh_failed", false);
      clearCapability("failed", error);
      return yield* Effect.fail(error);
    }
  });
}

function validateStartupEgress(
  state: ManagerState,
  requireStrictEgress: boolean,
  session: VarlockSessionRecord,
  _handle: ManagedProcess,
): Effect.Effect<void, VarlockError> {
  if (!requireStrictEgress || session.egressMode === "strict") return Effect.void;
  return Effect.fail(safeError("invalid_config", false));
}

function assertRegularCertificate(pathInfo: Awaited<ReturnType<typeof lstat>>): void {
  if (!pathInfo.isFile() || pathInfo.isSymbolicLink()) throw new Error("not a regular certificate");
}

function assertContainedCertificate(certDirectoryReal: string, resolved: string): void {
  const outside = relative(certDirectoryReal, resolved);
  if (outside === ".." || outside.startsWith("../") || outside.includes("\0"))
    throw new Error("certificate outside owned directory");
}

function assertOwnedCertificate(cert: Awaited<ReturnType<typeof stat>>): void {
  if (
    !cert.isFile() ||
    cert.uid !== globalThis.process.getuid?.() ||
    (Number(cert.mode) & 0o022) !== 0
  )
    throw new Error("certificate ownership or permissions invalid");
}

function healthCheckDue(force: boolean, lastHealthCheckAt: number, intervalMs: number): boolean {
  return force || Date.now() - lastHealthCheckAt >= intervalMs;
}

function rejectUnavailableEnvironment(state: ManagerState): Effect.Effect<void, VarlockError> {
  if (state.phase === "failed" || state.phase === "degraded")
    return Effect.fail(safeError("not_ready", true));
  return Effect.void;
}

export function makeProjectKeyFerryManager(
  options: ProjectKeyFerryManagerOptions,
  processLayer: Layer.Layer<Process, never, never> = ProcessLive,
  fileOps: ManagerFileOps = defaultFileOps,
): Layer.Layer<ProjectKeyFerryManager, VarlockError, never> {
  return Layer.effect(
    ProjectKeyFerryManager,
    Effect.gen(function* () {
      const processService = yield* Process;
      // Process.spawn is scoped. Capture the layer scope once and provide it
      // to lazy starts so a handle remains alive until this manager layer is
      // released, rather than being released at the end of ensureStarted.
      const managerScope = yield* Scope.Scope;
      const config = adapterOptions(options);
      // Stale cleanup is bounded, idempotent, and never gates MCP startup.
      yield* Effect.promise(() =>
        reapStaleOwnershipRecords(
          config.command,
          ownershipFileOps(config.ownershipDirectory ?? ownershipDirectory()),
        ),
      ).pipe(Effect.forkDetach, Effect.asVoid);
      const requestedCwd = safeProjectDirectory(options.projectDirectory);
      const cwd = yield* Effect.tryPromise({
        try: async () => {
          const canonical = await realpath(requestedCwd);
          const info = await stat(canonical);
          if (!info.isDirectory()) throw new Error("project path is not a directory");
          await access(canonical, fsConstants.R_OK | fsConstants.X_OK);
          return canonical;
        },
        catch: () => safeError("invalid_config", false),
      });
      // The sidecar gets a stable snapshot, rather than inheriting a mutable
      // host environment at each command. This is intentionally only for the
      // trusted Varlock CLI boundary and is never copied into MCP config or
      // returned by the manager.
      const ambientEnvironment = Object.fromEntries(
        Object.entries(globalThis.process.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      );
      let certDirectory: string | undefined;
      let certDirectoryReal: string | undefined;
      const ownedCertDirectories = new Set<string>();
      const lock = yield* Semaphore.make(1);
      const state: ManagerState = {
        phase: "stopped",
        generation: 0,
        disposed: false,
      };
      let ownershipHash = createHash("sha256").update(cwd).digest("hex");
      const processStartTime = (pid: number, swallow = false) =>
        processService.startTime
          ? Effect.runPromise(processService.startTime(pid)).catch((error) => {
              if (swallow) return undefined;
              throw error;
            })
          : Promise.resolve(undefined);
      const ownershipRecord = (
        session: VarlockSessionRecord,
        pid: number,
        _command: readonly string[],
      ) =>
        Effect.tryPromise({
          try: async () => {
            const starterStartTime = await processStartTime(pid);
            await writeOwnershipRecord(
              {
                brokerKeyHash: (ownershipHash = createHash("sha256")
                  .update(`${cwd}\0${session.uuid}`)
                  .digest("hex")),
                version: 2,
                sessionUuid: session.uuid,
                starterPid: pid,
                ...(starterStartTime ? { starterStartTime } : {}),
                cwd,
                created: new Date().toISOString(),
              },
              ownershipFileOps(config.ownershipDirectory ?? ownershipDirectory()),
            );
            const proxyStartTime = await processStartTime(session.ownerPid, true);
            await appendProxyLedgerEntry(
              {
                version: 1,
                sessionUuid: session.uuid,
                proxyPid: session.ownerPid,
                ...(proxyStartTime ? { proxyStartTime } : {}),
                ownerPid: pid,
                ...(starterStartTime ? { ownerStartTime: starterStartTime } : {}),
                cwd,
                created: new Date().toISOString(),
              },
              ownershipFileOps(config.ownershipDirectory ?? ownershipDirectory()),
            );
          },
          catch: () => safeError("ownership_unavailable", false),
        });

      const clearCapability = (phase: SafeStatus["phase"], error?: VarlockError) => {
        state.phase = phase;
        state.environment = undefined;
        state.error = error;
        state.generation += 1;
      };

      let lastHealthCheckAt = 0;
      let healthCheckInFlight: Effect.Effect<void> | undefined;
      const healthCheck = (force = false): Effect.Effect<void> => {
        if (!state.process || !state.session) return Effect.void;
        if (healthCheckInFlight) return healthCheckInFlight;
        if (!healthCheckDue(force, lastHealthCheckAt, config.healthCheckIntervalMs))
          return Effect.void;
        lastHealthCheckAt = Date.now();
        const old = state.session;
        const oldHandle = state.process;
        const check = runCommand(
          processService,
          config,
          cwd,
          ["proxy", "status", "--format", "json"],
          config.commandTimeoutMs,
          ambientEnvironment,
        ).pipe(
          // A failed status query is unknown, not evidence that the proxy died.
          Effect.flatMap(({ stdout }) =>
            Effect.try({
              try: () => decodeSessionList(stdout),
              catch: () => undefined as readonly VarlockSessionRecord[] | undefined,
            }),
          ),
          Effect.flatMap((records) => {
            if (!records) return Effect.void;
            return oldHandle.health.pipe(
              Effect.flatMap((health) => {
                const failedStarter =
                  !health.running &&
                  health.exit !== undefined &&
                  (health.exit.code !== 0 || health.exit.signal !== null);
                const active = records.some(
                  (item) => item.uuid === old.uuid && item.endedAt === undefined,
                );
                if (active && !failedStarter) return Effect.void;
                return stopCapturedSession(old).pipe(
                  Effect.tap((stopped) =>
                    oldHandle.stop.pipe(Effect.catch(() => Effect.void)).pipe(
                      Effect.andThen(
                        Effect.sync(() => {
                          if (stopped) {
                            state.process = undefined;
                            clearCapability("degraded", safeError("unavailable", true));
                          } else {
                            state.phase = "degraded";
                            state.error = safeError("unavailable", true);
                          }
                        }),
                      ),
                    ),
                  ),
                  Effect.asVoid,
                );
              }),
            );
          }),
          Effect.catch(() => Effect.void),
        );
        healthCheckInFlight = check.pipe(
          Effect.ensuring(Effect.sync(() => (healthCheckInFlight = undefined))),
        );
        return healthCheckInFlight;
      };

      const status: Effect.Effect<SafeStatus> = Effect.suspend(() => healthCheck()).pipe(
        Effect.asVoid,
        Effect.map(() => statusSnapshot(state, cwd)),
      );

      // `proxy start` is a daemon command: the CLI process we spawn may hand
      // the listener to a longer-lived session process. Always use Varlock's
      // session protocol first, then reap our owned process group as a bounded
      // fallback. The command is deliberately best-effort during teardown.
      const stopProxy = (session: VarlockSessionRecord | undefined) =>
        session
          ? runCommand(
              processService,
              config,
              cwd,
              ["proxy", "stop", "--session", session.uuid],
              config.commandTimeoutMs,
              ambientEnvironment,
            ).pipe(
              Effect.flatMap(() => {
                const verify = (attempt: number): Effect.Effect<boolean, never> =>
                  runCommand(
                    processService,
                    config,
                    cwd,
                    ["proxy", "status", "--format", "json"],
                    config.commandTimeoutMs,
                    ambientEnvironment,
                  ).pipe(
                    Effect.flatMap(({ stdout }) => {
                      try {
                        if (
                          !decodeSessionList(stdout).some(
                            (item) => item.uuid === session.uuid && item.endedAt === undefined,
                          )
                        )
                          return Effect.succeed(true);
                      } catch {
                        // A malformed/failed status is inconclusive.
                      }
                      return attempt < 3
                        ? Effect.sleep(Duration.millis(config.pollIntervalMs)).pipe(
                            Effect.andThen(verify(attempt + 1)),
                          )
                        : Effect.succeed(false);
                    }),
                    Effect.catch(() => Effect.succeed(false)),
                  );
                return verify(1);
              }),
              Effect.catch(() =>
                Effect.sync(() => {
                  config.lifecycleLogger?.({
                    event: "stop-failed",
                    proxySessionId: session.uuid,
                  });
                  return false;
                }),
              ),
            )
          : Effect.succeed(true);

      const stopCapturedSession = (session = state.session) =>
        stopProxy(session).pipe(
          Effect.tap((stopped) =>
            stopped
              ? Effect.tryPromise({
                  try: () =>
                    removeOwnershipRecord(
                      ownershipHash,
                      ownershipFileOps(config.ownershipDirectory ?? ownershipDirectory()),
                    ),
                  catch: () => undefined,
                }).pipe(
                  Effect.catch(() => Effect.void),
                  Effect.andThen(
                    Effect.sync(() => {
                      if (state.session?.uuid === session?.uuid) state.session = undefined;
                    }),
                  ),
                )
              : Effect.void,
          ),
        );

      const cleanupUncapturedSessions = (handle: ManagedProcess) =>
        runCommand(
          processService,
          config,
          cwd,
          ["proxy", "status", "--format", "json"],
          config.commandTimeoutMs,
          ambientEnvironment,
        ).pipe(
          Effect.flatMap(({ stdout }) =>
            Effect.try({
              try: () => decodeSessionList(stdout),
              catch: () => [] as readonly VarlockSessionRecord[],
            }),
          ),
          Effect.flatMap((records) =>
            Effect.forEach(
              records.filter((record) => record.ownerPid === handle.pid && record.cwd === cwd),
              (record) => stopProxy(record),
              { discard: true },
            ),
          ),
          Effect.catch(() => Effect.void),
        );

      const waitForSession = (
        handle: ManagedProcess,
      ): Effect.Effect<VarlockSessionRecord, VarlockError> => {
        const deadline = Date.now() + config.startupTimeoutMs;
        const poll = (): Effect.Effect<VarlockSessionRecord, VarlockError> =>
          Effect.gen(function* () {
            const output = yield* runCommand(
              processService,
              config,
              cwd,
              ["proxy", "status", "--format", "json"],
              config.commandTimeoutMs,
              ambientEnvironment,
            );
            const records = yield* Effect.try({
              try: () => decodeSessionList(output.stdout),
              catch: () => safeError("protocol_error", false),
            });
            const candidates = candidatesForOwner(records, handle.pid, cwd);
            if (candidates.length === 1) {
              const candidate = candidates[0]!;
              const owned = findOwnedSession(records, {
                ownerPid: handle.pid,
                sessionUuid: candidate.uuid,
                projectDirectory: cwd,
              });
              if (owned) return owned;
            }
            if (Date.now() >= deadline) return yield* Effect.fail(safeError("timeout", true));
            yield* Effect.sleep(Duration.millis(config.pollIntervalMs));
            return yield* poll();
          });
        return poll();
      };

      const readEnvironment = (
        session: VarlockSessionRecord,
      ): Effect.Effect<ResolvedEnvironment, VarlockError> =>
        runCommand(
          processService,
          config,
          cwd,
          ["proxy", "env", "--session", session.uuid, "--full", "--format", "json"],
          config.commandTimeoutMs,
          ambientEnvironment,
        ).pipe(
          Effect.flatMap(({ stdout }) =>
            Effect.gen(function* () {
              const decoded = yield* Effect.try({
                try: () => {
                  const full = parseEnvironmentOutput(stdout);
                  const wiring = validateProxyWiring(full);
                  const selected = selectPlaceholderEnvironment(
                    full,
                    session,
                    config.environmentKeys,
                  );
                  return { wiring, selected };
                },
                catch: () => safeError("protocol_error", false),
              });
              yield* Effect.tryPromise({
                try: async () => {
                  const original = await lstat(decoded.wiring.caPath);
                  assertRegularCertificate(original);
                  const resolved = await realpath(decoded.wiring.caPath);
                  const cert = await stat(resolved);
                  assertContainedCertificate(certDirectoryReal!, resolved);
                  // Varlock's CA certificate is public trust material and is
                  // currently written 0644. Reject group/other *writes*, but
                  // allow readable public certs. The directory remains
                  // manager-owned and private; private keys are never
                  // accepted through this path.
                  assertOwnedCertificate(cert);
                },
                catch: () => safeError("protocol_error", false),
              });
              return { ...decoded.wiring.env, ...decoded.selected };
            }),
          ),
        );

      const removeOwnedDirectory = (directory: string) =>
        Effect.tryPromise({
          try: () => fileOps.rm(directory, { recursive: true, force: true }),
          catch: () => safeError("start_failed", true),
        }).pipe(
          Effect.tap(() => Effect.sync(() => ownedCertDirectories.delete(directory))),
          Effect.catch(() => Effect.void),
        );

      const acquireCertDirectory = (onOwned: (directory: string) => void) =>
        Effect.uninterruptibleMask(() =>
          Effect.gen(function* () {
            const directory = yield* Effect.tryPromise({
              try: () => fileOps.mkdtemp(join(tmpdir(), "key-ferry-cert-")),
              catch: () => safeError("start_failed", true),
            });
            // The promise above cannot be cancelled. Register ownership before
            // any interruptible work so a late filesystem completion is never
            // forgotten by the manager's finalizer.
            ownedCertDirectories.add(directory);
            onOwned(directory);
            const canonical = yield* Effect.tryPromise({
              try: () => fileOps.realpath(directory),
              catch: () => safeError("start_failed", true),
            }).pipe(
              Effect.catch((error) =>
                removeOwnedDirectory(directory).pipe(Effect.andThen(Effect.fail(error))),
              ),
            );
            return { directory, canonical };
          }),
        );

      const interruptedStartCleanup = (handle?: ManagedProcess, directory?: string) =>
        Effect.uninterruptible(
          Effect.gen(function* () {
            yield* stopCapturedSession();
            if (handle) {
              yield* handle.stop.pipe(Effect.catch(() => Effect.void));
            }
            state.process = undefined;
            state.environment = undefined;
            clearCapability("failed", safeError("timeout", true));
            if (directory) {
              if (certDirectory === directory) {
                certDirectory = undefined;
                certDirectoryReal = undefined;
              }
              yield* removeOwnedDirectory(directory);
            }
          }),
        );

      const recoverStartFailure = (error: VarlockError, cleanupDirectory: string | undefined) =>
        Effect.gen(function* () {
          if (error.code !== "disposed") updateFailure(error);
          yield* cleanupFailedStart(cleanupDirectory);
          const failure = error;
          return yield* Effect.fail(failure);
        });
      const updateFailure = (failure: VarlockError) => {
        if (state.phase === "failed" && state.session) state.error = failure;
        else clearCapability("failed", failure);
      };
      const cleanupFailedStart = (directory: string | undefined) =>
        directory && !state.session
          ? Effect.gen(function* () {
              if (certDirectory === directory) {
                certDirectory = undefined;
                certDirectoryReal = undefined;
              }
              yield* removeOwnedDirectory(directory);
            })
          : Effect.void;

      const startInternal = (): Effect.Effect<SafeStatus, VarlockError> => {
        let acquired: ManagedProcess | undefined;
        let cleanupDirectory: string | undefined;
        const operation = Effect.gen(function* () {
          const existing = yield* prepareStart(state, healthCheck, () =>
            statusSnapshot(state, cwd),
          );
          if (existing) return existing;
          return yield* Effect.gen(function* () {
            state.phase = "starting";
            state.error = undefined;
            cleanupDirectory = certDirectory;
            if (!certDirectory) {
              const acquiredDirectory = yield* acquireCertDirectory(
                (directory) => (cleanupDirectory = directory),
              );
              certDirectory = acquiredDirectory.directory;
              certDirectoryReal = acquiredDirectory.canonical;
            }
            const parts = commandParts(config, [
              "proxy",
              "start",
              "--allow-reload",
              "--cert-dir",
              certDirectory!,
            ]);
            const handle = yield* Effect.provideService(
              processService
                .spawn({
                  ...parts,
                  cwd,
                  // Varlock versions that expose inherited metadata in
                  // `proxy status` can use this to identify recordless
                  // proxies. Older versions simply ignore the variable.
                  env: { ...ambientEnvironment, KEY_FERRY_PROXY_MARKER: "key-ferry" },
                  terminateGraceMs: 500,
                })
                .pipe(Effect.mapError((error) => fromProcessError(error, "start_failed"))),
              Scope.Scope,
              managerScope,
            );
            acquired = handle;
            state.process = handle;
            let startedSession: VarlockSessionRecord | undefined;
            const result = yield* waitForSession(handle).pipe(
              Effect.flatMap((session) =>
                Effect.gen(function* () {
                  startedSession = session;
                  // Capture is the ownership boundary: publish before any
                  // environment or policy work can fail.
                  state.session = session;
                  yield* ownershipRecord(session, handle.pid, [config.command[0]!, ...parts.args]);
                  const environment = yield* readEnvironment(session);
                  yield* validateStartupEgress(state, config.requireStrictEgress, session, handle);
                  return { session, environment };
                }),
              ),
              Effect.catch((error) =>
                Effect.gen(function* () {
                  const captured = startedSession;
                  let stopped = true;
                  if (captured) {
                    stopped = yield* stopCapturedSession(captured);
                  } else yield* cleanupUncapturedSessions(handle);
                  yield* handle.stop.pipe(Effect.catch(() => Effect.void));
                  if (stopped) {
                    state.process = undefined;
                  } else {
                    state.phase = "failed";
                    state.error = error;
                  }
                  return yield* Effect.fail(error);
                }),
              ),
            );
            state.session = result.session;
            state.environment = result.environment;
            state.phase = "ready";
            state.error = undefined;
            return statusSnapshot(state, cwd);
          }).pipe(
            Effect.catch((error) => recoverStartFailure(error, cleanupDirectory)),
            Effect.onInterrupt(() => interruptedStartCleanup(acquired, cleanupDirectory)),
          );
        });
        // Do not attach ownership cleanup until preflight has completed: a
        // cancelled health check must not tear down a process owned by an
        // earlier successful start.
        return operation;
      };

      const exclusive = <A>(effect: Effect.Effect<A, VarlockError>) => lock.withPermit(effect);
      const ensureStarted = exclusive(startInternal());

      // Keep startup and environment publication under one permit. The plugin
      // must not compose the individually locked operations, or a non-reentrant
      // semaphore would deadlock while trying to acquire itself again.
      const ensureReady = exclusive(
        Effect.gen(function* () {
          yield* healthCheck();
          if (!state.process || !state.session || state.phase !== "ready") {
            yield* startInternal();
          }
          if (!state.environment) return yield* Effect.fail(safeError("not_ready", true));
          return {
            status: statusSnapshot(state, cwd),
            environment: state.environment,
          };
        }),
      );

      const environmentEffect = exclusive(
        Effect.gen(function* () {
          yield* healthCheck();
          yield* rejectUnavailableEnvironment(state);
          if (state.phase !== "ready" || !state.environment) {
            yield* startInternal();
          }
          if (!state.environment) return yield* Effect.fail(safeError("not_ready", true));
          return state.environment;
        }),
      );

      const refreshInternal = Effect.gen(function* () {
        yield* ensureRefreshReadiness({
          state,
          healthCheck,
          start: startInternal,
        });
        const session = yield* requireRefreshSession(state);
        const reload = runCommand(
          processService,
          config,
          cwd,
          ["proxy", "reload", "--session", session.uuid],
          config.reloadTimeoutMs,
          ambientEnvironment,
        ).pipe(
          Effect.mapError(
            (error) =>
              new VarlockError({
                ...error,
                code: error.code === "timeout" ? "timeout" : "refresh_failed",
                message: error.message,
              }),
          ),
        );
        const readStatus = runCommand(
          processService,
          config,
          cwd,
          ["proxy", "status", "--format", "json"],
          config.commandTimeoutMs,
          ambientEnvironment,
        ).pipe(
          Effect.flatMap(({ stdout }) =>
            Effect.try({
              try: () => decodeSessionList(stdout),
              catch: () => safeError("protocol_error", false),
            }),
          ),
        );
        const result = yield* completeRefreshHandshake(
          reload,
          readStatus,
          session,
          state.process!.pid,
          cwd,
          readEnvironment,
        );
        yield* validateRefreshCapability(
          state,
          result.session,
          config.requireStrictEgress,
          healthCheck,
          clearCapability,
        );
        state.session = result.session;
        state.environment = result.environment;
        state.generation += 1;
        state.lastRefreshAt = new Date().toISOString();
        state.error = undefined;
        return statusSnapshot(state, cwd);
      }).pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            if (error.code !== "disposed") {
              const handle = state.process;
              yield* stopCapturedSession();
              if (handle) {
                yield* handle.stop.pipe(Effect.catch(() => Effect.void));
              }
              state.process = undefined;
              clearCapability(
                "failed",
                error.code === "refresh_failed" ? error : safeError("refresh_failed", true),
              );
            }
            return yield* Effect.fail(
              error.code === "disposed" ? error : safeError("refresh_failed", true),
            );
          }),
        ),
      );
      const interruptedRefresh = refreshInternal.pipe(
        Effect.onInterrupt(() => interruptedStartCleanup(state.process, certDirectory)),
      );
      const refresh = exclusive(interruptedRefresh);
      const refreshReady = exclusive(
        Effect.gen(function* () {
          const status = yield* interruptedRefresh;
          if (!state.environment) return yield* Effect.fail(safeError("not_ready", true));
          return { status, environment: state.environment };
        }),
      );

      const dispose = lock.withPermit(
        Effect.gen(function* () {
          if (state.disposed && !state.session) return;
          state.disposed = true;
          state.phase = "stopping";
          const handle = state.process;
          const stopped = yield* stopCapturedSession();
          if (!stopped) return;
          state.environment = undefined;
          if (handle) {
            yield* handle.stop.pipe(Effect.catch(() => Effect.void));
          }
          state.process = undefined;
          state.phase = "stopped";
          state.generation += 1;
        }),
      );

      const service: ProjectKeyFerryManagerService = {
        status,
        ensureStarted,
        ensureReady,
        environment: environmentEffect,
        refresh,
        refreshReady,
        dispose,
        withExclusive: <A, E, R>(effect: Effect.Effect<A, E, R>) => lock.withPermit(effect),
      };
      yield* Effect.addFinalizer(() =>
        Effect.forEach([...ownedCertDirectories], removeOwnedDirectory, {
          discard: true,
        }),
      );
      // Finalizers run in reverse registration order, so stop the sidecar
      // before removing the directory that contains its CA.
      yield* Effect.addFinalizer(() => dispose);
      return ProjectKeyFerryManager.of(service);
    }),
  ).pipe(Layer.provide(processLayer));
}

export const projectKeyFerryManagerFactory: ProjectKeyFerryManagerFactory = {
  layer: (options) => makeProjectKeyFerryManager(options),
};
