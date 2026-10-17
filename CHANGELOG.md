# Changelog

## 0.1.9 — 2026-10-17

### Added

- Added opt-in global-to-project configuration loading with independent global
  and project Varlock brokers, explicit activation policy, scoped RPC/TUI
  controls, and fail-closed project name collision handling.
- Added public global/project configuration examples while preserving the
  existing single-project example and mapping shape.

## 0.1.8 — 2026-10-17

This patch release shares compatible Varlock broker state across configured
contexts while keeping MCP mappings and relay handles scoped to each plugin
location.

### Fixed

- Shared one owned broker for contexts with the same canonical Varlock root,
  effective options, and factory within the importing process.
- Kept plugin initialization fast by registering status and control handlers
  before background startup; protected MCP servers remain disabled until the
  broker is ready.
- Cached failed startup state and made explicit Refresh or Doctor operations
  retry through one shared attempt, without automatic retries from new
  locations or status checks.
- Gated all consumers on shared refresh completion and cleaned up owned
  resources when the last scoped lease is released, without blocking unrelated
  broker keys.

## 0.1.7 — 2026-10-17

This patch release hardens process ownership and Varlock lifecycle
cancellation, and completes the quality-checker baseline migration. It does
not claim to diagnose or fix repeated 1Password prompts.

### Fixed

- Bound, joined, and idempotently cleaned up owned subprocesses, including
  eager asynchronous spawn-failure handling and valid PID capture.
- Preserved startup and refresh interruption ownership, generation/readiness
  semantics, and safe certificate-directory handling.
- Made certificate allocation lazy and transactional, including late Promise
  cancellation scoping.
- Refactored validator helpers without changing behavior.

### Quality

- Completed AST semantic fingerprints, canonical IDs, historical-baseline
  ratcheting, and isolated synthetic fixtures for the CRAP checker.

## 0.1.6 — 2026-10-16

This patch release hardens plugin activation and retains atomic lifecycle
readiness. Registered plugins without an `enabled` option remain enabled by
default.

### Fixed

- Remove non-reentrant startup and refresh semaphore deadlocks that could make
  plugin activation or refresh time out.
- Validate options and short-circuit explicitly disabled registrations before
  reading the project location or initializing the manager.

## 0.1.5 — 2026-10-16

This patch release completes child-process cleanup after forced termination.
It contains no new runtime feature surface.

### Fixed

- Deterministically terminate and reap children after `SIGKILL`, with a bounded
  one-second cleanup fallback and a stopped-state guard after completion.
- Cover the already-exited and PID-polling regressions, including the flaky
  macOS case and the repeated process-stress matrix.
- Restrict publish workflow execution to main pushes and pull requests, rather
  than tag events, while preserving the release quality gates.

## 0.1.4 — 2026-10-16

This release carries forward the previously unreleased 0.1.3 publishing
candidate's validation. It fixes the shared verified-publish helper's release
artifact path handling, keeps publisher mode flags out of npm arguments, and
makes the exact npm 12.2 dry-run and publish actions explicit in CI with live
argument capture and replay checks, including npm provenance automation
validation. It contains no runtime feature changes.

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
