import { Context, Effect, Layer, Schema, Scope } from "effect"

/**
 * Effect-native contracts shared by the Key Ferry sidecar manager and OpenCode
 * V2 adapters.
 *
 * Resolved environment values are an internal capability. They must never be
 * returned by status, RPC, logs, or model-visible tool output.
 */

export type ProjectDirectory = string & { readonly __projectDirectory: unique symbol }

export type ManagerPhase =
  | "stopped"
  | "starting"
  | "ready"
  | "degraded"
  | "failed"
  | "stopping"

export type VarlockErrorCode =
  | "invalid_config"
  | "unavailable"
  | "start_failed"
  | "refresh_failed"
  | "not_ready"
  | "disposed"
  | "protocol_error"
  | "timeout"

/** Tagged and already-sanitized error safe for public diagnostics. */
export class VarlockError extends Schema.TaggedError<VarlockError>()("Varlock.Error", {
  code: Schema.Literals([
    "invalid_config",
    "unavailable",
    "start_failed",
    "refresh_failed",
    "not_ready",
    "disposed",
    "protocol_error",
    "timeout",
  ] as const),
  message: Schema.String,
  retryable: Schema.Boolean,
}) {}

/** Safe to return from status RPCs or display to a user. */
export interface SafeStatus {
  readonly phase: ManagerPhase
  readonly projectDirectory: ProjectDirectory
  readonly generation: number
  readonly pid?: number
  readonly endpoint?: string
  readonly lastRefreshAt?: string
  readonly error?: VarlockError
  readonly diagnostics?: readonly SafeDiagnostic[]
}

/** Secret-free configuration diagnostics surfaced to RPC/TUI consumers. */
export interface SafeDiagnostic {
  readonly code: string
  readonly server: string
  readonly message: string
}

/**
 * Secret-bearing values are deliberately separate from SafeStatus. This type
 * is for internal process/proxy wiring only and must not cross an RPC boundary.
 */
export type ResolvedEnvironment = Readonly<Record<string, string>>

/**
 * A manager is location/project scoped. Every mutating operation is required
 * to serialize against the manager's internal semaphore and to honor Effect
 * interruption. Implementations must never mutate global process.env.
 */
export interface ProjectKeyFerryManagerService {
  readonly status: Effect.Effect<SafeStatus>

  /** Start or reuse the manager-owned process, failing closed if not ready. */
  readonly ensureStarted: Effect.Effect<SafeStatus, VarlockError>

  /** Internal-only environment capability for a child process or proxy. */
  readonly environment: Effect.Effect<ResolvedEnvironment, VarlockError>

  /** Re-resolve and atomically apply values; failures leave the connection closed. */
  readonly refresh: Effect.Effect<SafeStatus, VarlockError>

  /** Idempotent teardown of only the process and resources this manager owns. */
  readonly dispose: Effect.Effect<void>

  /**
   * Serializes lifecycle and refresh operations. Implementations should back
   * this with an internal Semaphore and reject work after disposal.
   */
  readonly withExclusive: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
}

/** Native Effect service tag used by the manager and plugin layers. */
export class ProjectKeyFerryManager extends Context.Service<
  ProjectKeyFerryManager,
  ProjectKeyFerryManagerService
>()("key-ferry/ProjectKeyFerryManager") {}

export interface ProjectKeyFerryManagerOptions {
  readonly projectDirectory: ProjectDirectory
  /** Stable diagnostic label only, never a credential or secret. */
  readonly owner?: string
  /** Adapter-specific non-secret options, pending Varlock protocol finalization. */
  readonly adapter?: Readonly<Record<string, unknown>>
  /** Optional explicit owned session identifier; omitted for owned-only MVP. */
  readonly sessionID?: string
}

/**
 * A factory supplies a scoped Layer. The implementation should use
 * Effect.acquireRelease for the owned process and register finalization in the
 * caller's Scope. No daemon adoption or global stop operation is implied.
 */
export interface ProjectKeyFerryManagerFactory<R = never> {
  readonly layer: (
    options: ProjectKeyFerryManagerOptions,
  ) => Layer.Layer<ProjectKeyFerryManager, VarlockError, R>
}

/** Public plugin options. Values are configuration, never resolved secrets. */
export interface KeyFerryPluginOptions {
  readonly enabled?: boolean
  readonly projectDirectory?: string
  readonly adapter?: Readonly<Record<string, unknown>>
}

/** Runtime service dependencies for an injectable process implementation. */
export interface VarlockProcessService {
  readonly spawn: (
    input: VarlockProcessSpawn,
  ) => Effect.Effect<VarlockProcessHandle, VarlockError>
  readonly send: (
    handle: VarlockProcessHandle,
    input: VarlockProcessCommand,
  ) => Effect.Effect<VarlockProcessResult, VarlockError>
  readonly stop: (handle: VarlockProcessHandle) => Effect.Effect<void, VarlockError>
}

export interface VarlockProcessSpawn {
  readonly command: readonly string[]
  readonly cwd: ProjectDirectory
  readonly sessionID: string
  readonly allowReload: true
}

export interface VarlockProcessHandle {
  readonly pid: number
  readonly sessionID: string
  readonly ownershipID: string
}

export type VarlockProcessCommand =
  | { readonly type: "status" }
  | { readonly type: "environment"; readonly names: readonly string[] }
  | { readonly type: "refresh" }

export interface VarlockProcessResult {
  /** Raw protocol data stays inside the Varlock adapter. */
  readonly value: unknown
}

export class VarlockProcess extends Context.Service<VarlockProcess, VarlockProcessService>()(
  "key-ferry/VarlockProcess",
) {}

/** Explicit brand constructor used at configuration boundaries. */
export function projectDirectory(value: string): ProjectDirectory {
  if (value.length === 0) throw new TypeError("project directory must not be empty")
  return value as ProjectDirectory
}

/**
 * A scoped layer must be provided under an Effect Scope. This alias documents
 * the intended lifetime without forcing callers to expose implementation
 * details or Promise wrappers.
 */
export type ScopedManagerLayer<R = never> = Layer.Layer<ProjectKeyFerryManager, VarlockError, R | Scope.Scope>
