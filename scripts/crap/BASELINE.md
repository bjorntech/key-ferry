# Historical baseline provenance

The checked-in baseline is anchored to commit `66f5cf9`; it must never be
generated from the working tree. Verify the source/identity/fingerprint side
of the baseline with:

```sh
bun scripts/crap/verify-baseline.ts 66f5cf9
```

The verifier obtains every source file with `git show`, analyzes it with the
current CRAP definition, rejects `HEAD` and working-tree input, checks function
counts, exact semantic identities/fingerprints, and cyclomatic complexity, and
prints a SHA-256 digest of the verified entries. The checked-in statement
coverage and CRAP values are **trusted historical metrics**; this verifier does
not claim to re-execute the historical Istanbul test suite. It validates source
provenance and the one-to-one function mapping without synthesizing or
zero-seeding coverage.
