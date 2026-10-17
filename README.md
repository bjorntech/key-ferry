# @bjorntech/key-ferry

Global and project-scoped Key Ferry credential proxy integration for OpenCode V2.

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
- An installed Varlock CLI and a configured Varlock environment/schema with the
  secrets and proxy rules your MCP servers need
- Configure secret sources and authentication following the
  [Varlock documentation](https://varlock.dev/)

Verification has been exercised with Node 24 and Bun 1.4.2, alongside the
native OpenCode V2 package types and Effect 4.0.1.

## Installation

OpenCode installs configured npm plugins automatically. Add the package to the
global OpenCode plugin configuration (normally `~/.config/opencode/opencode.json`)
and preserve any unrelated entries already there:

```jsonc
{
  "plugins": [
    {
      "package": "@bjorntech/key-ferry",
      "options": {
        "enabled": true,
        "requireStrictEgress": true,
        "projectDirectory": ".",
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
  ]
}
```

The package is configured globally, while `projectDirectory` and the selected
server mappings determine which project context is protected. Unmapped MCP
servers remain under native OpenCode behavior. A selected remote API-key server
must explicitly set `oauth: false`; native OAuth remains unchanged for
unselected servers.

Install the Varlock CLI separately. A shared CLI installation is preferred over
installing it in every project:

```sh
brew install dmno-dev/tap/varlock
varlock --version
```

The plugin does not install Varlock or unlock a secret store. Configure its
environment and authentication separately, following the
[Varlock documentation](https://varlock.dev/).

The package's sibling `./tui` export is discovered automatically when the
server plugin is loaded. Do not add a duplicate `cli.json` entry for an
ordinary server-plugin installation. A global `cli.json` entry is only useful
for a CLI-only deployment or a CLI connected to a remote OpenCode server that
already loaded the server plugin.

Set `projectDirectory` to the Varlock project root containing the schema. The
plugin starts and owns its Varlock sidecar itself; do not wrap OpenCode or
manually run `varlock proxy`.

## Global configuration and project opt-in

The native plugin entry can be installed once in OpenCode's global configuration.
Set `projectConfig.enabled` to `true` to make a project file eligible; it is
`false` by default for backwards compatibility. The global configuration owns
one Varlock group and its mappings. A project at the current OpenCode project
root can add a second, independent group in
`.opencode/key-ferry.jsonc`:

```jsonc
{
  "enabled": true,
  "servers": {
    "project-mcp": { "env": ["PROJECT_API_KEY"] }
  }
}
```

Use [the global example](examples/global/opencode.json), the
[project native example](examples/project/opencode.json), and the
[project mapping example](examples/project/.opencode/key-ferry.jsonc) as copyable
shapes. The project file only maps MCP servers that already exist in the
project's native OpenCode configuration; it does not define or install an MCP
server, and it does not need a second Key Ferry plugin entry. The paired
[native project example](examples/project/opencode.json) shows that separate
definition. The
synthetic `GLOBAL_API_KEY` and `PROJECT_API_KEY` names are schema references,
not credentials; configure each Varlock root and its secret source separately
using the [Varlock documentation](https://varlock.dev/). The project file is
read relative to the canonical project root, not the service
working directory, and its optional `projectDirectory` must remain inside that
root. It contains project mappings only: global mappings, environment keys, and
Varlock schema are never imported or unioned. Project mappings that reuse a
global server name must list that name in `overrides`; otherwise the collision
is rejected. Other globally bound servers are unaffected.

The global `projectConfig.activation` policy is a floor. `"auto"` activates an
eligible project automatically; `"manual"` requires the explicit
`key-ferry.activateProject` command. A project may restrict automatic global
activation with its own `"activation": "manual"`, but cannot escalate a manual
global policy. Manual activation is in-memory for the current location and is
not a stored enrollment list. Status is pure and reports all configured scopes,
including an inactive project scope. Default refresh and doctor retain their
global behavior; scoped project operations act only on the selected active
project group and never activate it. Use `activateProject` first when the
project is awaiting activation.

This opt-in is an execution policy, not an authentication or security boundary.
Varlock providers and `@exec` can execute code, and an untrusted repository is
not sandboxed by this feature. Review project files before enabling global
automatic activation.

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

Use `examples/single-project/.env.schema` only for the legacy single-root example. For the
global/project setup, copy `examples/global/.env.schema` into the configured
global Varlock root and `examples/project/.env.schema` into the project's
separate Varlock root. Do not reuse one combined schema or work around this
separation with Varlock imports: Varlock loads the full schema before Key Ferry
filters requested keys. Mark each remote upstream host with `@proxy(domain="...")` and keep
`@proxyConfig={egress="strict"}`. Configure any secret source through Varlock;
Key Ferry does not install Varlock, create its schema, or configure provider
authentication. Never commit a real secret.

## TUI commands

| Palette command | Slash command | RPC |
| --- | --- | --- |
| `key-ferry.status` | `/key-ferry-status` | `status` |
| `key-ferry.refresh` | `/key-ferry-refresh` | `refresh` |
| `key-ferry.doctor` | `/key-ferry-doctor` | `doctor` |
| `key-ferry.project.activate` | `/key-ferry-project-activate` | `activateProject` |
| `key-ferry.project.refresh` | `/key-ferry-project-refresh` | `refresh({ scope: "project" })` |
| `key-ferry.project.doctor` | `/key-ferry-project-doctor` | `doctor({ scope: "project" })` |

The rename is intentionally breaking for the 0.1.0 release: no `varlock-*`
command aliases are retained.

Refresh and doctor report safe lifecycle and remote-configuration diagnostics.
Project commands select the active project group; they do not activate an
inactive project. `activateProject` starts an eligible manual project once for
the current location. They do not provide credential prompts or collect
credentials. Doctor can
reconcile or recreate unhealthy selected `oauth:false` remote relays after
Varlock readiness succeeds, so authentication still depends on the configured
Varlock context.

Native plugin activation does not imply broker readiness. During startup,
mapped servers remain fail-closed until their group is ready; a healthy group
continues if another group fails. A disabled integration does not register
status RPC, so a 404 is expected.

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

Coverage, formatter, and per-function CRAP-gate details are documented in
[Quality checks](docs/quality.md).

The two live Varlock tests are gated and skipped unless
`VARLOCK_LIVE_BINARY` points to an absolute CLI path. It uses synthetic
fixtures and isolated configuration. No per-test host credential or provider
authentication is required. Run them explicitly with:

```sh
VARLOCK_LIVE_BINARY=/absolute/path/to/varlock bun test tests/varlock-live.test.ts
VARLOCK_LIVE_BINARY=/absolute/path/to/varlock bun test tests/remote-varlock-live.test.ts
```

The normal suite and gated live fixtures are separate verification layers. Run
the commands above as needed; do not treat the normal suite as
certification of every external MCP provider, production deployment, or live
OpenCode TUI session.

See [Architecture](docs/architecture.md),
[Troubleshooting](docs/troubleshooting.md), and
[Quality checks](docs/quality.md),
[the single-project example](examples/single-project/opencode.json), [the global configuration example](examples/global/opencode.json), and [the project file example](examples/project/.opencode/key-ferry.jsonc).
