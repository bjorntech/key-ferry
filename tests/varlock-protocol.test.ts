import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeSessionList,
  findOwnedSession,
  sanitizeSessionStatus,
  selectPlaceholderEnvironment,
  validateProxyWiring,
  VarlockProtocolError,
} from "../src/varlock/protocol.js";

const sessionJson = (extra: Record<string, unknown> = {}) =>
  JSON.stringify([
    {
      id: "abc12",
      uuid: "session-uuid",
      ownerPid: 1234,
      cwd: "/project",
      startedAt: "2026-10-16T10:00:00.000Z",
      updatedAt: "2026-10-16T10:00:01.000Z",
      egressMode: "strict",
      placeholderOverrides: { OPENAI_API_KEY: "sk-placeholder" },
      env: {
        HTTP_PROXY: "http://127.0.0.1:43821",
        HTTPS_PROXY: "http://127.0.0.1:43821",
        NODE_EXTRA_CA_CERTS: "/tmp/varlock/ca-cert.pem",
        OPENAI_API_KEY: "sk-placeholder",
      },
      ...extra,
    },
  ]);

test("decodes bounded session JSON and never preserves token fields", () => {
  const [session] = decodeSessionList(
    sessionJson({ endpointToken: "control", dataPlaneToken: "data" }),
  );
  assert.equal(session.uuid, "session-uuid");
  assert.equal("endpointToken" in session, false);
  assert.equal("dataPlaneToken" in session, false);
});

test("requires exact PID, UUID, and cwd ownership", () => {
  const [session] = decodeSessionList(sessionJson());
  assert.equal(
    findOwnedSession([session], {
      ownerPid: 1234,
      sessionUuid: "session-uuid",
      projectDirectory: "/project",
    }),
    session,
  );
  assert.equal(
    findOwnedSession([session], {
      ownerPid: 1235,
      sessionUuid: "session-uuid",
      projectDirectory: "/project",
    }),
    undefined,
  );
  assert.equal(
    findOwnedSession([session], {
      ownerPid: 1234,
      sessionUuid: "other",
      projectDirectory: "/project",
    }),
    undefined,
  );
  assert.equal(
    findOwnedSession([session], {
      ownerPid: 1234,
      sessionUuid: "session-uuid",
      projectDirectory: "/project/sub",
    }),
    undefined,
  );
});

test("sanitizes status and drops token/env/placeholder data", () => {
  const [session] = decodeSessionList(
    sessionJson({ endpointToken: "secret", dataPlaneToken: "secret" }),
  );
  const status = sanitizeSessionStatus(session, true);
  assert.deepEqual(status, {
    id: "abc12",
    uuid: "session-uuid",
    ownerPid: 1234,
    cwd: "/project",
    startedAt: "2026-10-16T10:00:00.000Z",
    updatedAt: "2026-10-16T10:00:01.000Z",
    egressMode: "strict",
    proxyUrl: "http://127.0.0.1:43821",
    running: true,
  });
  assert.equal(JSON.stringify(status).includes("secret"), false);
});

test("validates loopback wiring and rejects non-loopback, credentials, and traversal", () => {
  const valid = {
    HTTP_PROXY: "http://127.0.0.1:43821",
    HTTPS_PROXY: "http://127.0.0.1:43821",
    NODE_EXTRA_CA_CERTS: "/tmp/varlock/ca-cert.pem",
  };
  assert.equal(validateProxyWiring(valid).proxyUrl, "http://127.0.0.1:43821");
  assert.throws(
    () => validateProxyWiring({ ...valid, HTTPS_PROXY: "http://10.0.0.1:43821" }),
    VarlockProtocolError,
  );
  assert.throws(
    () => validateProxyWiring({ ...valid, HTTPS_PROXY: "http://user:pass@127.0.0.1:43821" }),
    VarlockProtocolError,
  );
  assert.throws(
    () => validateProxyWiring({ ...valid, NODE_EXTRA_CA_CERTS: "/tmp/../ca-cert.pem" }),
    VarlockProtocolError,
  );
});

test("selects only exact placeholder assignments, never raw passthrough", () => {
  const [session] = decodeSessionList(
    sessionJson({
      env: {
        HTTP_PROXY: "http://127.0.0.1:43821",
        HTTPS_PROXY: "http://127.0.0.1:43821",
        NODE_EXTRA_CA_CERTS: "/tmp/varlock/ca-cert.pem",
        OPENAI_API_KEY: "sk-placeholder",
        PASSTHROUGH: "real-secret",
      },
      placeholderOverrides: { OPENAI_API_KEY: "sk-placeholder" },
    }),
  );
  assert.deepEqual(
    { ...selectPlaceholderEnvironment(session.env, session, ["OPENAI_API_KEY"]) },
    { OPENAI_API_KEY: "sk-placeholder" },
  );
  assert.throws(
    () => selectPlaceholderEnvironment(session.env, session, ["PASSTHROUGH"]),
    VarlockProtocolError,
  );
  assert.throws(
    () =>
      selectPlaceholderEnvironment({ ...session.env, OPENAI_API_KEY: "sk-live" }, session, [
        "OPENAI_API_KEY",
      ]),
    VarlockProtocolError,
  );
});

test("rejects malformed, oversized, hostile, and ended records", () => {
  assert.throws(() => decodeSessionList("{}"), VarlockProtocolError);
  assert.throws(() => decodeSessionList("not json"), VarlockProtocolError);
  const hostile = sessionJson().replace('"OPENAI_API_KEY":"sk-placeholder"', '"__proto__":"bad"');
  assert.throws(() => decodeSessionList(hostile), VarlockProtocolError);
  const [ended] = decodeSessionList(sessionJson({ endedAt: "2026-10-16T10:01:00.000Z" }));
  assert.equal(
    findOwnedSession([ended], {
      ownerPid: 1234,
      sessionUuid: "session-uuid",
      projectDirectory: "/project",
    }),
    undefined,
  );
});

test("enforces protocol bounds and rejects invalid identity fields", () => {
  assert.throws(
    () => decodeSessionList("x".repeat(2 * 1024 * 1024 + 1)),
    (error: unknown) =>
      error instanceof VarlockProtocolError && error.message === "invalid Varlock JSON payload",
  );
  assert.throws(
    () =>
      decodeSessionList(
        JSON.stringify(Array.from({ length: 129 }, () => JSON.parse(sessionJson())[0])),
      ),
    VarlockProtocolError,
  );
  for (const field of ["id", "uuid", "cwd", "startedAt", "updatedAt"]) {
    assert.throws(
      () => decodeSessionList(sessionJson({ [field]: "\0" })),
      VarlockProtocolError,
      `rejects NUL in ${field}`,
    );
  }
  assert.throws(() => decodeSessionList(sessionJson({ ownerPid: 0 })), VarlockProtocolError);
  assert.throws(() => decodeSessionList(sessionJson({ ownerPid: 1.5 })), VarlockProtocolError);
  assert.throws(
    () => decodeSessionList(sessionJson({ egressMode: "audit" })),
    VarlockProtocolError,
  );
  assert.throws(
    () => decodeSessionList(sessionJson({ env: { constructor: "polluted" } })),
    VarlockProtocolError,
  );
  assert.throws(
    () => decodeSessionList(sessionJson({ env: { "BAD-KEY": "value" } })),
    VarlockProtocolError,
  );
});

test("keeps wiring to the documented allowlist and rejects proxy/path edge cases", () => {
  const valid = {
    HTTP_PROXY: "http://127.0.0.1:43821",
    HTTPS_PROXY: "http://127.0.0.1:43821",
    NODE_EXTRA_CA_CERTS: "/tmp/varlock/ca-cert.pem",
    SECRET_CHILD_VALUE: "must-not-be-returned",
  };
  const wiring = validateProxyWiring(valid);
  assert.deepEqual(
    { ...wiring.env },
    {
      HTTP_PROXY: valid.HTTP_PROXY,
      HTTPS_PROXY: valid.HTTPS_PROXY,
      NODE_EXTRA_CA_CERTS: valid.NODE_EXTRA_CA_CERTS,
    },
  );
  for (const bad of [
    { ...valid, HTTP_PROXY: undefined },
    { ...valid, HTTPS_PROXY: "http://127.0.0.1:43822" },
    { ...valid, all_proxy: "http://127.0.0.1:43822/user" },
    { ...valid, NODE_EXTRA_CA_CERTS: "/tmp/varlock/./ca-cert.pem" },
    { ...valid, NODE_EXTRA_CA_CERTS: "/tmp/varlock/ca-cert.pem/" },
    { ...valid, NODE_EXTRA_CA_CERTS: "/tmp/varlock/not-a-cert.pem" },
    { ...valid, "BAD-KEY": "value" },
  ]) {
    assert.throws(() => validateProxyWiring(bad), VarlockProtocolError);
  }
});

test("rejects unsafe placeholder requests and duplicate selections", () => {
  const [session] = decodeSessionList(sessionJson());
  assert.deepEqual({ ...selectPlaceholderEnvironment(session.env, session, []) }, {});
  assert.throws(
    () => selectPlaceholderEnvironment(session.env, session, ["OPENAI_API_KEY", "OPENAI_API_KEY"]),
    VarlockProtocolError,
  );
  assert.throws(
    () =>
      selectPlaceholderEnvironment(session.env, { ...session, placeholderOverrides: undefined }, [
        "OPENAI_API_KEY",
      ]),
    VarlockProtocolError,
  );
  assert.throws(
    () =>
      findOwnedSession([session], {
        ownerPid: 0,
        sessionUuid: "session-uuid",
        projectDirectory: "/project",
      }),
    VarlockProtocolError,
  );
});
