# @bjorntech/key-ferry

Project-scoped Key Ferry credential proxy integration for OpenCode V2.

This checkout is private and unpublished. The unscoped npm name
`opencode-varlock` is an unrelated third-party OpenCode V1/MPL
plugin. Use this checkout's absolute path, not that package name.

## What it protects

The native Effect 4 plugin owns a project-scoped Varlock proxy process and
protects explicitly selected MCP servers:

- Local MCP servers receive placeholder-backed environment mappings.
- Remote API-key MCP servers use an authenticated, scoped loopback relay.
  The relay forwards Streamable HTTP and legacy SSE through Varlock's HTTP
  CONNECT proxy to the configured HTTPS endpoint.
- Startup, refresh, missing-placeholder, relay, and sidecar failures fail
  closed. There is no direct-transport fallback.
- Unselected remote servers, including native OAuth servers, remain unchanged.

The plugin never wraps OpenCode, mutates global `process.env`, or stores real
secret values in OpenCode configuration. Public status, RPC, and TUI output
never expose relay tokens, environment values, CA contents, or raw daemon
output.

This is scoped credential-proxy routing, not a full sandbox. Same-user
processes can still access normal files, stores, and daemons. The remote relay
controls its configured outbound path rather than relying on the MCP client to
honor proxy environment variables, but response payloads are not guaranteed
to have every secret scrubbed.
Direct provider/API transport protection is not included.

## Requirements

- OpenCode V2 with native `@opencode/plugin/effect`
- `@opencode/plugin` 2.0.30-compatible runtime
- Effect 4.0.1-compatible runtime
- Node.js 22 or newer
- Varlock CLI 1.23.0 installed separately as `varlock`
- A project `.env.schema` understood by Varlock

Verification has been exercised with Node 24 and Bun 1.4.2, alongside the
native OpenCode V2 package types and Effect 4.0.1.

## Minimal local setup

Build this private checkout:

```sh
bun install --frozen-lockfile
bun run build
```

In the project OpenCode should open, add the server plugin to
`opencode.jsonc`. Replace the absolute checkout path and illustrative MCP
commands:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "/absolute/path/to/key-ferry",
      "options": {
        "enabled": true,
        "requireStrictEgress": true,
        "servers": {
          "example-local-mcp": { "env": ["FAKE_API_KEY"] },
          "example-remote-mcp": {
            "remote": {
              "headers": {
                "Authorization": { "env": "REMOTE_API_KEY", "prefix": "Bearer " }
              }
            }
          }
        }
      }
    }
  ],
  "mcp": {
    "servers": {
      "example-local-mcp": {
        "type": "local",
        "command": ["node", "./path/to/your-local-mcp.mjs"]
      },
      "example-remote-mcp": {
        "type": "remote",
        "url": "https://mcp.example.test/mcp",
        "oauth": false
      }
    }
  }
}
```

The selected remote server must explicitly set `oauth: false`. This is an
API-key relay mode, not an OAuth replacement. If `oauth` is omitted or is an
OAuth object, the selected server is disabled with a safe diagnostic. Remove
the Varlock mapping to leave native OAuth enabled.

The package's sibling `./tui` export is discovered automatically when the
server plugin is loaded from `opencode.json(c)`. A duplicate `cli.json` entry
is not required. An optional global `cli.json` entry is useful only for a
CLI-only plugin deployment or when connecting to a remote OpenCode server
that already has this server plugin loaded:

```jsonc
{
  "plugins": [
    { "package": "/absolute/path/to/key-ferry" }
  ]
}
```

There is no project-local `cli.json` setup. Do not install the unscoped npm
package and do not use a project-relative package path for this unpublished
checkout.

## Configuration

Local mappings preserve the MCP command, cwd, and unrelated environment:

```jsonc
"example-local-mcp": {
  "env": { "UPSTREAM_API_KEY": "FAKE_API_KEY" }
}
```

Remote mappings map target HTTP headers to exact Varlock environment names.
The string form is an environment reference, never a raw header value:

```jsonc
"example-remote-mcp": {
  "remote": {
    "headers": {
      "Authorization": { "env": "REMOTE_API_KEY", "prefix": "Bearer " },
      "X-Tenant": { "env": "REMOTE_TENANT", "suffix": "-synthetic" }
    }
  }
}
```

Header names are validated for control, hop-by-hop, protocol, duplicate, and
credential-confusion cases. The target URL comes from the native MCP remote
configuration, not from the relay mapping. HTTPS credentials and fragments
are rejected. Literal local/private IP targets are rejected unless the
explicit `allowPrivateNetwork: true` policy is set. Normal corporate DNS
names are not rejected merely because they may resolve internally.

Use `examples/.env.schema` for synthetic strict-egress values only. Mark each
remote upstream host with `@proxy(domain="...")` and keep
`@proxyConfig={egress="strict"}`. Never commit a real secret.

## TUI commands

| Palette command | Slash command | RPC |
| --- | --- | --- |
| `key-ferry.status` | `/key-ferry-status` | `status` |
| `key-ferry.refresh` | `/key-ferry-refresh` | `refresh` |
| `key-ferry.doctor` | `/key-ferry-doctor` | `doctor` |

The rename is intentionally breaking for this unpublished package: no `varlock-*`
command aliases are retained.

Refresh and doctor report safe lifecycle and remote-configuration diagnostics.
They do not provide credential prompts or collect credentials. Doctor can
reconcile or recreate unhealthy selected `oauth:false` remote relays after
Varlock readiness succeeds, so authentication still depends on the configured
Varlock context.

## Transport and lifecycle limits

The relay supports Streamable HTTP POST/GET/DELETE, streaming SSE, scoped
loopback authentication, bounded request handling, and session URL rewriting
for legacy SSE endpoints. Modern Streamable HTTP and legacy SSE responses are
streamed through bounded framing; compressed or oversized traffic fails closed
within the configured limits. A relay maintains at most 256 registered session
routes; duplicate registrations do not consume capacity, and new routes are
rejected after the cap. Native MCP session state is reset when Varlock refresh
changes the manager generation or when the relay is replaced. Existing remote
sessions must reconnect.

Varlock's public CA is read at the IO boundary and trusted by the relay. The
CA is not a secret, while raw secret values remain outside OpenCode. This is
not a complete response-content scrubber and does not replace native OAuth.
The public CA uses Varlock's required `0644` trust-material permissions.
Cleanup is scoped to this project instance and never performs a global
Varlock shutdown.

The packed root, TUI, and relay import paths are verified together. No wrapper
process is needed.

## Verification

```sh
bun typecheck
bun test
bun run build
```

The two live Varlock tests are gated and skipped unless
`VARLOCK_LIVE_BINARY` points to an absolute CLI path. It uses synthetic
fixtures and isolated configuration. No per-test host credential or provider
authentication is required. Run them explicitly with:

```sh
VARLOCK_LIVE_BINARY=/absolute/path/to/varlock bun test tests/varlock-live.test.ts
VARLOCK_LIVE_BINARY=/absolute/path/to/varlock bun test tests/remote-varlock-live.test.ts
```

Current local verification: `bun test` passes 53 tests with 2 gated skips.
The gated live Varlock fixtures were not run in this rename pass.

See [Architecture](docs/architecture.md),
[Troubleshooting](docs/troubleshooting.md), and
[the example configuration](examples/opencode.jsonc).
