# Quality checks

This document describes the checks maintained in this repository. It is a
maintainer reference, not a claim of production certification.

## Typecheck, tests, and build

Run the ordinary checks from the repository root:

```sh
bun typecheck
bun test
bun run build
bun pm pack --dry-run
```

The normal test suite uses mocks and synthetic fixtures. The optional Varlock
live fixtures are a separate integration layer: use the globally installed CLI
(for example, Homebrew's `varlock`) or override it with an absolute
`VARLOCK_LIVE_BINARY` path. They use synthetic strict-HTTPS credentials and do
not require provider authentication, production network access, or committed
secrets. See the live-fixture commands in the README.

## Runtime-source coverage

`bun run test:coverage` runs Bun's coverage output and then the repository's
LCOV checker. The checker keeps only runtime sources under `src/`, including
contracts and plugin code, and excludes generated code and test files. It
computes global weighted totals from executable LCOV line records and function
records; Bun's per-file thresholds are not used.

The gate is:

- lines: at least 90%
- functions: at least 75%

The check is a runtime-source gate, not a branch-coverage claim. Bun 1.4.2
does not emit branch coverage in the coverage output used here. CI captures
the LCOV and text report and uploads both on Ubuntu and macOS. The thresholds
and source-selection rules are implemented in
`scripts/check-coverage.ts`, so changes to the gate should update this
document and that checker together.

## Formatting

Use:

```sh
bun run format
bun run format:check
```

Both commands use Oxfmt 0.72.0 and the repository settings aligned with the
Alchemy formatter configuration referenced by `oxfmt.config.ts`. The settings
use double quotes, semicolons, 100-column lines, LF endings, trailing commas,
and import sorting. Markdown and MDX are intentionally ignored by Oxfmt, as
are generated and coverage directories. This document is therefore reviewed
as Markdown rather than treated as Oxfmt-formatted source.

## CRAP policy

CRAP is a per-function quality gate alongside the aggregate runtime-source
coverage gate; it is not a security guarantee. The standard per-function score
is:

```text
CRAP = CC² × (1 − statement coverage)³ + CC
```

where `CC` is cyclomatic complexity and own statement coverage is bounded to
0–1. Coverage is the ratio of covered executable statements owned by that
function, not Istanbul's function-hit percentage. A function with `CC > 6`
cannot pass the threshold of `6`, even at full coverage.

Run the gate with:

```sh
bun run test:crap
```

The runner instruments a temporary mirror of the TypeScript runtime sources
with Istanbul, executes that mirror with Bun, and writes the JSON report to
`coverage/crap.json` in CI (`CRAP_JSON=1 bun run test:crap 2>&1 | tee
coverage/crap.json`). Instrumentation is temporary and is not production
instrumentation. Bun does not provide aggregate branch coverage here; this
policy uses own-statement coverage only.

`quality/crap-baseline.json` is a committed historical baseline generated from
committed `HEAD`, separately from the working-tree metrics. Do not blindly
regenerate it when the gate fails. A semantic AST fingerprint and qualified
scope function identity are used, so formatting changes and source-line shifts
do not reset identity.

Unchanged legacy violations warn. New or modified functions with a score above
6 fail. An unchanged function also fails if its score worsens from the
baseline, even when its resulting score remains below 6. A quality run can
therefore fail while changed functions are being refactored; existing legacy
warnings do not mean that the whole repository has CRAP ≤ 6.

The metric detects complexity and test-coverage regressions; it is not a
security guarantee. Live fixtures and production integration remain separate
verification work and are not established by this gate.
