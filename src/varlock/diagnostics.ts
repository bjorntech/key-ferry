export type VarlockStderrCode =
  | "op_prompt_dismissed"
  | "op_not_signed_in"
  | "op_auth_failed"
  | "op_bad_vault_reference"
  | "op_multiple_accounts_app_auth"
  | "op_not_found"
  | "varlock_schema_error"
  | "varlock_timeout"
  | "unknown";

const messages: Record<VarlockStderrCode, string> = {
  op_prompt_dismissed: "1Password app authorization prompt dismissed by user",
  op_not_signed_in: "1Password CLI is not signed in",
  op_auth_failed: "1Password authentication failed",
  op_bad_vault_reference: "1Password vault or account reference is invalid",
  op_multiple_accounts_app_auth:
    "Cannot use multiple different 1Password accounts when using CLI auth with batching enabled",
  op_not_found: "The Varlock or 1Password CLI was not found",
  varlock_schema_error: "Varlock schema validation failed",
  varlock_timeout: "Varlock operation timed out",
  unknown: "Varlock failed; see the doctor guidance",
};

export function classifyStderr(stderr: string | undefined): {
  readonly code: VarlockStderrCode;
  readonly message: string;
} {
  const value = stderr ?? "";
  let code: VarlockStderrCode = "unknown";
  if (/dismiss|cancel|declin|reject.*prompt|prompt.*(?:close|dismiss)/i.test(value))
    code = "op_prompt_dismissed";
  else if (/not signed in|not logged in|sign in to 1password/i.test(value))
    code = "op_not_signed_in";
  else if (/authentication failed|auth failed|invalid credentials|unauthorized/i.test(value))
    code = "op_auth_failed";
  else if (
    /BAD_VAULT_REFERENCE|bad vault|vault.*(?:not found|invalid)|account.*(?:not found|invalid)/i.test(
      value,
    )
  )
    code = "op_bad_vault_reference";
  else if (/multiple different 1password accounts|batching enabled/i.test(value))
    code = "op_multiple_accounts_app_auth";
  else if (/command not found|enoent|could not find.*(?:varlock|op)/i.test(value))
    code = "op_not_found";
  else if (/schema|validation|parse error/i.test(value)) code = "varlock_schema_error";
  else if (/timed out|timeout/i.test(value)) code = "varlock_timeout";
  return { code, message: messages[code] };
}

export function safeStderrMessage(
  code: string | undefined,
  message: string | undefined,
): string | undefined {
  if (!code || !(code in messages)) return undefined;
  return messages[code as VarlockStderrCode] === message ? message : undefined;
}
