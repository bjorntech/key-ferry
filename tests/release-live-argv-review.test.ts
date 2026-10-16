import { describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { runVerifiedPublish } from "../scripts/release/publish-verified.mjs";

const execFileAsync = promisify(execFile);
const scriptPath = resolve("scripts/release/publish-verified.mjs");
const manifestBase = {
  name: "@bjorntech/key-ferry",
  version: "0.1.3",
  tag: "v0.1.3",
  commit: "f3eaa374eab1d8fde18053d7e1f3fee04af4f17a",
  filename: "bjorntech-key-ferry-0.1.3.tgz",
};

async function withRelease(
  callback: (paths: {
    manifestPath: string;
    packagePath: string;
    artifactPath: string;
  }) => Promise<void>,
) {
  const directory = await mkdtemp(join(tmpdir(), "key-ferry-live-release-"));
  const artifactPath = join(directory, manifestBase.filename);
  const bytes = Buffer.from("trusted release artifact");
  await writeFile(artifactPath, bytes);
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({ name: manifestBase.name, version: manifestBase.version }),
  );
  await writeFile(
    join(directory, "manifest.json"),
    JSON.stringify({ ...manifestBase, sha256: createHash("sha256").update(bytes).digest("hex") }),
  );
  try {
    await callback({
      manifestPath: join(directory, "manifest.json"),
      packagePath: join(directory, "package.json"),
      artifactPath,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("verified release live npm invocation", () => {
  test("publish mode captures the real npm argv without an internal --publish flag", async () => {
    await withRelease(async ({ manifestPath, packagePath, artifactPath }) => {
      let invocation:
        | { executable: string; args: string[]; options: { env: NodeJS.ProcessEnv } }
        | undefined;
      await runVerifiedPublish({
        manifestPath,
        packagePath,
        action: "--publish",
        execute: async (executable, args, options) => {
          invocation = { executable, args, options: options as { env: NodeJS.ProcessEnv } };
        },
        environment: {
          ...process.env,
          NPM_TOKEN: "npm-token-canary",
          NODE_AUTH_TOKEN: "node-auth-canary",
          ACTIONS_ID_TOKEN_REQUEST_URL: "oidc-url-canary",
          ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc-token-canary",
          GITHUB_ACTIONS: "true",
          GITHUB_REPOSITORY: "bjorntech/key-ferry",
        },
      });

      expect(invocation?.executable).toBe("npm");
      expect(invocation?.args).toEqual([
        "publish",
        artifactPath,
        "--access",
        "public",
        "--registry=https://registry.npmjs.org",
        "--provenance",
        "--ignore-scripts",
      ]);
      expect(invocation?.args).not.toContain("--publish");
      expect(invocation?.args).not.toContain("--dry-run");
      expect(invocation?.options.env.NPM_TOKEN).toBeUndefined();
      expect(invocation?.options.env.NODE_AUTH_TOKEN).toBeUndefined();
      expect(invocation?.options.env.ACTIONS_ID_TOKEN_REQUEST_URL).toBe("oidc-url-canary");
      expect(invocation?.options.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN).toBe("oidc-token-canary");
      expect(invocation?.options.env.GITHUB_ACTIONS).toBe("true");
      expect(invocation?.options.env.GITHUB_REPOSITORY).toBe("bjorntech/key-ferry");
    });
  });

  test("dry-run is exactly the live argv plus npm's dry-run switch", async () => {
    await withRelease(async ({ manifestPath, packagePath, artifactPath }) => {
      const invocations: string[][] = [];
      const execute = async (_executable: string, args: string[]) => {
        invocations.push(args);
      };
      await runVerifiedPublish({ manifestPath, packagePath, action: "--publish", execute });
      await runVerifiedPublish({ manifestPath, packagePath, action: "--dry-run", execute });
      expect(invocations[1]).toEqual([...invocations[0], "--dry-run"]);
      expect(invocations[0]).toContain(artifactPath);
      expect(invocations[0]).toContain("--registry=https://registry.npmjs.org");
      expect(invocations[0]).toContain("--provenance");
      expect(invocations[0]).toContain("--ignore-scripts");
    });
  });

  test("missing, unknown, and combined CLI modes fail before npm can be executed", async () => {
    await withRelease(async ({ manifestPath }) => {
      for (const args of [
        ["--manifest", manifestPath],
        ["--manifest", manifestPath, "--unknown-mode"],
        ["--manifest", manifestPath, "--dry-run", "--publish"],
      ]) {
        await expect(execFileAsync(process.execPath, [scriptPath, ...args])).rejects.toThrow();
      }
    });
  });

  test("programmatic invocation rejects an unknown action", async () => {
    await withRelease(async ({ manifestPath, packagePath }) => {
      await expect(
        runVerifiedPublish({ manifestPath, packagePath, action: "--unknown" }),
      ).rejects.toThrow("explicitly --dry-run or --publish");
    });
  });
});
