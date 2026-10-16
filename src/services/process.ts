import { spawn, type ChildProcess } from "node:child_process"
import { Context, Data, Duration, Effect, Layer } from "effect"

export type ProcessPhase = "spawn" | "running" | "timeout" | "capture-limit" | "exit"

/** Deliberately contains no command, arguments, or captured output. */
export class ProcessError extends Data.TaggedError("ProcessError")<{
  readonly phase: ProcessPhase
  readonly code: "spawn-failed" | "timeout" | "capture-limit" | "non-zero" | "signal" | "io"
  readonly message: string
  readonly exitCode?: number
  readonly signal?: string
}> {}

export interface ProcessExit {
  readonly code: number | null
  readonly signal: string | null
}

export interface ProcessHealth {
  readonly pid: number
  readonly running: boolean
  readonly exit?: ProcessExit
}

export interface RunInput {
  readonly executable: string
  readonly args: readonly string[]
  readonly cwd: string
  /** Exact child environment. Omit to run with an isolated empty environment. */
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly maxBytes?: number
  readonly timeoutMs?: number
}

export interface RunResult extends ProcessExit {
  readonly stdout: string
  readonly stderr: string
}

export interface SpawnInput extends Omit<RunInput, "maxBytes" | "timeoutMs"> {
  readonly terminateGraceMs?: number
}

export interface ManagedProcess {
  readonly pid: number
  readonly completion: Effect.Effect<ProcessExit, ProcessError>
  readonly health: Effect.Effect<ProcessHealth, never>
  readonly stop: Effect.Effect<void, ProcessError>
}

export interface ProcessService {
  run(input: RunInput): Effect.Effect<RunResult, ProcessError>
  spawn(input: SpawnInput): Effect.Effect<ManagedProcess, ProcessError, ScopeRequirement>
}

// Kept as a type alias so consumers do not need to know the implementation's
// internal Layer machinery. A spawned process is always scoped.
export type ScopeRequirement = import("effect/Scope").Scope

export class Process extends Context.Service<Process, ProcessService>()("key-ferry/Process") {}

const defaultMaxBytes = 1024 * 1024
const defaultGraceMs = 500

const safeMessage = (phase: ProcessPhase, code: ProcessError["code"]): string =>
  `${phase} failed (${code})`

const error = (
  phase: ProcessPhase,
  code: ProcessError["code"],
  extra: Partial<Pick<ProcessError, "exitCode" | "signal">> = {},
) => new ProcessError({ phase, code, message: safeMessage(phase, code), ...extra })

const kill = (child: ChildProcess, graceMs: number): Effect.Effect<void, ProcessError> =>
  Effect.callback((resume) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = () => {
      if (!settled) {
        settled = true
        if (timer) clearTimeout(timer)
        child.removeListener("close", finish)
        resume(Effect.void)
      }
    }
    child.once("close", finish)
    if (child.exitCode !== null || child.signalCode !== null) return finish()
    try {
      child.kill("SIGTERM")
    } catch {
      return finish()
    }
    timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill("SIGKILL")
        } catch {
          // The process may have exited between the check and kill.
        }
      }
      finish()
    }, Math.max(0, graceMs))
    return Effect.sync(() => {
      if (timer) clearTimeout(timer)
      child.removeListener("close", finish)
    })
  })

const spawnRaw = (input: SpawnInput): Effect.Effect<ManagedProcess, ProcessError, ScopeRequirement> =>
  Effect.acquireRelease(
    Effect.callback<ManagedProcess, ProcessError>((resume) => {
      let child: ChildProcess
      try {
        // shell is intentionally absent. Never inherit or mutate global env.
        child = spawn(input.executable, [...input.args], {
          cwd: input.cwd,
          // An omitted environment is intentionally isolated. Callers that
          // need the trusted Varlock resolver environment must pass it
          // deliberately; never inherit the host process environment.
          env: input.env ? { ...input.env } : {},
          shell: false,
          detached: false,
          stdio: ["ignore", "ignore", "ignore"],
        })
      } catch {
        resume(Effect.fail(error("spawn", "spawn-failed")))
        return
      }
      const completion = Effect.callback<ProcessExit, ProcessError>((done) => {
        const close = (code: number | null, signal: NodeJS.Signals | null) => {
          child.removeListener("error", onError)
          if (code === 0) done(Effect.succeed({ code, signal }))
          else done(Effect.fail(error("exit", code === null ? "signal" : "non-zero", { exitCode: code ?? undefined, signal: signal ?? undefined })))
        }
        const onError = () => done(Effect.fail(error("running", "io")))
        child.once("close", close)
        child.once("error", onError)
        return Effect.sync(() => {
          child.removeListener("close", close)
          child.removeListener("error", onError)
        })
      })
      let stopped = false
      const stop = Effect.suspend(() => {
        if (stopped) return Effect.void
        stopped = true
        // A stop is bounded by kill's grace period, but must not be
        // interruptible between SIGTERM and the SIGKILL fallback. Otherwise
        // an interrupted stop can clear the fallback timer while `stopped`
        // prevents scope finalization from trying again.
        return Effect.uninterruptible(kill(child, input.terminateGraceMs ?? defaultGraceMs))
      })
      resume(Effect.succeed({
        pid: child.pid!,
        completion,
        health: Effect.sync(() => ({ pid: child.pid!, running: child.exitCode === null && child.signalCode === null, exit: child.exitCode !== null || child.signalCode !== null ? { code: child.exitCode, signal: child.signalCode } : undefined })),
        stop,
      }))
    }),
    (process) => process.stop.pipe(Effect.catch(() => Effect.void)),
  )

const run = (input: RunInput): Effect.Effect<RunResult, ProcessError> => {
  const maxBytes = input.maxBytes ?? defaultMaxBytes
  const spawned = Effect.callback<RunResult, ProcessError>((resume, signal) => {
    let child: ChildProcess
    try {
      child = spawn(input.executable, [...input.args], { cwd: input.cwd, env: input.env ? { ...input.env } : {}, shell: false, detached: false, stdio: ["ignore", "pipe", "pipe"] })
    } catch {
      resume(Effect.fail(error("spawn", "spawn-failed")))
      return
    }
    let stdout = ""
    let stderr = ""
    let limited = false
    const onData = (which: "stdout" | "stderr") => (chunk: Buffer) => {
      if (which === "stdout") stdout += chunk.toString("utf8")
      else stderr += chunk.toString("utf8")
      if ((which === "stdout" ? Buffer.byteLength(stdout) : Buffer.byteLength(stderr)) > maxBytes && !limited) {
        limited = true
        try { child.kill("SIGTERM") } catch { /* already exited */ }
        setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) {
            try { child.kill("SIGKILL") } catch { /* already exited */ }
          }
        }, defaultGraceMs)
      }
    }
    const out = onData("stdout")
    const err = onData("stderr")
    child.stdout?.on("data", out)
    child.stderr?.on("data", err)
    const close = (code: number | null, sig: NodeJS.Signals | null) => {
      if (limited) resume(Effect.fail(error("capture-limit", "capture-limit")))
      else if (code === 0) resume(Effect.succeed({ code, signal: sig, stdout, stderr }))
      else resume(Effect.fail(error("exit", code === null ? "signal" : "non-zero", { exitCode: code ?? undefined, signal: sig ?? undefined })))
    }
    child.once("close", close)
    child.once("error", () => resume(Effect.fail(error("running", "io"))))
    signal.addEventListener("abort", () => {
      try { child.kill("SIGTERM") } catch { /* already exited */ }
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          try { child.kill("SIGKILL") } catch { /* already exited */ }
        }
      }, defaultGraceMs)
    }, { once: true })
    return Effect.sync(() => { child.stdout?.removeListener("data", out); child.stderr?.removeListener("data", err); child.removeListener("close", close) })
  })
  const bounded = input.timeoutMs === undefined
    ? spawned
    : spawned.pipe(Effect.timeoutOrElse({ duration: Duration.millis(input.timeoutMs), orElse: () => Effect.fail(error("timeout", "timeout")) }))
  return bounded
}

export const ProcessLive = Layer.succeed(Process, Process.of({ run, spawn: spawnRaw }))
