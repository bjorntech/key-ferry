# Troubleshooting

This integration is a native OpenCode V2 Effect plugin. It manages an owned,
project-scoped Varlock CLI proxy process. Start OpenCode normally from the
project directory. Do not wrap OpenCode with `varlock proxy`.

## Before starting

Install Varlock CLI **1.23.0** separately and make sure `varlock` is on `PATH`:

```sh
varlock --version
varlock proxy --help
```

The plugin does not install Varlock, unlock secret stores, or read credentials
for diagnostics. It expects a valid `.env.schema` in the configured project.
Configure the Varlock environment, secret source, authentication, and proxy
rules before starting OpenCode, following the [Varlock documentation](https://varlock.dev/).

The integration protects explicitly mapped local MCP servers and selected
remote API-key MCP servers. Direct provider transports are not isolated.
Remote servers not selected by this plugin, including OAuth-only servers, keep
native OpenCode OAuth and transport behavior.

## Plugin does not load

Add `@bjorntech/key-ferry@0.1.1` to the OpenCode V2 `plugins` list and preserve
unrelated configuration. OpenCode installs configured npm plugins
automatically. Install Varlock separately, preferably with
`brew install dmno-dev/tap/varlock`.

Configure the server plugin from `opencode.json(c)`. OpenCode V2 discovers the
package's sibling `./tui` export automatically, so a duplicate global
`cli.json` entry is not needed. A global `cli.json` entry is optional only when
the CLI connects to a remote OpenCode server that already loaded the server
plugin, or for a genuinely CLI-only deployment. There is no project-local
`cli.json` setup.

The plugin requires OpenCode V2's native Effect entrypoint, compatible with
`@opencode/plugin` 2.0.30 and Effect 4.0.1. Do not load it through the Promise
entrypoint. The package declares Node >=22; Bun 1.4.2 is used by this project
for development and CI.

If OpenCode reports a plugin import or entrypoint error, check the built
package exports and restart the OpenCode service after rebuilding.

Relative `projectDirectory` values are resolved against OpenCode's project
directory and canonicalized before the sidecar starts. The resulting canonical
directory is used for Varlock ownership matching and safe status output.

## MCP server is disabled

The plugin changes only names listed in `options.servers`. Each mapping is
output environment name to an exact Varlock placeholder name. An array is a
same-name mapping:

```jsonc
"servers": {
  "example-local-mcp": {
    "env": ["FAKE_API_KEY"]
  }
}
```

An object supports an explicit mapping:

```jsonc
"servers": {
  "example-local-mcp": {
    "env": { "UPSTREAM_KEY": "FAKE_API_KEY" }
  }
}
```

The MCP server must already exist in `mcp.servers` and must be `type: "local"`.
Remote or missing servers are not silently routed. Replace the illustrative
command in `examples/opencode.jsonc` with a real local MCP command before
launching it; the example command is not an installed fixture.

The server remains disabled when the sidecar is not ready, startup or refresh
fails, a mapped placeholder is absent, or the project explicitly disabled the
server. This is fail-closed behavior. A later successful refresh can restore a
server that the plugin disabled, but never one explicitly disabled in project
configuration.

## Remote MCP server is disabled

Select a remote server with a `remote.headers` mapping only when the native
MCP configuration explicitly uses `oauth: false`:

```jsonc
{
  "type": "remote",
  "url": "https://mcp.example.test/mcp",
  "oauth": false
}
```

The plugin then creates an authenticated loopback relay. Header mappings refer
to exact Varlock environment names, not raw values:

```jsonc
"remote-tools": {
  "remote": {
    "headers": {
      "Authorization": { "env": "REMOTE_API_KEY", "prefix": "Bearer " },
      "X-Tenant": "REMOTE_TENANT"
    }
  }
}
```

If `oauth` is omitted or is an OAuth object, the selected server is disabled
with a safe diagnostic. Remove the mapping to preserve native OAuth, or
explicitly choose API-key mode with `oauth: false`. The plugin never silently
disables OAuth or falls back to the direct remote URL.

The remote URL must be HTTPS without URL credentials or a fragment. Literal
loopback, private, link-local, and metadata IP targets are rejected unless
`allowPrivateNetwork: true` is explicitly configured. Corporate DNS names are
allowed. The relay target is fixed from the configured server and cannot be
chosen by a downstream MCP request.

The relay supports Streamable HTTP and legacy SSE, including streaming,
session headers, DELETE termination, cancellation, and same-origin legacy SSE
endpoint rewriting. It caps registered session routes at 256, rejects new
routes after the cap, and does not count duplicate registrations. A Varlock
refresh or relay replacement resets native MCP sessions. Existing sessions
must reconnect.

Verification status: the synthetic HTTPS remote Varlock test passes. This
does not claim compatibility with every external MCP provider or a live
OpenCode TUI session.

## Strict egress or schema errors

With `requireStrictEgress: true`, the manager requires the Varlock schema to
use strict egress. The schema header syntax is:

```env-spec
# @proxyConfig={egress="strict"}
# ---
```

Route a protected item with an item decorator, for example:

```env-spec
# @proxy(domain="api.example.test")
FAKE_API_KEY=sk-test-000000000000000000000000
```

`@proxy(domain=...)` on an item creates the injection rule. A header-level
proxy rule alone does not inject an item. Do not use a real key in examples or
diagnostics.

The plugin's protocol accepts only exact placeholder matches. `@proxy=passthrough`
values are allowed by Varlock for child environments, but they are not a
wildcard source for this integration and cannot satisfy an unrelated mapping.

## Proxy-aware SDK behavior

An explicitly mapped local MCP process receives proxy-related environment
wiring only when the proxy is ready. A local client that ignores or overwrites
those variables can bypass the intended route.

An explicitly mapped remote MCP server uses the authenticated relay instead of
native direct transport. The relay sends placeholder-bearing headers through
Varlock's HTTP CONNECT proxy to the fixed HTTPS target, so remote routing does
not depend on the MCP client honoring environment proxy variables. CA MITM
support and response scrubbing still have limitations. This integration is not
a sandbox and cannot isolate a same-user process from stores, files, or daemons.

## Refresh, status, and doctor

The server plugin exposes the `key-ferry` RPC with `status`, `refresh`,
and `doctor` methods. These return sanitized phase, project, generation, PID,
endpoint metadata, safe configuration diagnostics, and safe error codes. They
do not return environment maps, relay capabilities or tokens, CA material, or
secret values.

If refresh fails, protected servers are disabled and the failure is reported
as a sanitized `unavailable` RPC error. Doctor first ensures Varlock state and
then reconciles or recreates unhealthy selected `oauth:false` remote relays;
it does not silently authenticate or replace native OAuth. Check the Varlock
schema and configured authentication context, then use `/key-ferry-refresh` or
`/key-ferry-doctor`, or the matching Varlock palette commands, when the TUI is
available. Do not manually stop unrelated Varlock processes: only the process
owned by this project manager is eligible for cleanup.

## Verify the installation

These commands do not contact a real service or require credentials:

```sh
bun typecheck
bun test
bun run build
```

An opt-in live test is available with `VARLOCK_LIVE_BINARY` set to an absolute
Varlock CLI path. It uses a synthetic fixture and isolated XDG configuration.
Do not enable real secret-manager, OAuth, or network tests in CI.

The remote live fixture is gated and skipped by default:

```sh
VARLOCK_LIVE_BINARY=/absolute/path/to/varlock bun test tests/remote-varlock-live.test.ts
```

That command is a gated synthetic compatibility check. The normal suite and
live fixtures are separate verification layers; these commands do not certify
production deployments, every external MCP provider, or a fully live OpenCode
host/TUI session.
