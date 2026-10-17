import { resolve } from "node:path";
import type {
  ProjectDirectory,
  ProjectKeyFerryManagerOptions,
  KeyFerryPluginOptions,
} from "./contracts.js";
import { projectDirectory as brandProjectDirectory } from "./contracts.js";

export interface ServerProtectionInput {
  /** Output environment name -> Varlock placeholder/environment key. */
  readonly env: readonly string[] | Readonly<Record<string, string>>;
}

export interface RemoteHeaderMapping {
  readonly env: string;
  readonly prefix?: string;
  readonly suffix?: string;
}

export interface RemoteServerProtectionInput {
  readonly remote: {
    readonly headers: Readonly<Record<string, string | RemoteHeaderMapping>>;
  };
}

export type ServerProtection = Readonly<Record<string, string>> | RemoteServerProtectionInput;

export interface VarlockAdapterOptions {
  readonly command: readonly string[];
  readonly startupTimeoutMs: number;
  readonly commandTimeoutMs: number;
  readonly reloadTimeoutMs: number;
  readonly pollIntervalMs: number;
  readonly requireStrictEgress: boolean;
  readonly allowPrivateNetwork: boolean;
  readonly servers: Readonly<Record<string, ServerProtection>>;
  /** @deprecated Use reloadTimeoutMs. Kept as a non-enumerable compatibility view. */
  readonly refreshTimeoutMs: number;
}

export interface ValidatedOptions {
  readonly enabled: boolean;
  readonly projectDirectory?: ProjectDirectory;
  readonly adapter: VarlockAdapterOptions;
  readonly manager: Omit<KeyFerryPluginOptions, "adapter"> & {
    readonly adapter: VarlockAdapterOptions;
  };
  readonly projectConfig: ProjectConfigOptions;
}

export type ProjectConfigActivation = "auto" | "manual";

export interface ProjectConfigOptions {
  readonly enabled: boolean;
  readonly activation: ProjectConfigActivation;
  readonly file: string;
}

const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 10_000;
const DEFAULT_RELOAD_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 100;
const MAX_TIMEOUT_MS = 10 * 60 * 1_000;
const MAX_RELOAD_TIMEOUT_MS = 15 * 60 * 1_000;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);
const MCP_PROTOCOL_HEADERS = new Set([
  "accept",
  "content-type",
  "mcp-session-id",
  "mcp-protocol-version",
  "last-event-id",
  "origin",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const positiveInteger = (value: unknown, name: string, maximum?: number) => {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    (maximum !== undefined && value > maximum)
  )
    throw new TypeError(
      `${name} must be a positive integer${maximum === undefined ? "" : ` no greater than ${maximum}`}`,
    );
  return value;
};

const stringArray = (value: unknown, name: string) => {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((item) => typeof item !== "string" || item.length === 0)
  )
    throw new TypeError(`${name} must be a non-empty array of non-empty strings`);
  return [...value];
};

const unsafeName = (value: string) =>
  value === "__proto__" || value === "prototype" || value === "constructor";
const environmentName = (value: unknown, name: string): string => {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    unsafeName(value) ||
    !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)
  ) {
    throw new TypeError(`${name} must be a valid environment name`);
  }
  return value;
};

function normalizeServer(name: string, value: unknown): ServerProtection {
  if (!isRecord(value)) throw new TypeError(`servers.${name} must be an object`);
  if ("remote" in value) {
    if ("env" in value) throw new TypeError(`servers.${name} cannot mix env and remote protection`);
    return normalizeRemoteServer(name, value);
  }
  const env = value.env;
  if (Array.isArray(env)) {
    const keys = stringArray(env, `servers.${name}.env`).map((key) =>
      environmentName(key, `servers.${name}.env`),
    );
    const result: Record<string, string> = Object.create(null) as Record<string, string>;
    for (const key of keys) result[key] = key;
    return result;
  }
  if (!isRecord(env)) throw new TypeError(`servers.${name}.env must be an array or object`);
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [outputName, sourceName] of Object.entries(env)) {
    const output = environmentName(outputName, `servers.${name}.env output`);
    result[output] = environmentName(sourceName, `servers.${name}.env source`);
  }
  if (Object.keys(result).length === 0)
    throw new TypeError(`servers.${name}.env must not be empty`);
  return result;
}

function cleanHeaderPart(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > 256 || /[\r\n\0]/.test(value)) {
    throw new TypeError(`${field} must be a bounded string without control characters`);
  }
  return value;
}

function normalizeRemoteServer(
  name: string,
  value: Record<string, unknown>,
): RemoteServerProtectionInput {
  const remote = value.remote;
  if (!isRecord(remote) || !isRecord(remote.headers)) {
    throw new TypeError(`servers.${name}.remote.headers must be a non-empty object`);
  }
  const result: Record<string, string | RemoteHeaderMapping> = Object.create(null) as Record<
    string,
    string | RemoteHeaderMapping
  >;
  const seen = new Set<string>();
  for (const [header, rawMapping] of Object.entries(remote.headers)) {
    const lower = header.toLowerCase();
    if (
      !HEADER_NAME.test(header) ||
      unsafeName(header) ||
      HOP_BY_HOP_HEADERS.has(lower) ||
      MCP_PROTOCOL_HEADERS.has(lower) ||
      lower === "set-cookie" ||
      seen.has(lower)
    ) {
      throw new TypeError(`servers.${name}.remote.headers contains an invalid or duplicate header`);
    }
    seen.add(lower);
    if (typeof rawMapping === "string") {
      result[header] = environmentName(rawMapping, `servers.${name}.remote.headers.${header}`);
      continue;
    }
    if (!isRecord(rawMapping))
      throw new TypeError(`servers.${name}.remote.headers.${header} must name an environment key`);
    const env = environmentName(rawMapping.env, `servers.${name}.remote.headers.${header}.env`);
    const prefix = cleanHeaderPart(
      rawMapping.prefix,
      `servers.${name}.remote.headers.${header}.prefix`,
    );
    const suffix = cleanHeaderPart(
      rawMapping.suffix,
      `servers.${name}.remote.headers.${header}.suffix`,
    );
    result[header] = {
      env,
      ...(prefix === undefined ? {} : { prefix }),
      ...(suffix === undefined ? {} : { suffix }),
    };
  }
  if (Object.keys(result).length === 0)
    throw new TypeError(`servers.${name}.remote.headers must not be empty`);
  return { remote: { headers: result } };
}

function readBoolean(input: Record<string, unknown>, name: string, fallback: boolean): boolean {
  const value = input[name];
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new TypeError(`${name} must be a boolean`);
  return value;
}

function normalizeProjectConfig(input: Record<string, unknown>): ProjectConfigOptions {
  const value = input.projectConfig;
  if (value === undefined) return defaultProjectConfig();
  if (!isRecord(value)) throw new TypeError("projectConfig must be an object");
  return readProjectConfig(value);
}

function defaultProjectConfig(): ProjectConfigOptions {
  return { enabled: false, activation: "auto", file: ".opencode/key-ferry.jsonc" };
}

function readActivation(value: unknown): ProjectConfigActivation {
  const activation = value ?? "auto";
  if (activation !== "auto" && activation !== "manual")
    throw new TypeError("projectConfig.activation must be auto or manual");
  return activation;
}

function readProjectConfig(value: Record<string, unknown>): ProjectConfigOptions {
  const enabled = readBoolean(value, "enabled", false);
  const activation = readActivation(value.activation);
  const file = value.file ?? ".opencode/key-ferry.jsonc";
  if (typeof file !== "string" || file.length === 0 || file.startsWith("/") || file.includes("\0"))
    throw new TypeError("projectConfig.file must be a relative path");
  return { enabled, activation, file };
}

function readTimeout(
  input: Record<string, unknown>,
  name: string,
  fallback: number,
  maximum?: number,
): number {
  const value = input[name];
  return value === undefined ? fallback : positiveInteger(value, name, maximum);
}

function normalizeReloadTimeout(input: Record<string, unknown>): number {
  const usesLegacyName =
    input.reloadTimeoutMs === undefined && input.refreshTimeoutMs !== undefined;
  const value = input.reloadTimeoutMs ?? input.refreshTimeoutMs;
  return value === undefined
    ? DEFAULT_RELOAD_TIMEOUT_MS
    : positiveInteger(value, "reloadTimeoutMs", usesLegacyName ? 900_000 : MAX_RELOAD_TIMEOUT_MS);
}

function normalizeServers(input: Record<string, unknown>): Record<string, ServerProtection> {
  const rawServers = input.servers;
  if (rawServers === undefined) return Object.create(null) as Record<string, ServerProtection>;
  if (!isRecord(rawServers)) throw new TypeError("servers must be an object");
  const servers: Record<string, ServerProtection> = Object.create(null) as Record<
    string,
    ServerProtection
  >;
  for (const [name, value] of Object.entries(rawServers)) {
    if (!name || unsafeName(name)) throw new TypeError("server names must be safe non-empty names");
    servers[name] = normalizeServer(name, value);
  }
  return servers;
}

function normalizeAdapter(input: Record<string, unknown>): VarlockAdapterOptions {
  const command = input.command === undefined ? ["varlock"] : stringArray(input.command, "command");
  const startupTimeoutMs = readTimeout(input, "startupTimeoutMs", DEFAULT_STARTUP_TIMEOUT_MS);
  const commandTimeoutMs = readTimeout(
    input,
    "commandTimeoutMs",
    DEFAULT_COMMAND_TIMEOUT_MS,
    MAX_TIMEOUT_MS,
  );
  const reloadTimeoutMs = normalizeReloadTimeout(input);
  const pollIntervalMs = readTimeout(input, "pollIntervalMs", DEFAULT_POLL_INTERVAL_MS, 10_000);
  const requireStrictEgress = readBoolean(input, "requireStrictEgress", true);
  const allowPrivateNetwork = readBoolean(input, "allowPrivateNetwork", false);
  const adapter = {
    command,
    startupTimeoutMs,
    commandTimeoutMs,
    reloadTimeoutMs,
    pollIntervalMs,
    requireStrictEgress,
    allowPrivateNetwork,
    servers: normalizeServers(input),
  } as unknown as VarlockAdapterOptions;
  // Existing consumers read this property directly. It is deliberately not
  // enumerable so managerOptions can pass an exact canonical adapter shape.
  Object.defineProperty(adapter, "refreshTimeoutMs", {
    value: input.refreshTimeoutMs === undefined ? 900_000 : reloadTimeoutMs,
    enumerable: false,
    configurable: false,
  });
  return adapter;
}

function validateProjectPath(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0)
    throw new TypeError("projectDirectory must be a non-empty path");
  return value;
}

function resolveProjectDirectory(
  input: Record<string, unknown>,
  directory: string | undefined,
  resolveDirectory: boolean,
): ProjectDirectory | undefined {
  if (input.projectDirectory === undefined) {
    return directory === undefined ? undefined : brandProjectDirectory(directory);
  }
  const configured = validateProjectPath(input.projectDirectory);
  const value = resolveDirectory ? resolve(directory ?? process.cwd(), configured) : configured;
  return brandProjectDirectory(value);
}

function makeValidatedOptions(
  enabled: boolean,
  projectDirectory: ProjectDirectory | undefined,
  adapter: VarlockAdapterOptions,
  projectConfig: ProjectConfigOptions,
): ValidatedOptions {
  const manager: ValidatedOptions["manager"] = {
    enabled,
    ...(projectDirectory === undefined ? {} : { projectDirectory }),
    adapter,
  };
  return {
    enabled,
    ...(projectDirectory === undefined ? {} : { projectDirectory }),
    adapter,
    manager,
    projectConfig,
  };
}

/**
 * Decode untrusted OpenCode plugin options without touching process.env.
 * `enabled: false` explicitly means no manager layer, MCP transform, or RPC
 * is installed and existing MCP configuration is left untouched.
 */
export function parseOptions(
  raw: unknown,
  directory?: string,
  resolveDirectory = true,
): ValidatedOptions {
  const input = isRecord(raw) ? raw : {};
  if ("failClosed" in input)
    throw new TypeError("failClosed is not supported; protection is always fail-closed");
  const enabled = readBoolean(input, "enabled", true);
  const adapter = normalizeAdapter(input);
  const projectDirectory = resolveProjectDirectory(input, directory, resolveDirectory);
  return makeValidatedOptions(enabled, projectDirectory, adapter, normalizeProjectConfig(input));
}

export function managerOptions(
  options: ValidatedOptions,
  directory: string,
): ProjectKeyFerryManagerOptions {
  const environmentKeys = [
    ...new Set(
      Object.values(options.adapter.servers).flatMap((mapping) => {
        if (isRemoteProtectionValue(mapping)) {
          return Object.values(mapping.remote.headers).map((header) =>
            typeof header === "string" ? header : header.env,
          );
        }
        return Object.values(mapping);
      }),
    ),
  ];
  return {
    projectDirectory: options.projectDirectory ?? brandProjectDirectory(directory),
    owner: "key-ferry",
    // Keep this object in lockstep with the manager adapter contract. In
    // particular, server mappings are plugin concerns and must not leak into
    // the Varlock process adapter.
    adapter: {
      command: [...options.adapter.command],
      environmentKeys,
      startupTimeoutMs: options.adapter.startupTimeoutMs,
      commandTimeoutMs: options.adapter.commandTimeoutMs,
      reloadTimeoutMs: options.adapter.reloadTimeoutMs,
      pollIntervalMs: options.adapter.pollIntervalMs,
      requireStrictEgress: options.adapter.requireStrictEgress,
    },
  };
}

function isRemoteProtectionValue(value: ServerProtection): value is RemoteServerProtectionInput {
  return isRecord(value) && isRecord(value.remote) && isRecord(value.remote.headers);
}
