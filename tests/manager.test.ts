import assert from "node:assert/strict"
import test from "node:test"
import { chmodSync, mkdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs"
import { Context, Effect, Layer } from "effect"
import { ProjectKeyFerryManager, VarlockError, projectDirectory } from "../src/contracts.js"
import { Process, ProcessError, type ManagedProcess, type ProcessExit, type ProcessService, type RunInput, type RunResult, type SpawnInput } from "../src/services/process.js"
import { makeProjectKeyFerryManager } from "../src/varlock/manager.js"

const proxyEnv = {
  HTTP_PROXY: "http://127.0.0.1:43821",
  HTTPS_PROXY: "http://127.0.0.1:43821",
  NODE_EXTRA_CA_CERTS: "/tmp/varlock/ca-cert.pem",
  OPENAI_API_KEY: "sk-placeholder",
}
const fixtureProject = process.cwd()

type Fake = {
  readonly service: ProcessService
  readonly starts: number[]
  readonly stops: number[]
  readonly runs: string[][]
  alive: boolean
  reloadFails: boolean
  strict: boolean
  certMode: number
  certKind: "owned" | "outside" | "symlink"
}

function fakeProcess(): Fake {
  const state: Fake = {} as Fake
  state.starts = []; state.stops = []; state.runs = []; state.alive = true; state.reloadFails = false; state.strict = true; state.certMode = 0o600; state.certKind = "owned"
  const exit: ProcessExit = { code: null, signal: null }
  let certPath = "/tmp/varlock/ca-cert.pem"
  const managed = (input: SpawnInput): ManagedProcess => ({
    pid: 9001,
    completion: Effect.never,
    health: Effect.sync(() => ({ pid: 9001, running: state.alive, ...(state.alive ? {} : { exit }) })),
    stop: Effect.sync(() => { state.stops.push(9001); state.alive = false }),
  })
  state.service = {
    spawn: (input: SpawnInput) => Effect.sync(() => {
      state.starts.push(9001)
      const index = input.args.indexOf("--cert-dir")
      const certDir = index >= 0 ? input.args[index + 1] : undefined
      if (certDir) {
        certPath = `${certDir}/ca-cert.pem`
        mkdirSync(certDir, { recursive: true, mode: 0o700 })
        const outsidePath = `/tmp/key-ferry-external-cert-${process.pid}.pem`
        if (state.certKind === "outside") {
          certPath = outsidePath
          writeFileSync(certPath, "fixture", { mode: state.certMode })
          chmodSync(certPath, state.certMode)
        } else if (state.certKind === "symlink") {
          writeFileSync(outsidePath, "fixture", { mode: state.certMode })
          chmodSync(outsidePath, state.certMode)
          symlinkSync(outsidePath, certPath)
        } else {
          writeFileSync(certPath, "fixture", { mode: state.certMode })
          chmodSync(certPath, state.certMode)
        }
      }
      return managed(input)
    }),
    run: (input: RunInput): Effect.Effect<RunResult, ProcessError> => {
      if (input.args.includes("proxy") && input.args.includes("reload") && state.reloadFails) {
        return Effect.fail(new ProcessError({ phase: "exit", code: "non-zero", message: "safe" }))
      }
      return Effect.sync(() => {
      state.runs.push([...input.args])
      const args = input.args.join(" ")
      if (input.args.includes("proxy") && input.args.includes("status")) {
        const record = {
          id: "abc12", uuid: "session-1", ownerPid: 9001, cwd: fixtureProject,
          startedAt: "2026-10-16T10:00:00.000Z", updatedAt: "2026-10-16T10:00:01.000Z",
          egressMode: state.strict ? "strict" : "permissive", env: { ...proxyEnv, NODE_EXTRA_CA_CERTS: certPath },
          placeholderOverrides: { OPENAI_API_KEY: "sk-placeholder" },
          endpointToken: "CONTROL_CANARY", dataPlaneToken: "DATA_CANARY",
        }
        return { code: 0, signal: null, stdout: JSON.stringify([record]), stderr: "banner must not be parsed" }
      }
      if (args.includes("proxy env")) return { code: 0, signal: null, stdout: JSON.stringify({ ...proxyEnv, NODE_EXTRA_CA_CERTS: certPath }), stderr: "" }
      return { code: 0, signal: null, stdout: "", stderr: "" }
      })
    },
  }
  return state
}

function layer(fake: Fake, extra: Record<string, unknown> = {}) {
  return makeProjectKeyFerryManager({
    projectDirectory: projectDirectory(fixtureProject),
    adapter: { environmentKeys: ["OPENAI_API_KEY"], startupTimeoutMs: 500, pollIntervalMs: 10, ...extra },
  }, Layer.succeed(Process, Process.of(fake.service)))
}

async function inManager<A>(fake: Fake, effect: (manager: ProjectKeyFerryManager["Service"]) => Effect.Effect<A, VarlockError>) {
  const program = Effect.gen(function* () {
    const manager = yield* ProjectKeyFerryManager
    return yield* effect(manager)
  }).pipe(Effect.provide(layer(fake)))
  return Effect.runPromise(Effect.scoped(program))
}

test("starts lazily, returns only placeholder-backed requested keys, and disposes its child", async () => {
  const fake = fakeProcess()
  const result = await inManager(fake, (manager) => Effect.gen(function* () {
    const before = yield* manager.status
    const ready = yield* manager.ensureStarted
    const env = yield* manager.environment
    yield* manager.dispose
    return { before, ready, env }
  }))
  assert.equal(result.before.phase, "stopped")
  assert.equal(result.ready.phase, "ready")
  assert.equal(result.env.OPENAI_API_KEY, "sk-placeholder")
  assert.equal(result.env.HTTPS_PROXY, "http://127.0.0.1:43821")
  assert.equal("endpointToken" in result.env, false)
  assert.deepEqual(fake.starts, [9001])
  assert.deepEqual(fake.stops, [9001])
})

test("accepts a Varlock public CA certificate with mode 0644", async () => {
  const fake = fakeProcess(); fake.certMode = 0o644
  const status = await inManager(fake, (manager) => manager.ensureStarted)
  assert.equal(status.phase, "ready")
})

test("rejects writable CA certificates but retains containment checks", async () => {
  for (const mode of [0o664, 0o666]) {
    const fake = fakeProcess(); fake.certMode = mode
    await assert.rejects(inManager(fake, (manager) => manager.ensureStarted), (error: unknown) => error instanceof VarlockError && error.code === "protocol_error")
    assert.deepEqual(fake.stops, [9001])
  }
  for (const kind of ["outside", "symlink"] as const) {
    const fake = fakeProcess(); fake.certKind = kind
    await assert.rejects(inManager(fake, (manager) => manager.ensureStarted), (error: unknown) => error instanceof VarlockError && error.code === "protocol_error")
    unlinkSync(`/tmp/key-ferry-external-cert-${process.pid}.pem`)
  }
})

test("rejects permissive egress and cleans up the owned process", async () => {
  const fake = fakeProcess(); fake.strict = false
  await assert.rejects(inManager(fake, (manager) => manager.ensureStarted), (error: unknown) => error instanceof VarlockError && error.code === "invalid_config")
  assert.deepEqual(fake.stops, [9001])
})

test("does not adopt another PID/session and reports startup timeout safely", async () => {
  const fake = fakeProcess()
  fake.service.run = (input: RunInput) => Effect.sync(() => ({
    code: 0, signal: null,
    stdout: input.args.includes("proxy") && input.args.includes("status") ? "[]" : JSON.stringify(proxyEnv), stderr: "raw-secret-canary",
  }))
  await assert.rejects(inManager(fake, (manager) => manager.ensureStarted), (error: unknown) => error instanceof VarlockError && error.code === "timeout" )
  assert.equal(fake.stops.length, 1)
})

test("refresh failure closes the environment capability and increments generation", async () => {
  const fake = fakeProcess()
  const result = await inManager(fake, (manager) => Effect.gen(function* () {
    yield* manager.ensureStarted
    const before = yield* manager.status
    fake.reloadFails = true
    const failure = yield* manager.refresh.pipe(Effect.flip)
    const after = yield* manager.status
    const closed = yield* manager.environment.pipe(Effect.flip)
    return { before, failure, after, closed }
  }))
  assert.equal(result.failure.code, "refresh_failed")
  assert.equal(result.after.phase, "failed")
  assert.ok(result.after.generation > result.before.generation)
  assert.equal(result.closed.code, "not_ready")
})

test("serializes concurrent starts to one owned process", async () => {
  const fake = fakeProcess()
  const result = await inManager(fake, (manager) => Effect.all([manager.ensureStarted, manager.ensureStarted], { concurrency: "unbounded" }))
  assert.equal(fake.starts.length, 1)
  assert.equal(result[0].phase, "ready")
  assert.equal(result[1].phase, "ready")
})

test("unexpected process death clears readiness without throwing status", async () => {
  const fake = fakeProcess()
  const result = await inManager(fake, (manager) => Effect.gen(function* () {
    yield* manager.ensureStarted
    fake.alive = false
    const status = yield* manager.status
    return status
  }))
  assert.equal(result.phase, "degraded")
  assert.equal(result.error?.code, "unavailable")
})
