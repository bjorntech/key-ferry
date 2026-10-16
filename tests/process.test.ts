import { describe, expect, it } from "bun:test"
import { Effect, Exit, Fiber } from "effect"
import { Process, ProcessLive } from "../src/services/process"

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect.pipe(Effect.provide(ProcessLive)))
const node = process.execPath

describe("Process", () => {
  it("executes without a shell and preserves cwd and argv", async () => {
    const result = await run(Effect.gen(function* () {
      const service = yield* Process
      return yield* service.run({
        executable: node,
        args: ["-e", "process.stdout.write(JSON.stringify({cwd:process.cwd(), args:process.argv.slice(1)}))", "marker", "two words"],
        cwd: process.cwd(),
      })
    }))
    const parsed = JSON.parse(result.stdout) as { cwd: string; args: string[] }
    expect(parsed.cwd).toBe(process.cwd())
    expect(parsed.args).toEqual(["marker", "two words"])
  })

  it("does not inherit the parent environment when env is omitted", async () => {
    const key = "OPENCODE_VARLOCK_PROCESS_TEST_PARENT_SECRET"
    const previous = process.env[key]
    process.env[key] = "parent-secret-canary"
    try {
      const result = await run(Effect.gen(function* () {
        const service = yield* Process
        return yield* service.run({
          executable: node,
          args: ["-e", `process.stdout.write(process.env[${JSON.stringify(key)}] ?? "missing")`],
          cwd: process.cwd(),
        })
      }))
      expect(result.stdout).toBe("missing")
    } finally {
      if (previous === undefined) delete process.env[key]
      else process.env[key] = previous
    }
  })

  it("uses an explicitly supplied environment exactly", async () => {
    const result = await run(Effect.gen(function* () {
      const service = yield* Process
      return yield* service.run({
        executable: node,
        args: ["-e", "process.stdout.write(process.env.OPENCODE_VARLOCK_PROCESS_TEST_EXPLICIT ?? 'missing')"],
        cwd: process.cwd(),
        env: { OPENCODE_VARLOCK_PROCESS_TEST_EXPLICIT: "explicit-canary" },
      })
    }))
    expect(result.stdout).toBe("explicit-canary")
  })

  it("sanitizes non-zero and spawn errors", async () => {
    const failed = await Effect.runPromiseExit(Effect.gen(function* () {
      const service = yield* Process
      return yield* service.run({ executable: node, args: ["-e", "process.stderr.write('secret'); process.exit(7)"], cwd: process.cwd() })
    }).pipe(Effect.provide(ProcessLive)))
    expect(Exit.isFailure(failed)).toBe(true)
    if (Exit.isFailure(failed)) {
      const cause = failed.cause
      expect(String(cause)).not.toContain("secret")
      expect(String(cause)).not.toContain(node)
    }

    const spawnFailed = await Effect.runPromiseExit(Effect.gen(function* () {
      const service = yield* Process
      return yield* service.run({ executable: "/definitely/missing/key-ferry-test", args: [], cwd: process.cwd() })
    }).pipe(Effect.provide(ProcessLive)))
    expect(Exit.isFailure(spawnFailed)).toBe(true)
    expect(String(spawnFailed)).not.toContain("definitely")
  })

  it("bounds capture for stdout and stderr", async () => {
    const result = await Effect.runPromiseExit(Effect.gen(function* () {
      const service = yield* Process
      return yield* service.run({ executable: node, args: ["-e", "process.stdout.write('x'.repeat(10000)); process.stderr.write('y'.repeat(10000))"], cwd: process.cwd(), maxBytes: 128 })
    }).pipe(Effect.provide(ProcessLive)))
    expect(Exit.isFailure(result)).toBe(true)
    expect(String(result)).not.toContain("x".repeat(100))
  })

  it("times out and terminates the child", async () => {
    const started = performance.now()
    const result = await Effect.runPromiseExit(Effect.gen(function* () {
      const service = yield* Process
      return yield* service.run({ executable: node, args: ["-e", "setInterval(() => {}, 1000)"], cwd: process.cwd(), timeoutMs: 80 })
    }).pipe(Effect.provide(ProcessLive)))
    expect(Exit.isFailure(result)).toBe(true)
    expect(performance.now() - started).toBeLessThan(2000)
  })

  it("does not orphan a SIGTERM-ignoring child when stop is interrupted", async () => {
    let pid: number | undefined
    const result = await Effect.runPromiseExit(Effect.scoped(Effect.gen(function* () {
      const service = yield* Process
      const child = yield* service.spawn({
        executable: node,
        args: ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
        cwd: process.cwd(),
        terminateGraceMs: 100,
      })
      pid = child.pid
      // Request interruption while the bounded stop is in its grace period.
      // The request must not cancel the SIGKILL fallback.
      const stopping = yield* Effect.forkScoped(child.stop)
      yield* Effect.sleep("10 millis")
      yield* Fiber.interrupt(stopping)
    }).pipe(Effect.provide(ProcessLive))))
    expect(Exit.isSuccess(result)).toBe(true)
    if (pid !== undefined) {
      await Bun.sleep(80)
      expect(() => process.kill(pid!, 0)).toThrow()
    }
  })

  it("stops a scoped process when its scope closes", async () => {
    const result = await Effect.runPromiseExit(Effect.scoped(Effect.gen(function* () {
      const service = yield* Process
      const child = yield* service.spawn({ executable: node, args: ["-e", "setInterval(() => {}, 1000)"], cwd: process.cwd(), terminateGraceMs: 50 })
      return child.pid
    }).pipe(Effect.provide(ProcessLive))))
    expect(Exit.isSuccess(result)).toBe(true)
    if (Exit.isSuccess(result)) {
      await Bun.sleep(80)
      expect(() => process.kill(result.value, 0)).toThrow()
    }
  })
})
