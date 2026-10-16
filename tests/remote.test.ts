import { afterAll, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  makeRemoteRelayCoordinator,
  RELAY_AUTH_HEADER,
  safeForwardHeaders,
  validateRemoteUrl,
  type RemoteRelayConfig,
  type RemoteRelayHandle,
} from "../src/remote.js"
import { parseOptions } from "../src/options.js"

const caDir = mkdtempSync(join(tmpdir(), "key-ferry-remote-"))
const caPath = join(caDir, "ca-cert.pem")
writeFileSync(caPath, "-----BEGIN CERTIFICATE-----\nsynthetic\n-----END CERTIFICATE-----\n")

const environment = {
  HTTPS_PROXY: "http://127.0.0.1:43210",
  NODE_EXTRA_CA_CERTS: caPath,
  REMOTE_API_KEY: "placeholder-api-key",
  REMOTE_TENANT: "tenant-placeholder",
}

const server = (overrides: Record<string, unknown> = {}) => ({
  type: "remote" as const,
  url: "https://mcp.example.test/mcp",
  oauth: false as const,
  headers: { "X-Trace": "trace-id" },
  ...overrides,
})

const fakeRelay = (started: RemoteRelayConfig[], stopped: string[]) => (config: RemoteRelayConfig) => {
  started.push(config)
  const token = `token-${started.length}`
  const handle: RemoteRelayHandle = {
    localUrl: `http://127.0.0.1:${4000 + started.length}`,
    downstreamToken: token,
    health: Effect.succeed({ listening: true, activeRequests: 0, localUrl: `http://127.0.0.1:${4000 + started.length}` }),
    stop: Effect.sync(() => { stopped.push(token) }),
  }
  return Effect.succeed(handle)
}

describe("remote adapter contract", () => {
  test("validates HTTPS targets without banning corporate DNS names", () => {
    expect(validateRemoteUrl("https://mcp.example.test/mcp").origin).toBe("https://mcp.example.test")
    expect(() => validateRemoteUrl("http://mcp.example.test/mcp")).toThrow()
    expect(() => validateRemoteUrl("https://user:pass@mcp.example.test/mcp")).toThrow()
    expect(() => validateRemoteUrl("https://127.0.0.1/mcp")).toThrow()
    expect(validateRemoteUrl("https://127.0.0.1/mcp", true).hostname).toBe("127.0.0.1")
  })

  test("starts a relay with placeholder headers and preserves safe custom headers", async () => {
    const started: RemoteRelayConfig[] = []
    const stopped: string[] = []
    const coordinator = makeRemoteRelayCoordinator(fakeRelay(started, stopped), true)
    const options = parseOptions({ servers: {
      remote: { remote: { headers: {
        Authorization: { env: "REMOTE_API_KEY", prefix: "Bearer " },
        "X-Tenant": "REMOTE_TENANT",
      } } },
    } }, "/project")

    await Effect.runPromise(Effect.scoped(coordinator.reconcile(
      new Map([["remote", server()]]),
      options.adapter.servers,
      environment,
      1,
    )))

    expect(started).toHaveLength(1)
    expect(started[0]?.oauth).toBe(false)
    expect(started[0]?.placeholderHeaders).toEqual({
      Authorization: "Bearer placeholder-api-key",
      "X-Tenant": "tenant-placeholder",
    })
    expect(safeForwardHeaders(server().headers, options.adapter.servers.remote as any)).toEqual({ "X-Trace": "trace-id" })
    expect(JSON.stringify(coordinator.diagnostics)).not.toContain("token-")
    expect(RELAY_AUTH_HEADER).toBe("x-varlock-relay-token")
  })

  test("requires explicit oauth:false and fails closed without direct fallback", async () => {
    const started: RemoteRelayConfig[] = []
    const coordinator = makeRemoteRelayCoordinator(fakeRelay(started, []), true)
    const options = parseOptions({ servers: {
      remote: { remote: { headers: { Authorization: "REMOTE_API_KEY" } } },
    } }, "/project")

    await Effect.runPromise(Effect.scoped(coordinator.reconcile(
      new Map([["remote", server({ oauth: undefined })]]),
      options.adapter.servers,
      environment,
      1,
    )))

    expect(started).toHaveLength(0)
    expect(coordinator.diagnostics[0]?.code).toBe("remote_oauth_required")
    expect(coordinator.diagnostics[0]?.message).toContain("oauth:false")
  })

  test("stops old generation before replacing relay and never exposes tokens", async () => {
    const started: RemoteRelayConfig[] = []
    const stopped: string[] = []
    const coordinator = makeRemoteRelayCoordinator(fakeRelay(started, stopped), true)
    const options = parseOptions({ servers: {
      remote: { remote: { headers: { Authorization: "REMOTE_API_KEY" } } },
    } }, "/project")
    const configs = new Map([["remote", server()]])
    await Effect.runPromise(Effect.scoped(coordinator.reconcile(configs, options.adapter.servers, environment, 1)))
    await Effect.runPromise(Effect.scoped(coordinator.reconcile(configs, options.adapter.servers, environment, 2)))

    expect(started).toHaveLength(2)
    expect(stopped).toEqual(["token-1"])
    expect(JSON.stringify(coordinator.diagnostics)).not.toContain("token-2")
  })

  test("rejects unsafe configured headers", () => {
    const mapping = parseOptions({ servers: {
      remote: { remote: { headers: { Authorization: "REMOTE_API_KEY" } } },
    } }, "/project").adapter.servers.remote as any
    expect(safeForwardHeaders({ Cookie: "raw-secret" }, mapping)).toBeUndefined()
    expect(safeForwardHeaders({ Connection: "keep-alive" }, mapping)).toBeUndefined()
  })
})

afterAll(() => {
  rmSync(caDir, { recursive: true, force: true })
})
