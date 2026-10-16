import { describe, expect, test } from "bun:test"
import { VarlockError, projectDirectory } from "../src/contracts.js"
import { sanitizeStatus } from "../src/rpc.js"

describe("safe Varlock RPC data", () => {
  test("redacts adapter error text while retaining actionable state", () => {
    const secret = "super-secret-token"
    const status = sanitizeStatus({
      phase: "failed",
      projectDirectory: projectDirectory("/project"),
      generation: 3,
      error: new VarlockError({ code: "refresh_failed", message: `raw ${secret}`, retryable: true }),
    })

    expect(JSON.stringify(status)).not.toContain(secret)
    expect(status.error?.message).toBe("Varlock refresh failed")
    expect(status.error?.code).toBe("refresh_failed")
  })

  test("does not expose environment values because status has no environment field", () => {
    const status = sanitizeStatus({ phase: "ready", projectDirectory: projectDirectory("/project"), generation: 1 })
    expect("environment" in status).toBe(false)
    expect("env" in status).toBe(false)
  })

  test("keeps relay diagnostics actionable without relay credentials", () => {
    const status = sanitizeStatus({
      phase: "failed",
      projectDirectory: projectDirectory("/project"),
      generation: 4,
      diagnostics: [{
        code: "remote_oauth_required",
        server: "remote-tools",
        message: "set oauth:false for API-key relay mode, or remove this Varlock mapping to keep native OAuth",
      }],
    })
    expect(status.diagnostics?.[0]?.message).toContain("oauth:false")
    expect(JSON.stringify(status)).not.toContain("placeholder-api-key")
    expect(JSON.stringify(status)).not.toContain("x-varlock-relay-token")
  })
})
