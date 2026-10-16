import { describe, expect, test } from "bun:test"
import { applyProtection, makePlugin } from "../src/plugin.js"
import { ProjectKeyFerryManager, projectDirectory, type SafeStatus } from "../src/contracts.js"
import type { ProjectKeyFerryManagerFactory } from "../src/contracts.js"
import type { Mcp } from "@opencode/plugin/effect"
import { Effect } from "effect"
import { RELAY_AUTH_HEADER, type RemoteRelayHandle } from "../src/remote.js"
import { parseOptions } from "../src/options.js"
import { Layer } from "effect"
import { writeFileSync } from "node:fs"

const doctorCaPath = "/tmp/key-ferry-doctor-ca.pem"
writeFileSync(doctorCaPath, "-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----\n")

const editorFor = (entries: Record<string, Mcp.ServerConfig>) => {
  const values = new Map(Object.entries(entries))
  return {
    editor: {
      list: () => [...values.entries()],
      get: (name: string) => values.get(name),
      update: (name: string, update: (config: any) => void) => {
        const current = values.get(name)
        if (!current) return
        const next = structuredClone(current)
        update(next)
        values.set(name, next)
      },
    },
    values,
  }
}

const options = {
  command: ["varlock"],
  startupTimeoutMs: 30_000,
  commandTimeoutMs: 10_000,
  reloadTimeoutMs: 30_000,
  pollIntervalMs: 100,
  allowPrivateNetwork: false,
  refreshTimeoutMs: 900_000,
  requireStrictEgress: true,
  servers: { tools: { API_KEY: "VARLOCK_API_KEY" } },
} as const

describe("local MCP protection", () => {
  test("overrides only the allowlisted key and preserves config", () => {
    const { editor, values } = editorFor({
      tools: {
        type: "local",
        command: ["node", "server.js"],
        cwd: "/project",
        environment: { LOG_LEVEL: "info", API_KEY: "ambient" },
      },
    })

    applyProtection(editor, options, { ready: true, environment: { VARLOCK_API_KEY: "resolved-secret" } })
    expect(values.get("tools")).toEqual({
      type: "local",
      command: ["node", "server.js"],
      cwd: "/project",
      environment: { LOG_LEVEL: "info", API_KEY: "resolved-secret" },
      disabled: false,
    })
  })

  test("fails closed when startup, refresh, or a requested key fails", () => {
    const { editor, values } = editorFor({
      tools: { type: "local", command: ["server"] },
    })
    applyProtection(editor, options, { ready: false, environment: {} })
    expect(values.get("tools")?.disabled).toBe(true)
    expect(values.get("tools")?.environment).toBeUndefined()
  })

  test("rejects remote isolation by disabling instead of direct fallback", () => {
    const { editor, values } = editorFor({
      tools: { type: "remote", url: "https://example.invalid/mcp" },
    })
    applyProtection(editor, options, { ready: true, environment: { VARLOCK_API_KEY: "secret" } })
    expect(values.get("tools")?.disabled).toBe(true)
  })

  test("rewrites selected API-key remotes only after a relay is ready", () => {
    const { editor, values } = editorFor({
      remote: {
        type: "remote",
        url: "https://mcp.example.test/mcp",
        oauth: false,
        headers: { "X-Trace": "trace-id" },
      },
      oauth: {
        type: "remote",
        url: "https://oauth.example.test/mcp",
      },
    })
    const parsed = parseOptions({ servers: {
      remote: { remote: { headers: { Authorization: { env: "REMOTE_API_KEY", prefix: "Bearer " } } } },
      oauth: { remote: { headers: { Authorization: "REMOTE_API_KEY" } } },
    } }, "/project")
    const handle: RemoteRelayHandle = {
      localUrl: "http://127.0.0.1:4321",
      downstreamToken: "internal-only-token",
      health: Effect.succeed({ listening: true, activeRequests: 0, localUrl: "http://127.0.0.1:4321" }),
      stop: Effect.void,
    }

    applyProtection(editor, parsed.adapter, {
      ready: true,
      environment: { REMOTE_API_KEY: "placeholder" },
      remoteHandles: new Map([["remote", handle]]),
    })

    expect(values.get("remote")).toEqual({
      type: "remote",
      url: "http://127.0.0.1:4321",
      oauth: false,
      headers: { "X-Trace": "trace-id", [RELAY_AUTH_HEADER]: "internal-only-token" },
      disabled: false,
    })
    expect(values.get("oauth")?.disabled).toBe(true)
    expect(JSON.stringify(values.get("remote"))).toContain("internal-only-token")
  })

  test("preserves an explicitly disabled remote", () => {
    const { editor, values } = editorFor({
      remote: { type: "remote", url: "https://mcp.example.test", oauth: false, disabled: true },
    })
    const parsed = parseOptions({ servers: { remote: { remote: { headers: { Authorization: "KEY" } } } } }, "/project")
    const handle: RemoteRelayHandle = {
      localUrl: "http://127.0.0.1:4321",
      downstreamToken: "token",
      health: Effect.succeed({ listening: true, activeRequests: 0, localUrl: "http://127.0.0.1:4321" }),
      stop: Effect.void,
    }
    applyProtection(editor, parsed.adapter, { ready: true, environment: { KEY: "placeholder" }, remoteHandles: new Map([["remote", handle]]) })
    expect(values.get("remote")?.disabled).toBe(true)
  })
})

describe("doctor remote relay recovery", () => {
  const readyStatus = (): SafeStatus => ({ phase: "ready", projectDirectory: projectDirectory("/project"), generation: 1 })

  const runPlugin = async (relayFailure = false) => {
    let healthy = true
    const started: string[] = []
    const stopped: string[] = []
    let relayNumber = 0
    const relayFactory = () => Effect.gen(function* () {
      relayNumber += 1
      if (relayFailure && relayNumber > 1) return yield* Effect.fail(new Error("relay unavailable"))
      const token = `doctor-token-${relayNumber}`
      started.push(token)
      return {
        localUrl: `http://127.0.0.1:${5000 + relayNumber}`,
        downstreamToken: token,
        health: Effect.sync(() => ({ listening: healthy, activeRequests: 0, localUrl: `http://127.0.0.1:${5000 + relayNumber}` })),
        stop: Effect.sync(() => { stopped.push(token) }),
      }
    })

    const base = {
      selected: { type: "remote", url: "https://mcp.example.test/mcp", oauth: false },
      disabled: { type: "remote", url: "https://disabled.example.test/mcp", oauth: false, disabled: true },
      nativeOAuth: { type: "remote", url: "https://oauth.example.test/mcp" },
    } as const
    let transform: ((editor: ReturnType<typeof editorFor>["editor"]) => void) | undefined
    let current: ReturnType<typeof editorFor>["values"] | undefined
    const runTransform = () => {
      const made = editorFor(structuredClone(base) as Record<string, Mcp.ServerConfig>)
      current = made.values
      if (transform) transform(made.editor)
    }
    let doctor: ((input: {}, context: { error: (code: string, data: unknown) => unknown }) => unknown) | undefined
    const manager = {
      status: Effect.sync(readyStatus),
      ensureStarted: Effect.sync(readyStatus),
      environment: Effect.succeed({ API_KEY: "placeholder", HTTPS_PROXY: "http://127.0.0.1:1", NODE_EXTRA_CA_CERTS: doctorCaPath }),
      refresh: Effect.sync(readyStatus),
      dispose: Effect.void,
      withExclusive: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
    }
    const factory: ProjectKeyFerryManagerFactory = { layer: () => Layer.succeed(ProjectKeyFerryManager, manager) }
    const plugin = makePlugin(factory, relayFactory as never)
    const context = {
      options: { servers: {
        selected: { remote: { headers: { Authorization: "API_KEY" } } },
        disabled: { remote: { headers: { Authorization: "API_KEY" } } },
      } },
      location: { project: { directory: "/project" } },
      mcp: {
        transform: (callback: (editor: ReturnType<typeof editorFor>["editor"]) => void) => Effect.sync(() => { transform = callback; runTransform() }),
        reload: () => Effect.sync(runTransform),
      },
      rpc: { register: (_definition: unknown, handlers: { doctor: typeof doctor }) => Effect.sync(() => { doctor = handlers.doctor as typeof doctor; return { dispose: Effect.void, events: { emit: () => Effect.void } } }) },
    } as never

    return await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      yield* plugin.effect(context)
      if (!doctor || !current) throw new Error("doctor handler was not registered")
      healthy = false
      yield* doctor({}, { error: (code, data) => ({ code, data }) }) as Effect.Effect<unknown>
      return { started, stopped, current }
    })))
  }

  test("doctor recreates a stopped relay while preserving native OAuth and explicit disablement", async () => {
    const run = await runPlugin()
    expect(run.started).toEqual(["doctor-token-1", "doctor-token-2"])
    // The coordinator must discard an unhealthy handle before reconciling.
    expect(run.stopped).toEqual(["doctor-token-1", "doctor-token-2"])
    expect(run.started).toEqual(["doctor-token-1", "doctor-token-2"])
    expect(run.current.get("selected")?.disabled).toBe(false)
    expect(run.current.get("selected")?.url).toBe("http://127.0.0.1:5002")
    expect(run.current.get("selected")?.headers?.[RELAY_AUTH_HEADER]).toBe("doctor-token-2")
    expect(run.current.get("disabled")?.disabled).toBe(true)
    expect(run.current.get("nativeOAuth")?.disabled).toBeUndefined()
    expect(JSON.stringify(run.current.get("selected"))).toContain("doctor-token-2")
  })

  test("failed doctor restart remains disabled and does not expose relay tokens", async () => {
    const run = await runPlugin(true)
    expect(run.stopped).toEqual(["doctor-token-1"])
    expect(run.started).toEqual(["doctor-token-1"])
    expect(run.current.get("selected")?.disabled).toBe(true)
    expect(run.current.get("nativeOAuth")?.disabled).toBeUndefined()
    expect(JSON.stringify(run.current)).not.toContain("doctor-token-1")
  })
})
