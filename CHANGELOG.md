# Changelog

## 0.1.3 — 2026-10-16

This release carries forward the previously unreleased 0.1.2 publishing
candidate's validation. It fixes the shared verified-publish helper's release
artifact path handling and makes the exact npm 12.2 dry-run and publish actions
explicit in CI, including npm provenance automation validation. It contains no
runtime feature changes.

## 0.1.0 — 2026-10-16

This entry records the first public release and its maintainer verification
requirements.

### Added

- Native OpenCode V2 Effect plugin integration using the `@opencode/plugin/effect`
  entrypoint.
- Project-scoped Varlock sidecar ownership with serialized lifecycle, refresh,
  and cleanup.
- Explicit local MCP environment mappings backed by Varlock placeholders.
- Selected remote API-key MCP support through an authenticated loopback relay,
  Varlock HTTP CONNECT, fixed HTTPS targets, Streamable HTTP, and legacy SSE.
- Secret-free status, refresh, doctor, and TUI integrations.
- Strict-egress configuration examples, architecture documentation, and
  troubleshooting guidance.
- A deterministic runtime-source coverage gate and Oxfmt formatting checks for
  maintainer verification.
- Deterministic process-failure tests covering fail-closed lifecycle paths.
- A per-function CRAP quality gate with a committed historical baseline,
  semantic function identity, legacy warnings, and regression ratcheting.
- Startup and refresh correctness hardening, including refactoring uncovered
  high-complexity paths under the quality gates.

### Limits and security boundaries

- Native OAuth and unmapped remote servers remain under OpenCode's normal
  behavior; selected remote mappings require explicit `oauth: false`.
- This is not a sandbox or universal network-isolation layer. Local clients
  must honor the supplied proxy environment, same-user processes can access
  ordinary files and stores, and response payloads are not guaranteed to have
  every secret scrubbed.
- Direct provider/API transports are not protected by this plugin.
- Relay session routes are bounded, and refresh or relay replacement requires
  remote MCP sessions to reconnect.

### Verification

The repository provides Bun typecheck, test, build, and package dry-run
commands. Tests use mocks and synthetic fixtures; the Varlock live fixtures are
opt-in. These checks do not constitute production certification, compatibility
with every external MCP provider, or a fully live OpenCode host/TUI run.
