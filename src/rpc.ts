import { Rpc } from "@opencode/plugin/effect";
import { Schema } from "effect";
import { VarlockError, type SafeStatus } from "./contracts.js";

const statusError = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
  retryable: Schema.Boolean,
});

export const SafeStatusSchema = Schema.Struct({
  phase: Schema.String,
  projectDirectory: Schema.String,
  generation: Schema.Number,
  pid: Schema.optional(Schema.Number),
  endpoint: Schema.optional(Schema.String),
  lastRefreshAt: Schema.optional(Schema.String),
  error: Schema.optional(statusError),
  diagnostics: Schema.optional(
    Schema.Array(
      Schema.Struct({
        code: Schema.String,
        server: Schema.String,
        message: Schema.String,
      }),
    ),
  ),
});

const Empty = Schema.Struct({});

const isVarlockErrorCode = (value: unknown): value is VarlockError["code"] =>
  value === "invalid_config" ||
  value === "unavailable" ||
  value === "start_failed" ||
  value === "refresh_failed" ||
  value === "not_ready" ||
  value === "disposed" ||
  value === "protocol_error" ||
  value === "timeout";

export const KeyFerryRpc = Rpc.define({
  id: "key-ferry",
  methods: {
    status: {
      input: Empty,
      output: SafeStatusSchema,
      errors: {
        unavailable: Schema.Struct({ code: Schema.String }),
      },
    },
    refresh: {
      input: Empty,
      output: SafeStatusSchema,
      errors: {
        unavailable: Schema.Struct({ code: Schema.String }),
      },
    },
    doctor: {
      input: Empty,
      output: SafeStatusSchema,
      errors: {
        unavailable: Schema.Struct({ code: Schema.String }),
      },
    },
  },
  events: {},
});

const publicMessage = (error: VarlockError) => {
  switch (error.code) {
    case "invalid_config":
      return "Varlock configuration is invalid";
    case "start_failed":
      return "Varlock could not start";
    case "refresh_failed":
      return "Varlock refresh failed";
    case "timeout":
      return "Varlock operation timed out";
    case "not_ready":
      return "Varlock is not ready";
    case "disposed":
      return "Varlock manager is stopped";
    case "protocol_error":
      return "Varlock returned an invalid response";
    default:
      return "Varlock is unavailable";
  }
};

/** Rebuild a safe status without trusting an adapter error message. */
export function sanitizeStatus(status: SafeStatus): SafeStatus {
  const errorCode = isVarlockErrorCode(status.error?.code) ? status.error.code : "unavailable";
  return {
    phase: status.phase,
    projectDirectory: status.projectDirectory,
    generation: status.generation,
    ...(status.pid === undefined ? {} : { pid: status.pid }),
    ...(status.endpoint === undefined ? {} : { endpoint: status.endpoint }),
    ...(status.lastRefreshAt === undefined ? {} : { lastRefreshAt: status.lastRefreshAt }),
    ...(status.error === undefined
      ? {}
      : {
          error: new VarlockError({
            code: errorCode,
            message: publicMessage(
              new VarlockError({
                code: errorCode,
                message: "",
                retryable: status.error.retryable === true,
              }),
            ),
            retryable: status.error.retryable,
          }),
        }),
    ...(status.diagnostics === undefined
      ? {}
      : {
          diagnostics: status.diagnostics.map((item) => ({
            code: item.code,
            server: item.server,
            message: item.message,
          })),
        }),
  };
}

export function rpcError(error: VarlockError) {
  return { code: error.code };
}

export { publicMessage };
