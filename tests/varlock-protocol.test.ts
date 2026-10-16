import assert from "node:assert/strict"
import test from "node:test"
import {
  decodeSessionList,
  findOwnedSession,
  sanitizeSessionStatus,
  selectPlaceholderEnvironment,
  validateProxyWiring,
  VarlockProtocolError,
} from "../src/varlock/protocol.js"

const sessionJson = (extra: Record<string, unknown> = {}) => JSON.stringify([{
  id: "abc12", uuid: "session-uuid", ownerPid: 1234, cwd: "/project",
  startedAt: "2026-10-16T10:00:00.000Z", updatedAt: "2026-10-16T10:00:01.000Z",
  egressMode: "strict", placeholderOverrides: { OPENAI_API_KEY: "sk-placeholder" },
  env: {
    HTTP_PROXY: "http://127.0.0.1:43821", HTTPS_PROXY: "http://127.0.0.1:43821",
    NODE_EXTRA_CA_CERTS: "/tmp/varlock/ca-cert.pem", OPENAI_API_KEY: "sk-placeholder",
  }, ...extra,
}])

test("decodes bounded session JSON and never preserves token fields", () => {
  const [session] = decodeSessionList(sessionJson({ endpointToken: "control", dataPlaneToken: "data" }))
  assert.equal(session.uuid, "session-uuid")
  assert.equal("endpointToken" in session, false)
  assert.equal("dataPlaneToken" in session, false)
})

test("requires exact PID, UUID, and cwd ownership", () => {
  const [session] = decodeSessionList(sessionJson())
  assert.equal(findOwnedSession([session], { ownerPid: 1234, sessionUuid: "session-uuid", projectDirectory: "/project" }), session)
  assert.equal(findOwnedSession([session], { ownerPid: 1235, sessionUuid: "session-uuid", projectDirectory: "/project" }), undefined)
  assert.equal(findOwnedSession([session], { ownerPid: 1234, sessionUuid: "other", projectDirectory: "/project" }), undefined)
  assert.equal(findOwnedSession([session], { ownerPid: 1234, sessionUuid: "session-uuid", projectDirectory: "/project/sub" }), undefined)
})

test("sanitizes status and drops token/env/placeholder data", () => {
  const [session] = decodeSessionList(sessionJson({ endpointToken: "secret", dataPlaneToken: "secret" }))
  const status = sanitizeSessionStatus(session, true)
  assert.deepEqual(status, {
    id: "abc12", uuid: "session-uuid", ownerPid: 1234, cwd: "/project",
    startedAt: "2026-10-16T10:00:00.000Z", updatedAt: "2026-10-16T10:00:01.000Z",
    egressMode: "strict", proxyUrl: "http://127.0.0.1:43821", running: true,
  })
  assert.equal(JSON.stringify(status).includes("secret"), false)
})

test("validates loopback wiring and rejects non-loopback, credentials, and traversal", () => {
  const valid = {
    HTTP_PROXY: "http://127.0.0.1:43821", HTTPS_PROXY: "http://127.0.0.1:43821",
    NODE_EXTRA_CA_CERTS: "/tmp/varlock/ca-cert.pem",
  }
  assert.equal(validateProxyWiring(valid).proxyUrl, "http://127.0.0.1:43821")
  assert.throws(() => validateProxyWiring({ ...valid, HTTPS_PROXY: "http://10.0.0.1:43821" }), VarlockProtocolError)
  assert.throws(() => validateProxyWiring({ ...valid, HTTPS_PROXY: "http://user:pass@127.0.0.1:43821" }), VarlockProtocolError)
  assert.throws(() => validateProxyWiring({ ...valid, NODE_EXTRA_CA_CERTS: "/tmp/../ca-cert.pem" }), VarlockProtocolError)
})

test("selects only exact placeholder assignments, never raw passthrough", () => {
  const [session] = decodeSessionList(sessionJson({ env: {
    HTTP_PROXY: "http://127.0.0.1:43821", HTTPS_PROXY: "http://127.0.0.1:43821",
    NODE_EXTRA_CA_CERTS: "/tmp/varlock/ca-cert.pem", OPENAI_API_KEY: "sk-placeholder",
    PASSTHROUGH: "real-secret",
  }, placeholderOverrides: { OPENAI_API_KEY: "sk-placeholder" } }))
  assert.deepEqual({ ...selectPlaceholderEnvironment(session.env, session, ["OPENAI_API_KEY"]) }, { OPENAI_API_KEY: "sk-placeholder" })
  assert.throws(() => selectPlaceholderEnvironment(session.env, session, ["PASSTHROUGH"]), VarlockProtocolError)
  assert.throws(() => selectPlaceholderEnvironment({ ...session.env, OPENAI_API_KEY: "sk-live" }, session, ["OPENAI_API_KEY"]), VarlockProtocolError)
})

test("rejects malformed, oversized, hostile, and ended records", () => {
  assert.throws(() => decodeSessionList("{}"), VarlockProtocolError)
  assert.throws(() => decodeSessionList("not json"), VarlockProtocolError)
  const hostile = sessionJson().replace('"OPENAI_API_KEY":"sk-placeholder"', '"__proto__":"bad"')
  assert.throws(() => decodeSessionList(hostile), VarlockProtocolError)
  const [ended] = decodeSessionList(sessionJson({ endedAt: "2026-10-16T10:01:00.000Z" }))
  assert.equal(findOwnedSession([ended], { ownerPid: 1234, sessionUuid: "session-uuid", projectDirectory: "/project" }), undefined)
})
