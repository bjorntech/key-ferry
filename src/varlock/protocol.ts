/** Pure validation for the Varlock proxy CLI protocol.
 *
 * This module deliberately does not know about process.env, subprocesses, or
 * Effect.  Treat every value passed to it as hostile CLI output.  In
 * particular, a session record is not a proof of ownership until the caller
 * supplies the PID, UUID, and project directory it created.
 */

export const PROTOCOL_LIMITS = {
  jsonBytes: 2 * 1024 * 1024,
  sessions: 128,
  mapEntries: 512,
  stringBytes: 16 * 1024,
  envKeyLength: 256,
} as const;

const SAFE_ENV_KEYS = new Set([
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "NO_PROXY",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
  "GIT_SSL_CAINFO",
  "CARGO_HTTP_CAINFO",
  "DENO_CERT",
  "NODE_USE_ENV_PROXY",
]);

const PROXY_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
] as const;

export interface VarlockSessionRecord {
  readonly id: string;
  readonly uuid: string;
  readonly ownerPid: number;
  readonly cwd: string;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly endedAt?: string;
  readonly egressMode: "permissive" | "strict";
  readonly env: Readonly<Record<string, string>>;
  readonly placeholderOverrides?: Readonly<Record<string, string>>;
}

export interface OwnedSessionIdentity {
  readonly ownerPid: number;
  readonly sessionUuid: string;
  readonly projectDirectory: string;
}

export interface ProxyWiring {
  readonly proxyUrl: string;
  readonly caPath: string;
  readonly env: Readonly<Record<string, string>>;
}

export interface SafeSessionStatus {
  readonly id: string;
  readonly uuid: string;
  readonly ownerPid: number;
  readonly cwd: string;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly egressMode: "permissive" | "strict";
  readonly proxyUrl: string;
  readonly running: boolean;
}

export class VarlockProtocolError extends Error {
  readonly code = "protocol_error" as const;

  constructor(message = "invalid Varlock protocol response") {
    // Never interpolate CLI output into this message.  Callers can safely
    // expose it in diagnostics and model-visible errors.
    super(message);
    this.name = "VarlockProtocolError";
  }
}

function fail(message: string): never {
  throw new VarlockProtocolError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, field: string, max = PROTOCOL_LIMITS.stringBytes): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > max ||
    value.includes("\0")
  ) {
    fail(`invalid Varlock ${field}`);
  }
  return value;
}

function boundedMap(value: unknown, field: string): Record<string, string> {
  if (!isRecord(value) || Object.keys(value).length > PROTOCOL_LIMITS.mapEntries)
    fail(`invalid Varlock ${field}`);
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const key of Object.keys(value)) {
    if (
      key === "__proto__" ||
      key === "prototype" ||
      key === "constructor" ||
      key.length === 0 ||
      key.length > PROTOCOL_LIMITS.envKeyLength ||
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)
    ) {
      fail(`invalid Varlock ${field}`);
    }
    result[key] = boundedString(value[key], `${field} value`);
  }
  return result;
}

function parseJson(input: string): unknown {
  if (
    typeof input !== "string" ||
    new TextEncoder().encode(input).byteLength > PROTOCOL_LIMITS.jsonBytes
  ) {
    fail("invalid Varlock JSON payload");
  }
  try {
    return JSON.parse(input) as unknown;
  } catch {
    fail("invalid Varlock JSON payload");
  }
}

function decodeSession(value: unknown): VarlockSessionRecord {
  if (!isRecord(value)) fail("invalid Varlock session record");
  const egressMode = value.egressMode;
  if (egressMode !== "permissive" && egressMode !== "strict") fail("invalid Varlock egress mode");
  if (!Number.isSafeInteger(value.ownerPid) || (value.ownerPid as number) <= 0)
    fail("invalid Varlock owner PID");
  const session: VarlockSessionRecord = {
    id: boundedString(value.id, "session id", 128),
    uuid: boundedString(value.uuid, "session UUID", 128),
    ownerPid: value.ownerPid as number,
    cwd: boundedString(value.cwd, "session cwd"),
    startedAt: boundedString(value.startedAt, "session start time", 128),
    updatedAt: boundedString(value.updatedAt, "session update time", 128),
    ...(value.endedAt !== undefined
      ? { endedAt: boundedString(value.endedAt, "session end time", 128) }
      : {}),
    egressMode,
    env: boundedMap(value.env, "session environment"),
  };
  if (value.placeholderOverrides !== undefined) {
    (session as { placeholderOverrides?: Readonly<Record<string, string>> }).placeholderOverrides =
      boundedMap(value.placeholderOverrides, "placeholder overrides");
  }
  return session;
}

/** Decode only the JSON array emitted by `varlock proxy status --format json`. */
export function decodeSessionList(input: string): readonly VarlockSessionRecord[] {
  const value = parseJson(input);
  if (!Array.isArray(value) || value.length > PROTOCOL_LIMITS.sessions)
    fail("invalid Varlock session list");
  return value.map(decodeSession);
}

/** Exact ownership match. No cwd-prefix or PID-only matching is accepted. */
export function findOwnedSession(
  sessions: readonly VarlockSessionRecord[],
  identity: OwnedSessionIdentity,
): VarlockSessionRecord | undefined {
  const directory = boundedString(identity.projectDirectory, "project directory");
  if (!Number.isSafeInteger(identity.ownerPid) || identity.ownerPid <= 0) fail("invalid owner PID");
  const uuid = boundedString(identity.sessionUuid, "session UUID", 128);
  return sessions.find(
    (session) =>
      session.ownerPid === identity.ownerPid &&
      session.uuid === uuid &&
      session.cwd === directory &&
      session.endedAt === undefined,
  );
}

function validateProxyUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    fail("invalid Varlock proxy URL");
  }
  if (
    url.protocol !== "http:" ||
    (url.hostname !== "127.0.0.1" &&
      url.hostname !== "localhost" &&
      url.hostname !== "[::1]" &&
      url.hostname !== "::1")
  ) {
    fail("Varlock proxy must use a loopback HTTP URL");
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    fail("invalid Varlock proxy URL");
  }
  const port = Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail("invalid Varlock proxy port");
  return url;
}

/** Validate wiring without returning credentials or writing ambient env state. */
export function validateProxyWiring(env: Readonly<Record<string, string>>): ProxyWiring {
  const keys = Object.keys(env);
  if (
    keys.length > PROTOCOL_LIMITS.mapEntries ||
    keys.some(
      (key) =>
        key === "__proto__" ||
        key === "prototype" ||
        key === "constructor" ||
        key.length > PROTOCOL_LIMITS.envKeyLength ||
        !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key),
    )
  )
    fail("invalid Varlock proxy environment");
  const https = env.HTTPS_PROXY ?? env.https_proxy;
  const http = env.HTTP_PROXY ?? env.http_proxy;
  if (!https || !http) fail("Varlock proxy environment is incomplete");
  const proxyUrl = validateProxyUrl(https);
  if (validateProxyUrl(http).origin !== proxyUrl.origin) fail("Varlock proxy URLs do not match");
  for (const key of PROXY_KEYS) {
    if (env[key] !== undefined && validateProxyUrl(env[key]).origin !== proxyUrl.origin)
      fail("Varlock proxy URLs do not match");
  }
  const caPath = env.NODE_EXTRA_CA_CERTS;
  if (
    !caPath ||
    !caPath.startsWith("/") ||
    caPath.length > PROTOCOL_LIMITS.stringBytes ||
    caPath.endsWith("/")
  ) {
    fail("invalid Varlock CA certificate path");
  }
  if (caPath.split("/").includes("..") || caPath.split("/").includes("."))
    fail("invalid Varlock CA certificate path");
  if (!caPath.endsWith("/ca-cert.pem")) fail("invalid Varlock CA certificate path");
  // Session env contains the child view as well as wiring.  Return only the
  // documented wiring allowlist, never arbitrary child keys or credentials.
  const wiringEnv: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const key of keys) if (SAFE_ENV_KEYS.has(key)) wiringEnv[key] = env[key]!;
  return { proxyUrl: proxyUrl.origin, caPath, env: wiringEnv };
}

/**
 * Select explicitly requested child keys. A key is safe only when the session
 * record has an exact placeholder assignment and the full env contains that
 * exact placeholder. Prefixes are intentionally not trusted. Keys absent from
 * placeholderOverrides (including @proxy=passthrough values) are rejected.
 */
export function selectPlaceholderEnvironment(
  fullEnv: Readonly<Record<string, string>>,
  session: VarlockSessionRecord,
  requestedKeys: readonly string[],
): Readonly<Record<string, string>> {
  if (!Array.isArray(requestedKeys) || requestedKeys.length > PROTOCOL_LIMITS.mapEntries)
    fail("invalid requested Varlock keys");
  const overrides = session.placeholderOverrides;
  if (!overrides) fail("Varlock session has no placeholder assignments");
  const selected: Record<string, string> = Object.create(null) as Record<string, string>;
  const seen = new Set<string>();
  for (const key of requestedKeys) {
    if (seen.has(key)) fail("duplicate requested Varlock key");
    seen.add(key);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || key.length > PROTOCOL_LIMITS.envKeyLength)
      fail("invalid requested Varlock key");
    const placeholder = overrides[key];
    if (placeholder === undefined || fullEnv[key] !== placeholder)
      fail("requested key is not proven to be placeholder-backed");
    selected[key] = placeholder;
  }
  return selected;
}

/** Safe status allowlist; deliberately drops tokens, env maps, and placeholders. */
export function sanitizeSessionStatus(
  session: VarlockSessionRecord,
  running: boolean,
): SafeSessionStatus {
  const wiring = validateProxyWiring(session.env);
  return {
    id: session.id,
    uuid: session.uuid,
    ownerPid: session.ownerPid,
    cwd: session.cwd,
    startedAt: session.startedAt,
    updatedAt: session.updatedAt,
    egressMode: session.egressMode,
    proxyUrl: wiring.proxyUrl,
    running,
  };
}
