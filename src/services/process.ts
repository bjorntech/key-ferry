import { spawn, type ChildProcess } from "node:child_process";
import { Context, Data, Duration, Effect, Layer } from "effect";

export type ProcessPhase = "spawn" | "running" | "timeout" | "capture-limit" | "exit";

/** Deliberately contains no command, arguments, or captured output. */
export class ProcessError extends Data.TaggedError("ProcessError")<{
  readonly phase: ProcessPhase;
  readonly code: "spawn-failed" | "timeout" | "capture-limit" | "non-zero" | "signal" | "io";
  readonly message: string;
  readonly exitCode?: number;
  readonly signal?: string;
}> {}

export interface ProcessExit {
  readonly code: number | null;
  readonly signal: string | null;
}

export interface ProcessHealth {
  readonly pid: number;
  readonly running: boolean;
  readonly exit?: ProcessExit;
}

export interface RunInput {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  /** Exact child environment. Omit to run with an isolated empty environment. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
}

export interface RunResult extends ProcessExit {
  readonly stdout: string;
  readonly stderr: string;
}

export interface SpawnInput extends Omit<RunInput, "maxBytes" | "timeoutMs"> {
  readonly terminateGraceMs?: number;
}

export interface ManagedProcess {
  readonly pid: number;
  readonly completion: Effect.Effect<ProcessExit, ProcessError>;
  readonly health: Effect.Effect<ProcessHealth, never>;
  readonly stop: Effect.Effect<void, ProcessError>;
}

export interface ProcessService {
  run(input: RunInput): Effect.Effect<RunResult, ProcessError>;
  spawn(input: SpawnInput): Effect.Effect<ManagedProcess, ProcessError, ScopeRequirement>;
}

// Kept as a type alias so consumers do not need to know the implementation's
// internal Layer machinery. A spawned process is always scoped.
export type ScopeRequirement = import("effect/Scope").Scope;

export class Process extends Context.Service<Process, ProcessService>()("key-ferry/Process") {}

const defaultMaxBytes = 1024 * 1024;
const defaultGraceMs = 500;
const supportsOwnedProcessGroups = process.platform === "darwin" || process.platform === "linux";

const safeMessage = (phase: ProcessPhase, code: ProcessError["code"]): string =>
  `${phase} failed (${code})`;

const error = (
  phase: ProcessPhase,
  code: ProcessError["code"],
  extra: Partial<Pick<ProcessError, "exitCode" | "signal">> = {},
) => new ProcessError({ phase, code, message: safeMessage(phase, code), ...extra });

type OwnedProcess = {
  readonly child: ChildProcess;
  groupId: number | undefined;
  owned: boolean;
};

const leaderIsAlive = (owned: OwnedProcess) =>
  owned.child.exitCode === null && owned.child.signalCode === null;

const signalOwned = (owned: OwnedProcess, value: NodeJS.Signals) => {
  // A numeric process-group id is only usable while the leader is alive. Once
  // it exits, the id can eventually be reused by an unrelated group and Node
  // has no portable primitive that proves group identity.
  if (!owned.owned || !leaderIsAlive(owned)) {
    owned.owned = false;
    return;
  }
  try {
    if (owned.groupId !== undefined) process.kill(-owned.groupId, value);
    else owned.child.kill(value);
  } catch {
    // The leader/group may have exited between the check and signal.
  }
};

/**
 * Terminate one owned leader and, while ownership is still valid, its group.
 * The returned promise owns every timer and listener and always settles within
 * the reap deadline. Natural leader exit revokes group ownership; descendants
 * that create their own group cannot be safely identified after that point.
 */
const terminateOwned = (owned: OwnedProcess, graceMs: number): Promise<void> =>
  new Promise((resolve) => {
    let settled = false;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    let reapTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (graceTimer) clearTimeout(graceTimer);
      if (reapTimer) clearTimeout(reapTimer);
      owned.child.removeListener("exit", onExit);
      owned.child.removeListener("close", onClose);
      resolve();
    };
    const onExit = () => {
      owned.owned = false;
      finish();
    };
    const onClose = () => finish();
    owned.child.once("exit", onExit);
    owned.child.once("close", onClose);
    if (!leaderIsAlive(owned)) {
      owned.owned = false;
      finish();
      return;
    }
    signalOwned(owned, "SIGTERM");
    graceTimer = setTimeout(
      () => {
        if (!leaderIsAlive(owned)) {
          owned.owned = false;
          finish();
          return;
        }
        signalOwned(owned, "SIGKILL");
        // SIGKILL should reap the leader promptly, but do not keep a scope alive
        // forever if the runtime fails to report close.
        reapTimer = setTimeout(finish, 1000);
      },
      Math.max(0, graceMs),
    );
  });

const spawnRaw = (
  input: SpawnInput,
  spawnProcess: typeof spawn = spawn,
): Effect.Effect<ManagedProcess, ProcessError, ScopeRequirement> =>
  Effect.acquireRelease(
    Effect.callback<ManagedProcess, ProcessError>((resume, abortSignal) => {
      let child: ChildProcess;
      let acquired = false;
      let acquisitionFailed = false;
      let stopping: Promise<void> | undefined;
      try {
        // shell is intentionally absent. Never inherit or mutate global env.
        child = spawnProcess(input.executable, [...input.args], {
          cwd: input.cwd,
          // An omitted environment is intentionally isolated. Callers that
          // need the trusted Varlock resolver environment must pass it
          // deliberately; never inherit the host process environment.
          env: input.env ? { ...input.env } : {},
          shell: false,
          detached: supportsOwnedProcessGroups,
          stdio: ["ignore", "ignore", "ignore"],
        });
      } catch {
        resume(Effect.fail(error("spawn", "spawn-failed")));
        return;
      }
      const owned: OwnedProcess = {
        child,
        // Until the `spawn` event, never use a numeric group id. If
        // acquisition is interrupted in this window, only direct-child
        // termination is safe.
        groupId: undefined,
        owned: true,
      };
      type Completion =
        | { readonly ok: true; readonly value: ProcessExit }
        | { readonly ok: false; readonly error: ProcessError };
      let complete!: (value: Completion) => void;
      const completionResult = new Promise<Completion>((resolve) => (complete = resolve));
      const onCompletionError = () => complete({ ok: false, error: error("running", "io") });
      const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
        child.removeListener("error", onCompletionError);
        complete(
          code === 0
            ? { ok: true, value: { code, signal } }
            : {
                ok: false,
                error: error("exit", code === null ? "signal" : "non-zero", {
                  exitCode: code ?? undefined,
                  signal: signal ?? undefined,
                }),
              },
        );
      };
      const onSpawnError = () => {
        acquisitionFailed = true;
        child.removeListener("spawn", onSpawn);
        child.removeListener("error", onSpawnError);
        resume(Effect.fail(error("spawn", "spawn-failed")));
      };
      const onSpawn = () => {
        child.removeListener("error", onSpawnError);
        owned.groupId = supportsOwnedProcessGroups ? child.pid : undefined;
        owned.owned = true;
        child.once("close", onClose);
        child.once("error", onCompletionError);
        const completion = Effect.promise(() => completionResult).pipe(
          Effect.flatMap((result) =>
            result.ok ? Effect.succeed(result.value) : Effect.fail(result.error),
          ),
        );
        let stopped = false;
        const stop = Effect.suspend(() => {
          if (stopped) return Effect.void;
          // All callers join one bounded cleanup promise. The promise owns its
          // timers, and uninterruptible prevents a canceled stop from leaving
          // the leader or its still-owned group behind.
          stopping ??= terminateOwned(owned, input.terminateGraceMs ?? defaultGraceMs);
          return Effect.uninterruptible(Effect.promise(() => stopping!)).pipe(
            Effect.tap(() => Effect.sync(() => (stopped = true))),
          );
        });
        acquired = true;
        resume(
          Effect.succeed({
            pid: child.pid!,
            completion,
            health: Effect.sync(() => ({
              pid: child.pid!,
              running: child.exitCode === null && child.signalCode === null,
              exit:
                child.exitCode !== null || child.signalCode !== null
                  ? { code: child.exitCode, signal: child.signalCode }
                  : undefined,
            })),
            stop,
          }),
        );
      };
      // Install both listeners before returning from the callback. A failed
      // async spawn is therefore converted to ProcessError, never an emitter
      // event with no listener or a handle with an undefined pid.
      child.once("spawn", onSpawn);
      child.once("error", onSpawnError);
      const acquisitionCleanup = () => {
        if (acquired || acquisitionFailed) return Promise.resolve();
        stopping ??= terminateOwned(owned, input.terminateGraceMs ?? defaultGraceMs);
        return stopping;
      };
      const onAbort = () => {
        void acquisitionCleanup();
      };
      abortSignal.addEventListener("abort", onAbort, { once: true });
      return Effect.promise(acquisitionCleanup).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            child.removeListener("spawn", onSpawn);
            child.removeListener("error", onSpawnError);
            abortSignal.removeEventListener("abort", onAbort);
          }),
        ),
      );
    }),
    (process) => process.stop.pipe(Effect.catch(() => Effect.void)),
    { interruptible: true },
  );

const run = (input: RunInput): Effect.Effect<RunResult, ProcessError> => {
  const maxBytes = input.maxBytes ?? defaultMaxBytes;
  const spawned = Effect.callback<RunResult, ProcessError>((resume, abortSignal) => {
    let child: ChildProcess;
    try {
      child = spawn(input.executable, [...input.args], {
        cwd: input.cwd,
        env: input.env ? { ...input.env } : {},
        shell: false,
        detached: supportsOwnedProcessGroups,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      resume(Effect.fail(error("spawn", "spawn-failed")));
      return;
    }
    const owned: OwnedProcess = {
      child,
      groupId: supportsOwnedProcessGroups ? child.pid : undefined,
      owned: true,
    };
    let stdout = "";
    let stderr = "";
    let limited = false;
    let settled = false;
    let stopping: Promise<void> | undefined;
    let closeFallback: ReturnType<typeof setTimeout> | undefined;
    const out = (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (Buffer.byteLength(stdout) > maxBytes && !limited) {
        limited = true;
        beginTermination().then(() => finishFailure(error("capture-limit", "capture-limit")));
      }
    };
    const err = (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (Buffer.byteLength(stderr) > maxBytes && !limited) {
        limited = true;
        beginTermination().then(() => finishFailure(error("capture-limit", "capture-limit")));
      }
    };
    const cleanup = () => {
      if (closeFallback) clearTimeout(closeFallback);
      child.stdout?.removeListener("data", out);
      child.stderr?.removeListener("data", err);
      child.removeListener("exit", onExit);
      child.removeListener("close", onClose);
      child.removeListener("error", onError);
    };
    const finishFailure = (failure: ProcessError) => {
      if (settled) return;
      settled = true;
      cleanup();
      child.stdout?.destroy();
      child.stderr?.destroy();
      resume(Effect.fail(failure));
    };
    const closeResult = (code: number | null, sig: NodeJS.Signals | null) => {
      if (limited) return Effect.fail(error("capture-limit", "capture-limit"));
      if (code === 0) return Effect.succeed({ code, signal: sig, stdout, stderr });
      return Effect.fail(
        error("exit", code === null ? "signal" : "non-zero", {
          exitCode: code ?? undefined,
          signal: sig ?? undefined,
        }),
      );
    };
    const finishClose = (code: number | null, sig: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      resume(closeResult(code, sig));
    };
    const beginTermination = () => {
      stopping ??= terminateOwned(owned, defaultGraceMs);
      return stopping;
    };
    const onExit = () => {
      // Once the leader exits, revoke the numeric group lease. Node cannot
      // prove that a later process with the same id is ours. Descendants that
      // retain stdio are allowed only a bounded close window; they are not
      // signaled after this point because that would risk killing a reused id.
      owned.owned = false;
      closeFallback ??= setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finishClose(child.exitCode, child.signalCode);
      }, 1000);
    };
    const onClose = (code: number | null, sig: NodeJS.Signals | null) => finishClose(code, sig);
    const onError = () => {
      beginTermination().then(() => finishFailure(error("running", "io")));
    };
    child.stdout?.on("data", out);
    child.stderr?.on("data", err);
    child.once("exit", onExit);
    child.once("close", onClose);
    child.once("error", onError);
    abortSignal.addEventListener(
      "abort",
      () => {
        beginTermination().then(() => {
          if (!settled) {
            settled = true;
            cleanup();
            child.stdout?.destroy();
            child.stderr?.destroy();
          }
        });
      },
      { once: true },
    );
    return Effect.uninterruptible(
      Effect.promise(() => stopping ?? Promise.resolve()).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            cleanup();
            child.stdout?.destroy();
            child.stderr?.destroy();
          }),
        ),
      ),
    );
  });
  const bounded =
    input.timeoutMs === undefined
      ? spawned
      : spawned.pipe(
          Effect.timeoutOrElse({
            duration: Duration.millis(input.timeoutMs),
            orElse: () => Effect.fail(error("timeout", "timeout")),
          }),
        );
  return bounded;
};

const makeProcessLive = (spawnProcess: typeof spawn = spawn) =>
  Layer.succeed(Process, Process.of({ run, spawn: (input) => spawnRaw(input, spawnProcess) }));

export const ProcessLive = makeProcessLive();

/** @internal Test-only seam; not exported from the package entrypoints. */
export const ProcessLiveForTesting = (spawnProcess: typeof spawn) => makeProcessLive(spawnProcess);
