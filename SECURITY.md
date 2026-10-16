# Security

## Scope and security model

This project provides a native OpenCode V2 Effect plugin with a project-scoped,
owned Varlock CLI proxy sidecar. It is not a wrapper around all of OpenCode.
Local MCP servers are mapped explicitly to proxy placeholders and are disabled
until the sidecar is ready. Selected remote API-key MCP servers are instead
rewritten at runtime to an authenticated, project-scoped loopback relay. The
relay forwards Streamable HTTP and legacy SSE through Varlock's HTTP CONNECT
proxy to the fixed HTTPS target. Both modes fail closed when startup, refresh,
placeholder, relay, or sidecar health checks fail. Connections are scoped to
the OpenCode location and project, not to individual sessions.

The protocol exposes only an allowlisted, sanitized subset of Varlock status
JSON through public RPC. Do not assume that Varlock CLI output is safe to
publish: public CLI status may contain tokens. Full proxy environments may
contain raw passthrough values, but this plugin permits only exact,
placeholder-matched `placeholderOverrides` entries.

Strict egress is required by the manager default and is schema-controlled. The
local MCP path depends on the client honoring the supplied proxy environment.
The remote relay controls its configured outbound dispatcher instead of relying
on that client behavior, but this is not a sandbox or a claim of universal
network isolation. A same-user process may access configured secret stores,
files, configuration, or daemons. Direct provider/API transports are not
implemented. Unselected remote servers and native MCP OAuth handling remain
unchanged; this project does not replace OAuth.

Remote relay selection requires an explicit native `oauth: false` and exact
header-to-environment mappings. OAuth-enabled or OAuth-default remote servers
are disabled when selected for Varlock protection rather than silently
downgraded or sent directly. The relay binds to loopback, authenticates every
request with a scoped token, rejects unregistered downstream paths, and
invalidates old capabilities on manager generation changes.

Doctor rechecks Varlock readiness and can reconcile or recreate unhealthy
selected `oauth:false` relays. It does not provide a credential prompt or
replace native OAuth. Each relay caps registered session routes at 256;
duplicates do not consume capacity and new routes are rejected after the cap.
Relay TLS uses CONNECT and one verified `tls.connect` with the manager CA,
target `servername`, and `rejectUnauthorized: true`; the custom HTTP agent
returns that socket for HTTP framing. No global TLS flags are changed and
certificate verification is not weakened. Compressed or oversized framing
fails closed within configured limits.

Remote target URLs must be HTTPS without credentials or fragments. Literal
private/local targets require explicit `allowPrivateNetwork: true`; normal
corporate DNS names are not rejected solely because they may resolve
internally. The relay uses the configured target origin/path and never accepts
an arbitrary destination from downstream MCP traffic.

Varlock's public CA is trusted by the relay at the IO boundary, while raw
secret values remain outside OpenCode. CA MITM support and response scrubbing
have limitations; not every response payload is guaranteed scrubbed. Do not
place secret values in logs, errors, RPC payloads, issue reports, or support output.
The public CA file uses Varlock's required `0644` trust-material permissions;
it is not a secret. Cleanup is scoped to resources acquired by this project
instance and never invokes a global Varlock shutdown.
The plugin does not mutate `process.env`.

The synthetic HTTPS remote fixture and real Varlock 1.23 flow pass. This does
not imply verification against every external MCP provider or a live OpenCode
TUI session. Native V2 types, mocks, package imports, and synthetic live
fixtures are covered by the project verification commands.

## Reporting a vulnerability

Report vulnerabilities through the repository's GitHub security reporting
mechanism for `bjorntech/key-ferry`. Do not open a public issue for an
unfixed vulnerability. Include reproduction steps and impact, but never
include secret values, tokens, credentials, or complete sensitive output.

The report should identify the affected version or commit and whether the
issue involves the plugin, the Varlock CLI dependency, OpenCode, or an MCP
server. Do not assume that a Varlock or OpenCode issue is fixed by this plugin.

## Dependency and deployment guidance

Use supported, pinned dependency versions and review changes to the OpenCode
V2 plugin API, Effect 4, Bun, and the Varlock CLI before upgrading. Run the
sidecar with the least privilege available to the project and user. Do not
enable real secret-manager or network integration in automated tests unless a
separate, explicitly controlled environment is being used.
