# Release checklist

This is a maintainer runbook. Nothing in this document performs a release,
changes repository settings, creates a tag, pushes code, or publishes to npm.
Do not put npm credentials or long-lived publish tokens in the repository or in
chat.

## One-time account and repository setup

Complete these steps interactively, using an account that owns the
`@bjorntech` scope and has publish permission. Verify the scope ownership,
account/org access, and 2FA before continuing.

1. Decide whether the repository should be public. npm provenance for this
   package requires the public repository/package policy used by this project;
   in GitHub, use **Settings → General → Danger Zone → Change visibility** and
   make the repository public if that is the approved decision. This is a
   manual decision, not an automated release step.
2. Create the GitHub environment named exactly `production`. Configure its
   required reviewers (do not enable self-review if that would defeat the
   approval policy), and restrict deployments to the approved stable version
   tag pattern (`v*`). Protect tag creation and `main` with the repository's
   normal branch/ruleset policy.
3. Push the release workflow and its supporting release scripts to `main`
   before configuring npm Trusted Publishing. The fixed workflow filename is
   `.github/workflows/publish.yml`.
4. Bootstrap the package if it does not yet exist on npm. For the initial
   `0.1.0` release, run the normal quality/build gates below, then use one
   interactive browser/2FA login and publish from the repository:

   ```sh
   npm login
   npm publish --access public
   ```

   Do not add `--provenance` to this local bootstrap publish. This initial
   publication does not validate OIDC, and `0.1.0` must not be tagged and
   published again after it already exists.
5. Shortly before the next genuine release, configure npm Trusted Publishing
   for the package at **Package settings → Trusted Publisher** with:
   - provider: **GitHub Actions**
   - organization/owner: `bjorntech`
   - repository: `key-ferry`
   - workflow filename: `publish.yml`
   - environment: `production`

   Use npm's current UI field names if they differ. A newly created,
   unvalidated configuration expires after 48 hours without a successful
   publish, so do not create a fake release merely to test it. Configure it
   for the next real version (for example, `0.1.5`) after the bootstrap
   package exists. See [npm Trusted Publishers](https://docs.npmjs.com/trusted-publishers/)
   and the [npm trust command reference](https://docs.npmjs.com/cli/v12/commands/npm-trust).
6. After the first successful OIDC release, consider enabling npm's **Require
   two-factor authentication** and **Disallow tokens** package controls, and
   lock down classic publishing as allowed by the account policy. Trusted
   publishing uses the GitHub OIDC exchange; it does not require an
   `NPM_TOKEN`, `NODE_AUTH_TOKEN`, or another repository secret.

## Quality gates

From the repository root, run the normal gates before committing a release:

```sh
bun install --frozen-lockfile
bun run format:check
bun typecheck
bun test
bun run test:coverage
bun run test:crap
bun run build
bun pm pack --dry-run
```

The coverage gate requires aggregate runtime-source coverage of at least 90%
for lines and 75% for functions. The CRAP gate requires new or changed
functions to score at most 6; unchanged legacy violations warn, while
regressions against the committed baseline fail. Review the reports rather
than hard-coding their current counts.

Run the two opt-in Varlock fixtures separately with a configured CLI path and
synthetic isolated fixtures:

```sh
VARLOCK_LIVE_BINARY=/absolute/path/to/varlock bun test tests/varlock-live.test.ts
VARLOCK_LIVE_BINARY=/absolute/path/to/varlock bun test tests/remote-varlock-live.test.ts
```

These fixtures do not substitute for production deployment or compatibility
testing with every external MCP service.

## Release and tag flow

1. Review the package version, changelog, exports, generated package contents,
   public-scope permissions, repository visibility, and the complete release
   diff. Set a new, genuine semver version; never retry a version that npm has
   already accepted. Update the lockfile consistently and rerun all gates.
2. Commit the reviewed source and workflow changes, push the selected branch,
   and wait for the commit to be available on `main`.
3. Create and push the matching stable tag only after explicit approval:

   ```sh
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

   The tag must point at the reviewed release commit and its version must
   match `package.json` exactly. Stable tags are the only automatic publish
   trigger; the workflow does not publish from `main`.
4. `.github/workflows/publish.yml` runs on GitHub-hosted Ubuntu with the
   pinned Node 24.22/npm 12.2/Bun 1.4.2 toolchain and verified action SHA
   pins. Its unprivileged `verify` job has contents-read permission, runs the
   quality/build checks, and creates the tarball artifact. The privileged
   `publish` job has contents-read and `id-token: write`, waits for the
   `production` environment approval, and publishes **exactly the verified
   tarball** with `--access public --provenance --ignore-scripts`.

   The quality/build job is the gate: the publish job must not re-execute
   source or dependency installation in a privileged context. The
   `--ignore-scripts` flag is intentional for the final artifact publication,
   not a way to bypass the quality gates.
5. For a manually started run, select an existing stable tag as the workflow
   ref. For example:

   ```sh
   gh workflow run publish.yml --ref vX.Y.Z
   ```

   Do not dispatch from `main` or use an arbitrary branch. At the environment
   approval, inspect the tag, commit, tarball, and checksum before approving.
   After publication, verify the exact registry version, provenance, public
   access, clean installation, and the documented OpenCode V2 plugin/TUI
   discovery path.

## Troubleshooting

- **Package not found (404):** complete the one-time interactive bootstrap;
  Trusted Publishing cannot create the first package.
- **OIDC token missing:** check that the publish job has exactly the runtime
  `id-token: write` permission and that the environment name is exactly
  `production`.
- **Provenance or repository failure:** verify the package is public, the
  Trusted Publisher fields match `bjorntech/key-ferry` and `publish.yml`, and
  the run is from a stable tag.
- **Configuration expired:** recreate it shortly before the next genuine
  release; do not manufacture an empty or fake release.
- **Version already exists:** check the registry first, then increment to a
  new genuine version. Do not blindly retry or attempt to overwrite it.
- **Quality failure:** fix the source and rerun the gates. Do not use
  `--ignore-scripts` indiscriminately or bypass the verification job.
