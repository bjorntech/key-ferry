import { describe, expect, test } from "bun:test";
import { VarlockError, projectDirectory } from "../src/contracts.js";
import { publicMessage, rpcError, sanitizeStatus } from "../src/rpc.js";

describe("safe Varlock RPC data", () => {
  test("redacts adapter error text while retaining actionable state", () => {
    const secret = "super-secret-token";
    const status = sanitizeStatus({
      phase: "failed",
      projectDirectory: projectDirectory("/project"),
      generation: 3,
      error: new VarlockError({
        code: "refresh_failed",
        message: `raw ${secret}`,
        retryable: true,
      }),
    });

    expect(JSON.stringify(status)).not.toContain(secret);
    expect(status.error?.message).toBe("Varlock refresh failed");
    expect(status.error?.code).toBe("refresh_failed");
  });

  test("does not expose environment values because status has no environment field", () => {
    const status = sanitizeStatus({
      phase: "ready",
      projectDirectory: projectDirectory("/project"),
      generation: 1,
    });
    expect("environment" in status).toBe(false);
    expect("env" in status).toBe(false);
  });

  test("keeps relay diagnostics actionable without relay credentials", () => {
    const status = sanitizeStatus({
      phase: "failed",
      projectDirectory: projectDirectory("/project"),
      generation: 4,
      diagnostics: [
        {
          code: "remote_oauth_required",
          server: "remote-tools",
          message:
            "set oauth:false for API-key relay mode, or remove this Varlock mapping to keep native OAuth",
        },
      ],
    });
    expect(status.diagnostics?.[0]?.message).toContain("oauth:false");
    expect(JSON.stringify(status)).not.toContain("placeholder-api-key");
    expect(JSON.stringify(status)).not.toContain("x-varlock-relay-token");
  });

  test("maps every supported failure code to a stable public message", () => {
    const messages = {
      invalid_config: "Varlock configuration is invalid",
      start_failed: "Varlock could not start",
      refresh_failed: "Varlock refresh failed",
      timeout: "Varlock operation timed out",
      not_ready: "Varlock is not ready",
      disposed: "Varlock manager is stopped",
      protocol_error: "Varlock returned an invalid response",
      unavailable: "Varlock is unavailable",
    } as const;
    for (const [code, message] of Object.entries(messages)) {
      const error = new VarlockError({
        code: code as keyof typeof messages,
        message: "raw",
        retryable: false,
      });
      expect(publicMessage(error)).toBe(message);
      expect(rpcError(error)).toEqual({ code });
    }
  });

  test("normalizes unknown error codes and retains safe metadata", () => {
    const status = sanitizeStatus({
      phase: "degraded",
      projectDirectory: projectDirectory("/project"),
      generation: 9,
      pid: 42,
      endpoint: "http://127.0.0.1:9999",
      lastRefreshAt: "2026-01-01T00:00:00.000Z",
      error: { code: "raw-secret-code" as never, message: "secret", retryable: false },
    });
    expect(status.error?.code).toBe("unavailable");
    expect(status.error?.message).toBe("Varlock is unavailable");
    expect(status.error?.retryable).toBe(false);
    expect(status.pid).toBe(42);
    expect(status.endpoint).toBe("http://127.0.0.1:9999");
  });
});
