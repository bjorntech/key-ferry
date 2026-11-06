import { Rpc } from "@opencode/plugin/effect";
import { Schema } from "effect";
import {
  VarlockError,
  type SafeDiagnostic,
  type SafeScopeStatus,
  type SafeStatus,
  type ScopeId,
} from "./contracts.js";
import { safeStderrMessage } from "./varlock/diagnostics.js";

const statusError = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
  retryable: Schema.Boolean,
  stderrTail: Schema.optional(Schema.String),
  stderrCode: Schema.optional(Schema.String),
});

const scopeId = Schema.Literals(["global", "project"] as const);
const managerPhase = Schema.Literals([
  "stopped",
  "starting",
  "ready",
  "degraded",
  "failed",
  "stopping",
  "idle",
] as const);
const diagnostic = Schema.Struct({
  code: Schema.String,
  server: Schema.String,
  message: Schema.String,
});
const scopeStatus = Schema.Struct({
  scope: scopeId,
  projectDirectory: Schema.String,
  phase: managerPhase,
  generation: Schema.Number,
  pid: Schema.optional(Schema.Number),
  idleUntil: Schema.optional(Schema.String),
  lastRefreshAt: Schema.optional(Schema.String),
  error: Schema.optional(statusError),
  lastFailureAt: Schema.optional(Schema.String),
  nextRetryAt: Schema.optional(Schema.String),
  diagnostics: Schema.optional(Schema.Array(diagnostic)),
  activation: Schema.optional(Schema.Literals(["auto", "manual", "awaiting_activation"] as const)),
});

export const SafeStatusSchema = Schema.Struct({
  phase: managerPhase,
  projectDirectory: Schema.String,
  generation: Schema.Number,
  pid: Schema.optional(Schema.Number),
  idleUntil: Schema.optional(Schema.String),
  endpoint: Schema.optional(Schema.String),
  lastRefreshAt: Schema.optional(Schema.String),
  lastFailureAt: Schema.optional(Schema.String),
  nextRetryAt: Schema.optional(Schema.String),
  error: Schema.optional(statusError),
  diagnostics: Schema.optional(Schema.Array(diagnostic)),
  scopes: Schema.optional(Schema.Array(scopeStatus)),
  bindings: Schema.optional(Schema.Record(Schema.String, scopeId)),
});

const selector = Schema.Struct({
  scope: Schema.optional(scopeId),
  server: Schema.optional(Schema.NonEmptyString),
});
const Empty = Schema.Struct({});

const varlockErrorCodes = new Set<VarlockError["code"]>([
  "invalid_config",
  "ownership_unavailable",
  "unavailable",
  "start_failed",
  "refresh_failed",
  "not_ready",
  "disposed",
  "protocol_error",
  "timeout",
]);
const isVarlockErrorCode = (value: unknown): value is VarlockError["code"] =>
  typeof value === "string" && varlockErrorCodes.has(value as VarlockError["code"]);

export const KeyFerryRpc = Rpc.define({
  id: "key-ferry",
  methods: {
    status: {
      input: selector,
      output: SafeStatusSchema,
      errors: {
        unavailable: Schema.Struct({ code: Schema.String }),
      },
    },
    refresh: {
      input: selector,
      output: SafeStatusSchema,
      errors: {
        unavailable: Schema.Struct({ code: Schema.String }),
      },
    },
    doctor: {
      input: selector,
      output: SafeStatusSchema,
      errors: {
        unavailable: Schema.Struct({ code: Schema.String }),
      },
    },
    activateProject: {
      input: Empty,
      output: SafeStatusSchema,
      errors: {
        unavailable: Schema.Struct({ code: Schema.String }),
      },
    },
  },
  events: {},
});

const publicMessages: Partial<Record<VarlockError["code"], string>> = {
  invalid_config: "Varlock configuration is invalid",
  ownership_unavailable: "Key Ferry could not secure its private runtime directory; see doctor.",
  start_failed: "Varlock could not start",
  refresh_failed: "Varlock refresh failed",
  timeout: "Varlock operation timed out",
  not_ready: "Varlock is not ready",
  disposed: "Varlock manager is stopped",
  protocol_error: "Varlock returned an invalid response",
};
const publicMessage = (error: VarlockError) =>
  publicMessages[error.code] ?? "Varlock is unavailable";

/** Rebuild a safe status without trusting an adapter error message. */
export function sanitizeStatus(status: SafeStatus): SafeStatus {
  return {
    phase: status.phase,
    projectDirectory: status.projectDirectory,
    generation: status.generation,
    ...sanitizeLegacyFields(status),
    ...sanitizeAggregateFields(status),
  };
}

function optionalField<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return value === undefined ? {} : ({ [key]: value } as { [P in K]?: V });
}

function sanitizeLegacyFields(status: SafeStatus): Partial<SafeStatus> {
  return {
    ...optionalField("pid", status.pid),
    ...optionalField("endpoint", status.endpoint),
    ...optionalField("lastRefreshAt", status.lastRefreshAt),
    ...optionalField("lastFailureAt", status.lastFailureAt),
    ...optionalField("nextRetryAt", status.nextRetryAt),
    ...optionalField("idleUntil", status.idleUntil),
    ...optionalField("error", status.error === undefined ? undefined : sanitizeError(status.error)),
  };
}

function sanitizeAggregateFields(status: SafeStatus): Partial<SafeStatus> {
  return {
    ...optionalField("diagnostics", status.diagnostics?.map(sanitizeDiagnostic)),
    ...optionalField("scopes", status.scopes?.map(sanitizeScopeStatus)),
    ...optionalField(
      "bindings",
      status.bindings === undefined ? undefined : sanitizeBindings(status.bindings),
    ),
  };
}

function sanitizeDiagnostic(item: SafeDiagnostic): SafeDiagnostic {
  const messages: Readonly<Record<string, string>> = {
    remote_unavailable: "Remote server is unavailable",
    remote_invalid_url: "Remote server URL is invalid",
    remote_oauth_required:
      "set oauth:false for API-key relay mode, or remove this Varlock mapping to keep native OAuth",
    remote_missing_placeholder: "Remote server mapping is incomplete",
    remote_invalid_header: "Remote server header configuration is invalid",
    remote_relay_failed: "Remote server relay failed",
    project_root_unavailable: "Project root is unavailable",
    project_config_escape: "Project configuration path is invalid",
    project_config_unavailable: "Project configuration is unavailable",
    project_config_too_large: "Project configuration is too large",
    project_config_invalid: "Project configuration is invalid",
  };
  const message = Object.hasOwn(messages, item.code)
    ? messages[item.code]
    : "Diagnostic information is unavailable";
  return {
    code: item.code,
    server: item.server,
    // Only messages produced by this adapter's known diagnostic codes cross
    // the boundary. Provider text is intentionally never used as a fallback.
    message,
  };
}

function sanitizeScopeStatus(status: SafeScopeStatus): SafeScopeStatus {
  return {
    scope: status.scope,
    projectDirectory: status.projectDirectory,
    phase: status.phase,
    generation: status.generation,
    ...optionalField("pid", status.pid),
    ...optionalField("lastRefreshAt", status.lastRefreshAt),
    ...optionalField("lastFailureAt", status.lastFailureAt),
    ...optionalField("nextRetryAt", status.nextRetryAt),
    ...optionalField("idleUntil", status.idleUntil),
    ...optionalField("error", status.error === undefined ? undefined : sanitizeError(status.error)),
    ...optionalField("diagnostics", status.diagnostics?.map(sanitizeDiagnostic)),
    ...optionalField("activation", status.activation),
  };
}

function sanitizeError(error: VarlockError): VarlockError {
  const code = isVarlockErrorCode(error.code) ? error.code : "unavailable";
  const stderrTail = safeStderrMessage(error.stderrCode, error.stderrTail);
  return new VarlockError({
    code,
    message: publicMessage(new VarlockError({ code, message: "", retryable: false })),
    retryable: error.retryable === true,
    ...(stderrTail ? { stderrTail } : {}),
    ...(stderrTail && error.stderrCode ? { stderrCode: error.stderrCode } : {}),
  });
}

function sanitizeBindings(
  bindings: Readonly<Record<string, ScopeId>>,
): Readonly<Record<string, ScopeId>> {
  const result: Record<string, ScopeId> = {};
  for (const [server, scope] of Object.entries(bindings)) {
    if (server.length > 0 && (scope === "global" || scope === "project")) result[server] = scope;
  }
  return result;
}

export function rpcError(error: VarlockError) {
  return { code: error.code };
}

export { publicMessage };
