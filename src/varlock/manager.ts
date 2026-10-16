import { Duration, Effect, Layer, Scope, Semaphore } from "effect"
import { access, mkdtemp, realpath, rm, stat, lstat } from "node:fs/promises"
import { constants as fsConstants } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import {
  ProjectKeyFerryManager,
  type ProjectKeyFerryManagerFactory,
  type ProjectKeyFerryManagerOptions,
  type ProjectKeyFerryManagerService,
  type ResolvedEnvironment,
  type SafeStatus,
  VarlockError,
} from "../contracts.js"
import { Process, ProcessLive, type ManagedProcess, type ProcessError, type ProcessService } from "../services/process.js"
import {
  decodeSessionList,
  findOwnedSession,
  sanitizeSessionStatus,
  selectPlaceholderEnvironment,
  validateProxyWiring,
  type VarlockSessionRecord,
} from "./protocol.js"

const DEFAULT_COMMAND = ["varlock"] as const
const DEFAULT_START_TIMEOUT = 30_000
const DEFAULT_COMMAND_TIMEOUT = 10_000
const DEFAULT_REFRESH_TIMEOUT = 30_000
const DEFAULT_POLL_INTERVAL = 100
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024
const MAX_TIMEOUT = 10 * 60_000

type AdapterOptions = {
  command: readonly string[]
  environmentKeys: readonly string[]
  startupTimeoutMs: number
  commandTimeoutMs: number
  reloadTimeoutMs: number
  pollIntervalMs: number
  requireStrictEgress: boolean
}

type ManagerState = {
  phase: SafeStatus["phase"]
  generation: number
  process?: ManagedProcess
  session?: VarlockSessionRecord
  environment?: ResolvedEnvironment
  lastRefreshAt?: string
  error?: VarlockError
  disposed: boolean
}

const safeError = (code: ConstructorParameters<typeof VarlockError>[0]["code"], retryable: boolean): VarlockError =>
  new VarlockError({ code, retryable, message: `Varlock ${code.replaceAll("_", " ")}` })

const fromProcessError = (error: ProcessError, code: "start_failed" | "refresh_failed" | "unavailable" | "timeout"): VarlockError =>
  new VarlockError({
    code,
    retryable: error.code === "timeout" || error.code === "spawn-failed" || error.code === "io",
    message: error.code === "timeout" ? "Varlock command timed out" : `Varlock command ${error.code}`,
  })

function adapterOptions(options: ProjectKeyFerryManagerOptions): AdapterOptions {
  const raw = options.adapter ?? {}
  const command = raw.command === undefined ? [...DEFAULT_COMMAND] : raw.command
  const environmentKeys = raw.environmentKeys
  if (!Array.isArray(command) || command.length === 0 || command.length > 32 || command.some((v) => typeof v !== "string" || v.length === 0 || v.length > 1024 || v.includes("\0"))) {
    throw safeError("invalid_config", false)
  }
  if (!Array.isArray(environmentKeys) || environmentKeys.length > 128 || environmentKeys.some((v) => typeof v !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(v) || v.length > 256)) {
    throw safeError("invalid_config", false)
  }
  const numberOption = (name: string, fallback: number, min: number, max: number): number => {
    const value = raw[name]
    if (value === undefined) return fallback
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw safeError("invalid_config", false)
    return value
  }
  const strict = raw.requireStrictEgress
  if (strict !== undefined && typeof strict !== "boolean") throw safeError("invalid_config", false)
  return {
    command: [...command] as string[],
    environmentKeys: [...environmentKeys] as string[],
    startupTimeoutMs: numberOption("startupTimeoutMs", DEFAULT_START_TIMEOUT, 100, MAX_TIMEOUT),
    commandTimeoutMs: numberOption("commandTimeoutMs", DEFAULT_COMMAND_TIMEOUT, 100, MAX_TIMEOUT),
    reloadTimeoutMs: numberOption("reloadTimeoutMs", DEFAULT_REFRESH_TIMEOUT, 100, MAX_TIMEOUT),
    pollIntervalMs: numberOption("pollIntervalMs", DEFAULT_POLL_INTERVAL, 10, 10_000),
    requireStrictEgress: strict ?? true,
  }
}

function safeProjectDirectory(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 16_384 || value.includes("\0")) throw safeError("invalid_config", false)
  return value
}

function parseEnvironmentOutput(raw: string): Readonly<Record<string, string>> {
  if (Buffer.byteLength(raw, "utf8") > MAX_OUTPUT_BYTES) throw safeError("protocol_error", false)
  let value: unknown
  try { value = JSON.parse(raw) } catch { throw safeError("protocol_error", false) }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw safeError("protocol_error", false)
  const result: Record<string, string> = Object.create(null) as Record<string, string>
  const keys = Object.keys(value as object)
  if (keys.length > 512) throw safeError("protocol_error", false)
  for (const key of keys) {
    if (key === "__proto__" || key === "prototype" || key === "constructor" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || key.length > 256) throw safeError("protocol_error", false)
    const item = (value as Record<string, unknown>)[key]
    if (typeof item !== "string" || item.length > 16_384 || item.includes("\0")) throw safeError("protocol_error", false)
    result[key] = item
  }
  return result
}

function statusSnapshot(state: ManagerState, projectDirectory: string): SafeStatus {
  let endpoint: string | undefined
  if (state.session) {
    try { endpoint = validateProxyWiring(state.session.env).proxyUrl } catch { endpoint = undefined }
  }
  return {
    phase: state.phase,
    projectDirectory: projectDirectory as SafeStatus["projectDirectory"],
    generation: state.generation,
    ...(state.process ? { pid: state.process.pid } : {}),
    ...(endpoint ? { endpoint } : {}),
    ...(state.lastRefreshAt ? { lastRefreshAt: state.lastRefreshAt } : {}),
    ...(state.error ? { error: state.error } : {}),
  }
}

function commandParts(options: AdapterOptions, args: readonly string[]) {
  return { executable: options.command[0]!, args: [...options.command.slice(1), ...args] }
}

function runCommand(process: ProcessService, options: AdapterOptions, cwd: string, args: readonly string[], timeoutMs: number, environment: Readonly<Record<string, string>>): Effect.Effect<{ stdout: string; stderr: string }, VarlockError> {
  const parts = commandParts(options, args)
  return process.run({ ...parts, cwd, env: environment, maxBytes: MAX_OUTPUT_BYTES, timeoutMs }).pipe(
    Effect.mapError((error) => fromProcessError(error, error.code === "timeout" ? "timeout" : "unavailable")),
    Effect.map(({ stdout, stderr }) => ({ stdout, stderr })),
  )
}

function candidatesForOwner(records: readonly VarlockSessionRecord[], pid: number, cwd: string): readonly VarlockSessionRecord[] {
  return records.filter((record) => record.ownerPid === pid && record.cwd === cwd && record.endedAt === undefined)
}

export function makeProjectKeyFerryManager(
  options: ProjectKeyFerryManagerOptions,
  processLayer: Layer.Layer<Process, never, never> = ProcessLive,
): Layer.Layer<ProjectKeyFerryManager, VarlockError, never> {
  return Layer.effect(
    ProjectKeyFerryManager,
    Effect.gen(function* () {
      const processService = yield* Process
      // Process.spawn is scoped. Capture the layer scope once and provide it
      // to lazy starts so a handle remains alive until this manager layer is
      // released, rather than being released at the end of ensureStarted.
      const managerScope = yield* Scope.Scope
      const config = adapterOptions(options)
      const requestedCwd = safeProjectDirectory(options.projectDirectory)
      const cwd = yield* Effect.tryPromise({
        try: async () => {
          const canonical = await realpath(requestedCwd)
          const info = await stat(canonical)
          if (!info.isDirectory()) throw new Error("project path is not a directory")
          await access(canonical, fsConstants.R_OK | fsConstants.X_OK)
          return canonical
        },
        catch: () => safeError("invalid_config", false),
      })
      // The sidecar gets a stable snapshot, rather than inheriting a mutable
      // host environment at each command. This is intentionally only for the
      // trusted Varlock CLI boundary and is never copied into MCP config or
      // returned by the manager.
      const ambientEnvironment = Object.fromEntries(
        Object.entries(globalThis.process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
      )
      const certDirectory = yield* Effect.tryPromise({
        try: () => mkdtemp(join(tmpdir(), "key-ferry-cert-")),
        catch: () => safeError("start_failed", true),
      })
      const certDirectoryReal = yield* Effect.tryPromise({
        try: () => realpath(certDirectory),
        catch: () => safeError("start_failed", true),
      })
      const lock = yield* Semaphore.make(1)
      const state: ManagerState = { phase: "stopped", generation: 0, disposed: false }

      const clearCapability = (phase: SafeStatus["phase"], error?: VarlockError) => {
        state.phase = phase
        state.environment = undefined
        state.session = undefined
        state.error = error
        state.generation += 1
      }

      const healthCheck = (): Effect.Effect<void> => {
        if (!state.process) return Effect.void
        return state.process.health.pipe(Effect.flatMap((health) => {
          if (health.running) return Effect.void
          clearCapability("degraded", safeError("unavailable", true))
          return Effect.void
        }))
      }

      const status: Effect.Effect<SafeStatus> = Effect.suspend(() => healthCheck()).pipe(
        Effect.asVoid,
        Effect.map(() => statusSnapshot(state, cwd)),
      )

      const waitForSession = (handle: ManagedProcess): Effect.Effect<VarlockSessionRecord, VarlockError> => {
        const deadline = Date.now() + config.startupTimeoutMs
        const poll = (): Effect.Effect<VarlockSessionRecord, VarlockError> =>
          Effect.gen(function* () {
            const output = yield* runCommand(processService, config, cwd, ["proxy", "status", "--format", "json"], config.commandTimeoutMs, ambientEnvironment)
            const records = yield* Effect.try({
              try: () => decodeSessionList(output.stdout),
              catch: () => safeError("protocol_error", false),
            })
            const candidates = candidatesForOwner(records, handle.pid, cwd)
            if (candidates.length === 1) {
              const candidate = candidates[0]!
              const owned = findOwnedSession(records, { ownerPid: handle.pid, sessionUuid: candidate.uuid, projectDirectory: cwd })
              if (owned) return owned
            }
            if (Date.now() >= deadline) return yield* Effect.fail(safeError("timeout", true))
            yield* Effect.sleep(Duration.millis(config.pollIntervalMs))
            return yield* poll()
          })
        return poll()
      }

      const readEnvironment = (session: VarlockSessionRecord): Effect.Effect<ResolvedEnvironment, VarlockError> =>
        runCommand(processService, config, cwd, ["proxy", "env", "--session", session.uuid, "--full", "--format", "json"], config.commandTimeoutMs, ambientEnvironment).pipe(
          Effect.flatMap(({ stdout }) => Effect.gen(function* () {
              const decoded = yield* Effect.try({
                try: () => {
                  const full = parseEnvironmentOutput(stdout)
                  const wiring = validateProxyWiring(full)
                  const selected = selectPlaceholderEnvironment(full, session, config.environmentKeys)
                  return { wiring, selected }
                },
                catch: () => safeError("protocol_error", false),
              })
              yield* Effect.tryPromise({
                try: async () => {
                  const original = await lstat(decoded.wiring.caPath)
                  if (!original.isFile() || original.isSymbolicLink()) throw new Error("not a regular certificate")
                  const resolved = await realpath(decoded.wiring.caPath)
                  const cert = await stat(resolved)
                  const outside = relative(certDirectoryReal, resolved)
                  if (outside === ".." || outside.startsWith("../") || outside.includes("\0")) throw new Error("certificate outside owned directory")
                  // Varlock's CA certificate is public trust material and is
                  // currently written 0644. Reject group/other *writes*, but
                  // allow readable public certs. The directory remains
                  // manager-owned and private; private keys are never
                  // accepted through this path.
                  if (!cert.isFile() || cert.uid !== globalThis.process.getuid?.() || (cert.mode & 0o022) !== 0) throw new Error("certificate ownership or permissions invalid")
                },
                catch: () => safeError("protocol_error", false),
              })
              return { ...decoded.wiring.env, ...decoded.selected }
          })),
        )

      const startInternal = (): Effect.Effect<SafeStatus, VarlockError> => Effect.gen(function* () {
        if (state.disposed) return yield* Effect.fail(safeError("disposed", false))
        if (state.process && state.session) {
          yield* healthCheck()
          if (state.phase === "ready") return statusSnapshot(state, cwd)
        }
        state.phase = "starting"
        state.error = undefined
        const parts = commandParts(config, ["proxy", "start", "--allow-reload", "--cert-dir", certDirectory])
        const handle = yield* Effect.provideService(
          processService.spawn({ ...parts, cwd, env: ambientEnvironment, terminateGraceMs: 500 }).pipe(
            Effect.mapError((error) => fromProcessError(error, "start_failed")),
          ),
          Scope.Scope,
          managerScope,
        )
        state.process = handle
        const result = yield* waitForSession(handle).pipe(
          Effect.flatMap((session) => readEnvironment(session).pipe(Effect.map((environment) => ({ session, environment })))),
          Effect.catch((error) => Effect.gen(function* () {
            yield* handle.stop.pipe(Effect.catch(() => Effect.void))
            state.process = undefined
            clearCapability("failed", error)
            return yield* Effect.fail(error)
          })),
        )
        if (config.requireStrictEgress && result.session.egressMode !== "strict") {
          yield* handle.stop.pipe(Effect.catch(() => Effect.void))
          state.process = undefined
          clearCapability("failed", safeError("invalid_config", false))
          return yield* Effect.fail(safeError("invalid_config", false))
        }
        state.session = result.session
        state.environment = result.environment
        state.phase = "ready"
        state.error = undefined
        return statusSnapshot(state, cwd)
      })

      const exclusive = <A>(effect: Effect.Effect<A, VarlockError>) => lock.withPermit(effect)
      const ensureStarted = exclusive(startInternal())

      const environmentEffect = exclusive(Effect.gen(function* () {
        yield* healthCheck()
        if (state.phase === "failed" || state.phase === "degraded") return yield* Effect.fail(safeError("not_ready", true))
        if (state.phase !== "ready" || !state.environment) {
          yield* startInternal()
        }
        if (!state.environment) return yield* Effect.fail(safeError("not_ready", true))
        return state.environment
      }))

      const refresh = exclusive(Effect.gen(function* () {
        if (state.disposed) return yield* Effect.fail(safeError("disposed", false))
        yield* healthCheck()
        if (!state.process || !state.session || state.phase !== "ready") yield* startInternal()
        if (!state.process || !state.session) return yield* Effect.fail(safeError("not_ready", true))
        const session = state.session
        const output = yield* runCommand(processService, config, cwd, ["proxy", "reload", "--session", session.uuid], config.reloadTimeoutMs, ambientEnvironment).pipe(
          Effect.mapError((error) => new VarlockError({ ...error, code: error.code === "timeout" ? "timeout" : "refresh_failed", message: error.message })),
        )
        void output
        const statusOutput = yield* runCommand(processService, config, cwd, ["proxy", "status", "--format", "json"], config.commandTimeoutMs, ambientEnvironment)
        const records = yield* Effect.try({ try: () => decodeSessionList(statusOutput.stdout), catch: () => safeError("protocol_error", false) })
        const next = findOwnedSession(records, { ownerPid: state.process.pid, sessionUuid: session.uuid, projectDirectory: cwd })
        if (!next) {
          clearCapability("failed", safeError("refresh_failed", true))
          return yield* Effect.fail(safeError("refresh_failed", true))
        }
        const nextEnvironment = yield* readEnvironment(next).pipe(Effect.mapError(() => safeError("refresh_failed", true)))
        if (config.requireStrictEgress && next.egressMode !== "strict") {
          clearCapability("failed", safeError("refresh_failed", false))
          return yield* Effect.fail(safeError("refresh_failed", false))
        }
        state.session = next
        state.environment = nextEnvironment
        state.generation += 1
        state.lastRefreshAt = new Date().toISOString()
        state.error = undefined
        return statusSnapshot(state, cwd)
      })).pipe(Effect.catch((error) => Effect.gen(function* () {
        if (error.code !== "disposed") {
          const handle = state.process
          if (handle) yield* handle.stop.pipe(Effect.catch(() => Effect.void))
          state.process = undefined
          clearCapability("failed", error.code === "refresh_failed" ? error : safeError("refresh_failed", true))
        }
        return yield* Effect.fail(error.code === "disposed" ? error : safeError("refresh_failed", true))
      })))

      const dispose = lock.withPermit(Effect.gen(function* () {
        if (state.disposed) return
        state.disposed = true
        state.phase = "stopping"
        const handle = state.process
        state.environment = undefined
        state.session = undefined
        if (handle) yield* handle.stop.pipe(Effect.catch(() => Effect.void))
        state.process = undefined
        state.phase = "stopped"
        state.generation += 1
      }))

      const service: ProjectKeyFerryManagerService = {
        status,
        ensureStarted,
        environment: environmentEffect,
        refresh,
        dispose,
        withExclusive: <A, E, R>(effect: Effect.Effect<A, E, R>) => lock.withPermit(effect),
      }
      yield* Effect.addFinalizer(() => Effect.promise(() => rm(certDirectory, { recursive: true, force: true })))
      // Finalizers run in reverse registration order, so stop the sidecar
      // before removing the directory that contains its CA.
      yield* Effect.addFinalizer(() => dispose)
      return ProjectKeyFerryManager.of(service)
    }),
  ).pipe(Layer.provide(processLayer))
}

export const projectKeyFerryManagerFactory: ProjectKeyFerryManagerFactory = {
  layer: (options) => makeProjectKeyFerryManager(options),
}
