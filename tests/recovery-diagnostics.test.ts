import { test } from "bun:test";
import assert from "node:assert/strict";
import { projectDirectory, VarlockError, type SafeStatus } from "../src/contracts.js";
import { sanitizeStatus } from "../src/rpc.js";
import { classifyStderr } from "../src/varlock/diagnostics.js";

const directory = projectDirectory("/project");

test("Varlock stderr classes expose only fixed diagnostic messages", () => {
  const cases = [
    ["The authorization prompt was dismissed", "op_prompt_dismissed"],
    ["not signed in", "op_not_signed_in"],
    ["authentication failed", "op_auth_failed"],
    ["BAD_VAULT_REFERENCE", "op_bad_vault_reference"],
    [
      "multiple different 1Password accounts when batching enabled",
      "op_multiple_accounts_app_auth",
    ],
    ["command not found: op", "op_not_found"],
    ["schema validation error", "varlock_schema_error"],
    ["operation timed out", "varlock_timeout"],
    ["error: failed abc123def?x=secret", "unknown"],
  ] as const;
  for (const [stderr, code] of cases) assert.equal(classifyStderr(stderr).code, code);
  const arbitrary = classifyStderr("1234567890123456 Zm9vYmFy https://example.test/?token=secret");
  assert.equal(arbitrary.code, "unknown");
  assert.doesNotMatch(arbitrary.message, /123456|Zm9v|https|secret/);
});

test("stderr diagnostics conservatively redact short, JSON, and bearer secrets", () => {
  const status: SafeStatus = {
    phase: "failed",
    projectDirectory: directory,
    generation: 1,
    error: new VarlockError({
      code: "start_failed",
      message: "unsafe",
      retryable: true,
      stderrCode: "unknown",
      stderrTail: "Varlock failed; see the doctor guidance",
    }),
  };
  const output = sanitizeStatus(status);
  assert.equal(output.error?.stderrTail?.includes("1234567890123456"), false);
  assert.equal(output.error?.stderrTail?.includes("short-value"), false);
  assert.equal(output.error?.stderrTail?.includes("Bearer abc123"), false);
  assert.equal(output.error?.stderrTail, "Varlock failed; see the doctor guidance");
  assert.ok((output.error?.stderrTail?.length ?? 0) <= 1200);
});

test("stderr truncation happens after redaction at the boundary", () => {
  const status: SafeStatus = {
    phase: "failed",
    projectDirectory: directory,
    generation: 1,
    error: new VarlockError({
      code: "start_failed",
      message: "unsafe",
      retryable: true,
      stderrTail: `${"varlock failed ".repeat(100)}value=1234567890123456`,
      stderrCode: "unknown",
    }),
  };
  const tail = sanitizeStatus(status).error?.stderrTail ?? "";
  assert.equal(tail.includes("1234567890123456"), false);
  assert.ok(tail.length <= 1200);
});

test("aggregate status preserves failure retry metadata", () => {
  const status: SafeStatus = {
    phase: "failed",
    projectDirectory: directory,
    generation: 2,
    lastFailureAt: "2026-11-06T00:00:00.000Z",
    nextRetryAt: "2026-11-06T00:00:05.000Z",
    scopes: [
      {
        scope: "global",
        projectDirectory: directory,
        phase: "failed",
        generation: 2,
        lastFailureAt: "2026-11-06T00:00:00.000Z",
        nextRetryAt: "2026-11-06T00:00:05.000Z",
      },
    ],
  };
  const output = sanitizeStatus(status);
  assert.equal(output.lastFailureAt, status.lastFailureAt);
  assert.equal(output.nextRetryAt, status.nextRetryAt);
  assert.equal(output.scopes?.[0]?.nextRetryAt, status.nextRetryAt);
});
