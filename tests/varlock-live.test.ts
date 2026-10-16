import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { projectDirectory, ProjectKeyFerryManager } from "../src/contracts.js";
import { makeProjectKeyFerryManager } from "../src/varlock/manager.js";

// This is deliberately opt-in. The fixture has no credentials and the test
// points Varlock at an isolated config directory, never the user's sessions.
const binary = process.env.VARLOCK_LIVE_BINARY;
const live = Boolean(binary && binary.startsWith("/"));

describe("Varlock live adapter", () => {
  test.skipIf(!live)(
    "starts, refreshes, and disposes an isolated proxy",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "key-ferry-live-"));
      const config = await mkdtemp(join(tmpdir(), "key-ferry-live-config-"));
      const home = join(root, "home");
      const wrapper = join(root, "varlock-wrapper.sh");
      await mkdir(home);
      try {
        await writeFile(
          wrapper,
          [
            "#!/bin/sh",
            `export HOME=${JSON.stringify(home)}`,
            `export XDG_CONFIG_HOME=${JSON.stringify(config)}`,
            // Varlock 1.23.0 officially supports this opt-out env var; keep
            // live tests free of telemetry while preserving production defaults.
            "export VARLOCK_TELEMETRY_DISABLED=1",
            `exec ${JSON.stringify(binary!)} "$@"`,
            "",
          ].join("\n"),
        );
        await chmod(wrapper, 0o700);
        // Keep this fixture synthetic and placeholder-only. No upstream or
        // secret manager is needed for the lifecycle handshake.
        await writeFile(
          join(root, ".env.schema"),
          '# @proxyConfig={egress="strict"}\n# ---\nLIVE_TOKEN=@proxy\n',
        );
        const program = Effect.gen(function* () {
          const manager = yield* ProjectKeyFerryManager;
          const started = yield* manager.ensureStarted;
          expect(started.phase).toBe("ready");
          const environment = yield* manager.environment;
          expect(environment.LIVE_TOKEN).toMatch(/^vlk_placeholder_LIVE_TOKEN_/);
          expect(environment.HTTP_PROXY).toMatch(/^http:\/\/127\.0\.0\.1:/);
          const certPath = environment.NODE_EXTRA_CA_CERTS;
          expect(certPath).toMatch(/\/key-ferry-cert-[^/]+\/ca-cert\.pem$/);
          expect(existsSync(certPath)).toBe(true);
          const refreshed = yield* manager.refresh;
          expect(refreshed.phase).toBe("ready");
          yield* manager.dispose;
          expect((yield* manager.status).phase).toBe("stopped");
          expect(existsSync(certPath)).toBe(false);
        }).pipe(
          Effect.provide(
            makeProjectKeyFerryManager({
              projectDirectory: projectDirectory(root),
              adapter: {
                command: [wrapper],
                environmentKeys: ["LIVE_TOKEN"],
                startupTimeoutMs: 30_000,
                commandTimeoutMs: 10_000,
                reloadTimeoutMs: 30_000,
                pollIntervalMs: 100,
                requireStrictEgress: true,
              },
            }),
          ),
        );
        await Effect.runPromise(Effect.scoped(program));
      } finally {
        await Promise.all([
          rm(root, { recursive: true, force: true }),
          rm(config, { recursive: true, force: true }),
        ]);
      }
    },
    90_000,
  );
});
