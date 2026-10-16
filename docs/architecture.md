# OpenCode V2 and Varlock architecture

## Runtime design

The runtime is Effect-native. The installed OpenCode V2 plugin package
exposes a separate native entrypoint, `@opencode/plugin/effect`, and its
dependencies pin `effect` to **4.0.1**. The Promise API is not the foundation
for this project and will not be wrapped superficially.

Verified package facts from `@opencode/plugin@2.0.30`:

```ts
import { Plugin } from "@opencode/plugin/effect"

export default Plugin.define({
  id: "key-ferry",
  effect: (ctx) => Effect.gen(function* () {
    // Native Effect plugin setup.
  }),
})
```

The native plugin type is `effect(context): Effect.Effect<void, never, R>`.
Native registrations and transforms return Effects, and registration disposal
is also an Effect. `ctx.mcp.transform(...)` and `ctx.mcp.reload()` are native
Effect APIs. See the V2 [plugin](https://opencode.ai/v2/docs/build/plugins),
[RPC](https://opencode.ai/v2/docs/build/plugins/rpc), and
[MCP](https://opencode.ai/v2/docs/mcp-servers) documentation.

## Manager boundary

`src/contracts.ts` defines the boundary for the sidecar manager and OpenCode
adapter:

- `ProjectKeyFerryManager` is an Effect `Context.Service` tag.
- `ProjectKeyFerryManagerFactory.layer()` returns a typed `Layer`.
- Sidecar acquisition belongs in a scoped layer using
  `Effect.acquireRelease`.
- The process must be owned by exact PID plus generated ownership/session ID.
- No ambiguous daemon adoption and no global `stop --all` operation.
- `ensureStarted`, `refresh`, and teardown must cooperate with interruption.
- Lifecycle and refresh operations must be serialized internally, represented
  by `withExclusive`.
- `dispose` is idempotent and only stops resources owned by this manager.
- Varlock's public CA material is handled as trust material with the required
  public-readable `0644` permissions; it is not treated as a credential.

The process service is injectable through the `VarlockProcess` Effect service,
so sidecar behavior can be tested without spawning a real process.

## Varlock constraints encoded by the contract

- Never call the Varlock loader from the service if it mutates global
  `process.env`.
- The foreground proxy must be owned and started with project cwd, explicit
  session, and reload support.
- `--allow-reload` is mandatory for the owned proxy process.
- Raw status data may contain endpoint tokens, data-plane tokens, environment
  values, and placeholder overrides. It must remain inside the protocol
  adapter.
- Public `SafeStatus` contains only phase, project path, generation, optional
  PID/endpoint metadata, timestamps, sanitized tagged errors, and safe
  remote-configuration diagnostics.
- `ResolvedEnvironment` is an internal capability only. It must not cross RPC,
  CLI, logging, or model-context boundaries.
- Never forward Varlock's complete `--full` environment map. It may contain
  placeholders and raw `@proxy=passthrough` secrets. The protocol adapter must
  enforce the later-approved placeholder-only allowlist.
- Refresh must have a bounded timeout, account for the CLI's fifteen-minute
  maximum, and fail closed when refresh fails.
- Strict egress is required by default. The manager validates the schema's
  exact `# @proxyConfig={egress="strict"}` header and does not invent an
  unsupported `--allow-domain` flag.
- Local MCP integration uses the supported environment proxy/CA path. It does
  not pretend that a sandbox provides this isolation.

## MCP integration

The adapter has two explicit protection modes under `options.servers`.

```ts
type ServerProtection =
  | { readonly env: readonly string[] | Readonly<Record<string, string>> }
  | {
      readonly remote: {
        readonly headers: Readonly<Record<string, string | {
          readonly env: string
          readonly prefix?: string
          readonly suffix?: string
        }>>
      }
    }
```

Local mappings are injected into the selected local MCP process environment.
Remote mappings are only accepted for a configured `type: "remote"` server
with explicit `oauth: false`. A selected remote server with OAuth omitted or
configured is disabled with a safe diagnostic. An unselected remote server is
left to native OpenCode transport and OAuth handling.

OpenCode V2 exposes `ctx.mcp.transform`, `ctx.mcp.reload`, and the mutable
`Mcp.ServerConfig`, but no public per-server fetch, dispatcher, transport, or
registry extension. Remote protection therefore uses a plugin-owned relay:

```text
OpenCode Streamable HTTP/SSE client
        -> authenticated 127.0.0.1 relay
        -> Varlock HTTP CONNECT proxy
        -> fixed HTTPS MCP origin/path
```

The transformed MCP registry contains only the relay URL, the scoped relay
capability, and safe non-credential headers. Mapped credential headers are
constructed inside the relay from placeholder values. The persisted OpenCode
configuration is never rewritten.

The relay binds to loopback and uses a per-instance token. It forwards
Streamable HTTP POST/GET/DELETE semantics, streams SSE, preserves MCP session
headers, aborts upstream work on downstream cancellation, and rejects
downstream paths that were not registered from the fixed upstream origin. Its
legacy SSE endpoint rewrite is implemented. Registered session routes are
capped at 256; duplicate routes do
not consume capacity and new routes are rejected after the cap. The real
remote Varlock test passes against the synthetic HTTPS fixture.

Relay TLS uses CONNECT followed by one verified `tls.connect` call with the
manager CA, target `servername`, and `rejectUnauthorized: true`. The custom
HTTP agent returns that verified TLS socket for HTTP framing. No global TLS
flags are changed and no certificate verification is weakened. Compressed or
oversized response framing is bounded and fails closed.

Remote target validation requires HTTPS, rejects URL credentials and fragments,
and rejects literal local/private IP targets by default. An explicit
`allowPrivateNetwork` policy can opt into such targets. Corporate DNS names
are not rejected merely because they may resolve to internal addresses. The
relay never accepts an arbitrary downstream URL.

Manager generation is part of relay ownership. On refresh, sidecar loss, or
relay health failure, old relays are stopped, old local capabilities become
invalid, MCP sessions are reset through `ctx.mcp.reload()`, and protected
servers remain disabled until replacement succeeds.

Doctor runs the normal Varlock readiness/environment reconciliation and then
reconciles or recreates unhealthy selected `oauth:false` remote relays. It does
not provide a credential prompt, replace native OAuth, or silently restore a
direct remote connection.

Verification uses native V2 types, mocks, package imports, and synthetic
HTTPS remote transport. The current normal suite passes 53 tests with 2 gated
skips; gated live Varlock fixtures were not run in this rename pass.

## Module ownership

1. `src/contracts.ts`: Effect service tags, layers, scoped lifecycle,
   sanitized errors, process seams, and safe/public versus internal types.
2. `src/varlock/protocol.ts`: pure protocol parsing and placeholder allowlist
   validation. Owned by the protocol track.
3. `src/varlock/manager.ts`: project-scoped service implementation, serialized
   state transitions, fail-closed readiness, refresh, and acquire/release.
4. `src/plugin.ts`: native V2 plugin layer, local/remote MCP transforms, RPC,
   relay lifecycle, and cleanup.
5. `src/rpc.ts`: secret-free status and refresh RPC definitions.
6. `src/options.ts`: validation of explicit project-scoped configuration.
7. `src/tui.ts`: optional status/refresh UX over the RPC shape.
8. `src/remote.ts`: adapter-side remote relay contract, target/header
   validation, placeholder wiring, generation coordination, and safe
   diagnostics.
9. `src/relay/**`: standalone authenticated HTTP relay implementation.
10. Process execution remains behind the injectable process service.

The manager must be acquired before MCP/provider integrations are enabled and
must be released after their registrations are disposed. A failed start or
refresh leaves protected connections disabled rather than falling back to
ambient environment variables.

Cleanup is scope-owned and project-owned: it stops only the sidecar and relay
resources acquired by this plugin instance. It does not perform a global
Varlock shutdown and does not claim full sandbox isolation.
