import { Effect, Scope } from "effect"
import { isIP } from "node:net"
import { readFileSync } from "node:fs"
import type { ServerProtection } from "./options.js"

/** Must stay in sync with the standalone relay implementation. */
export const RELAY_AUTH_HEADER = "x-varlock-relay-token"

export interface RemoteRelayConfig {
  readonly upstreamUrl: string
  readonly proxyUrl: string
  readonly managerCaPem: string
  readonly placeholderHeaders: Readonly<Record<string, string>>
  readonly oauth: false
  readonly maxRequestBytes?: number
  readonly connectTimeoutMs?: number
  readonly idleTimeoutMs?: number
  readonly maxConnections?: number
}

export interface RemoteRelayHealth {
  readonly listening: boolean
  readonly activeRequests: number
  readonly localUrl: string
}

export interface RemoteRelayHandle {
  readonly localUrl: string
  /** Internal capability. Never expose this in status, RPC, logs, or TUI. */
  readonly downstreamToken: string
  readonly health: Effect.Effect<RemoteRelayHealth, unknown>
  readonly stop: Effect.Effect<void, unknown>
}

export type RemoteRelayFactory = (
  config: RemoteRelayConfig,
) => Effect.Effect<RemoteRelayHandle, unknown, Scope.Scope>

export interface RemoteServerSnapshot {
  readonly type: "remote"
  readonly url: string
  readonly headers?: Readonly<Record<string, string>>
  readonly oauth?: unknown
  readonly disabled?: boolean
  readonly codemode?: boolean
  readonly timeout?: unknown
  readonly protocol?: unknown
}

export interface RemoteDiagnostic {
  readonly code:
    | "remote_unavailable"
    | "remote_invalid_url"
    | "remote_oauth_required"
    | "remote_missing_placeholder"
    | "remote_invalid_header"
    | "remote_relay_failed"
  readonly server: string
  readonly message: string
}

const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade", "host", "content-length",
])
const MCP_PROTOCOL_HEADERS = new Set([
  "accept", "content-type", "mcp-session-id", "mcp-protocol-version", "last-event-id", "origin",
])
const CREDENTIAL_HEADERS = new Set(["authorization", "cookie", "proxy-authorization"])
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/

const diagnostic = (server: string, code: RemoteDiagnostic["code"], message: string): RemoteDiagnostic => ({ server, code, message })

export function isRemoteProtection(value: ServerProtection): value is Extract<ServerProtection, { readonly remote: unknown }> {
  return "remote" in value
}

export function sourceEnvironmentKeys(mapping: ServerProtection): readonly string[] {
  if (!isRemoteProtection(mapping)) return Object.values(mapping)
  return Object.values(mapping.remote.headers).map((value) => typeof value === "string" ? value : value.env)
}

export function validateRemoteUrl(value: string, allowPrivateNetwork = false): URL {
  let url: URL
  try { url = new URL(value) } catch { throw new TypeError("remote MCP URL is invalid") }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new TypeError("remote MCP URL must be HTTPS without credentials or fragments")
  }
  if (!allowPrivateNetwork && unsafeNetworkHost(url.hostname)) {
    throw new TypeError("remote MCP URL targets a local or private network; set allowPrivateNetwork to opt in")
  }
  return url
}

function unsafeNetworkHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "")
  if (host === "localhost" || host.endsWith(".localhost") || host === "0.0.0.0") return true
  const version = isIP(host)
  if (version === 6) return host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:")
  if (version !== 4) return false
  const octets = host.split(".").map(Number)
  const [a, b] = octets
  return a === 10 || a === 127 || a === 169 && b === 254 || a === 192 && b === 168
    || a === 172 && b >= 16 && b <= 31
}

function mappingHeaderNames(mapping: Extract<ServerProtection, { readonly remote: unknown }>): Set<string> {
  return new Set(Object.keys(mapping.remote.headers).map((name) => name.toLowerCase()))
}

/** Remove mapped and dangerous configured headers from the native loopback config. */
export function safeForwardHeaders(
  headers: Readonly<Record<string, string>> | undefined,
  mapping: Extract<ServerProtection, { readonly remote: unknown }>,
): Readonly<Record<string, string>> | undefined {
  const mapped = mappingHeaderNames(mapping)
  const result: Record<string, string> = Object.create(null) as Record<string, string>
  for (const [name, value] of Object.entries(headers ?? {})) {
    const lower = name.toLowerCase()
    if (!HEADER_NAME.test(name) || name === "__proto__" || name === "prototype" || name === "constructor" || HOP_BY_HOP.has(lower) || MCP_PROTOCOL_HEADERS.has(lower)) return undefined
    if (mapped.has(lower)) continue
    if (CREDENTIAL_HEADERS.has(lower) || /[\r\n\0]/.test(value)) return undefined
    result[name] = value
  }
  return result
}

function placeholderHeaders(
  mapping: Extract<ServerProtection, { readonly remote: unknown }>,
  environment: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const result: Record<string, string> = Object.create(null) as Record<string, string>
  for (const [header, raw] of Object.entries(mapping.remote.headers)) {
    const value = typeof raw === "string" ? { env: raw } : raw
    const placeholder = environment[value.env]
    if (placeholder === undefined) throw new Error("missing placeholder")
    result[header] = `${value.prefix ?? ""}${placeholder}${value.suffix ?? ""}`
  }
  return result
}

function readProxyAndCa(environment: Readonly<Record<string, string>>): { proxyUrl: string; caPem: string } {
  const proxyUrl = environment.HTTPS_PROXY ?? environment.https_proxy ?? environment.HTTP_PROXY ?? environment.http_proxy
  const caPath = environment.NODE_EXTRA_CA_CERTS
  if (!proxyUrl || !caPath || !caPath.startsWith("/")) throw new Error("missing Varlock proxy wiring")
  const caPem = readFileSync(caPath, "utf8")
  if (caPem.length === 0 || caPem.length > 2 * 1024 * 1024 || !caPem.includes("-----BEGIN CERTIFICATE-----")) {
    throw new Error("invalid Varlock CA certificate")
  }
  return { proxyUrl, caPem }
}

export interface RemoteRelayCoordinator {
  readonly handles: ReadonlyMap<string, RemoteRelayHandle>
  readonly diagnostics: readonly RemoteDiagnostic[]
  readonly reconcile: (
    servers: ReadonlyMap<string, RemoteServerSnapshot>,
    mappings: Readonly<Record<string, ServerProtection>>,
    environment: Readonly<Record<string, string>>,
    generation: number,
  ) => Effect.Effect<void, never, Scope.Scope>
  readonly health: Effect.Effect<boolean>
  readonly stopAll: Effect.Effect<void>
}

/** Coordinates relay replacement without exposing relay tokens or secrets. */
export function makeRemoteRelayCoordinator(
  factory: RemoteRelayFactory | undefined,
  allowPrivateNetwork = false,
): RemoteRelayCoordinator {
  const active = new Map<string, { handle: RemoteRelayHandle; generation: number }>()
  let currentDiagnostics: readonly RemoteDiagnostic[] = []
  const stop = (handle: RemoteRelayHandle) => handle.stop.pipe(Effect.catch(() => Effect.void))

  const reconcile = (
    servers: ReadonlyMap<string, RemoteServerSnapshot>,
    mappings: Readonly<Record<string, ServerProtection>>,
    environment: Readonly<Record<string, string>>,
    generation: number,
  ) => Effect.gen(function* () {
    const nextDiagnostics: RemoteDiagnostic[] = []
    for (const [name, mapping] of Object.entries(mappings)) {
      if (!isRemoteProtection(mapping)) continue
      const server = servers.get(name)
      const old = active.get(name)
      if (!server || server.disabled === true) {
        if (old) { yield* stop(old.handle); active.delete(name) }
        if (!server) nextDiagnostics.push(diagnostic(name, "remote_unavailable", "selected remote MCP server is not configured"))
        continue
      }
      if (!factory) {
        if (old) { yield* stop(old.handle); active.delete(name) }
        nextDiagnostics.push(diagnostic(name, "remote_unavailable", "remote protection is unavailable in this plugin runtime"))
        continue
      }
      if (server.oauth !== false) {
        if (old) { yield* stop(old.handle); active.delete(name) }
        nextDiagnostics.push(diagnostic(name, "remote_oauth_required", "set oauth:false for API-key relay mode, or remove this Varlock mapping to keep native OAuth"))
        continue
      }
      let upstream: URL
      let wiring: { proxyUrl: string; caPem: string }
      let placeholders: Readonly<Record<string, string>>
      let forwarded: Readonly<Record<string, string>> | undefined
      try {
        upstream = validateRemoteUrl(server.url, allowPrivateNetwork)
        wiring = readProxyAndCa(environment)
        placeholders = placeholderHeaders(mapping, environment)
        forwarded = safeForwardHeaders(server.headers, mapping)
        if (forwarded === undefined) throw new Error("invalid remote header")
      } catch (error) {
        if (old) { yield* stop(old.handle); active.delete(name) }
        const message = error instanceof Error && error.message === "missing placeholder"
          ? "a mapped placeholder is unavailable"
          : error instanceof Error && error.message === "invalid remote header"
            ? "remote headers contain an unsafe or malformed field"
            : error instanceof Error && error.message.includes("remote MCP URL")
              ? error.message
              : "Varlock proxy wiring is unavailable"
        nextDiagnostics.push(diagnostic(name, message === "a mapped placeholder is unavailable" ? "remote_missing_placeholder" : message.startsWith("remote MCP URL") ? "remote_invalid_url" : message === "remote headers contain an unsafe or malformed field" ? "remote_invalid_header" : "remote_relay_failed", message))
        continue
      }
      if (old && old.generation === generation) continue
      if (old) { yield* stop(old.handle); active.delete(name) }
      const started = yield* factory({
        upstreamUrl: upstream.toString(),
        proxyUrl: wiring.proxyUrl,
        managerCaPem: wiring.caPem,
        placeholderHeaders: placeholders,
        oauth: false,
      }).pipe(
        Effect.map((handle) => ({ ok: true as const, handle })),
        Effect.catch(() => Effect.succeed({ ok: false as const })),
      )
      if (started.ok) active.set(name, { handle: started.handle, generation })
      else nextDiagnostics.push(diagnostic(name, "remote_relay_failed", "remote relay could not start"))
    }
    currentDiagnostics = nextDiagnostics
  })

  return {
    get handles() { return new Map([...active].map(([name, record]) => [name, record.handle])) },
    get diagnostics() { return currentDiagnostics },
    reconcile,
    get health() {
      return Effect.suspend(() => Effect.forEach([...active.values()], (record) => record.handle.health.pipe(Effect.map((value) => value.listening), Effect.catch(() => Effect.succeed(false))), { concurrency: "unbounded" }).pipe(Effect.map((values) => values.every(Boolean))))
    },
    stopAll: Effect.suspend(() => Effect.forEach([...active.values()], (record) => stop(record.handle), { concurrency: "unbounded" }).pipe(Effect.tap(() => Effect.sync(() => active.clear())))),
  }
}
