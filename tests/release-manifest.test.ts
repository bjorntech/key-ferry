import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readReleaseManifest } from "../scripts/release/read-manifest.mjs";

const validManifest = {
  name: "@bjorntech/key-ferry",
  version: "0.1.1",
  tag: "v0.1.1",
  commit: "f3eaa374eab1d8fde18053d7e1f3fee04af4f17a",
  filename: "bjorntech-key-ferry-0.1.1.tgz",
  sha256: "a".repeat(64),
};

async function withManifest(value: unknown, callback: (path: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "key-ferry-release-"));
  const path = join(directory, "manifest.json");
  await writeFile(path, JSON.stringify(value));
  try {
    await callback(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("release manifest loading", () => {
  test("loads the JSON object once without a double-parse failure", async () => {
    await withManifest(validManifest, async (path) => {
      await expect(readReleaseManifest(path)).resolves.toEqual(validManifest);
    });
  });

  test("rejects malformed metadata and unsafe filenames", async () => {
    await withManifest({ ...validManifest, filename: "../release.tgz" }, async (path) => {
      await expect(readReleaseManifest(path)).rejects.toThrow("unsafe tarball filename");
    });
    await withManifest({ ...validManifest, commit: "not-a-sha" }, async (path) => {
      await expect(readReleaseManifest(path)).rejects.toThrow("invalid release commit");
    });
    await withManifest({ ...validManifest, extra: true }, async (path) => {
      await expect(readReleaseManifest(path)).rejects.toThrow("invalid release manifest fields");
    });
  });
});

import { createHash } from "node:crypto";
import { symlink } from "node:fs/promises";
import {
  buildNpmArgs,
  getVerifiedPublishCommand,
  runVerifiedPublish,
} from "../scripts/release/publish-verified.mjs";

async function withRelease(callback: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "key-ferry-publish-"));
  const artifact = join(directory, validManifest.filename);
  const bytes = Buffer.from("verified tarball");
  await writeFile(artifact, bytes);
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({ name: validManifest.name, version: validManifest.version }),
  );
  await writeFile(
    join(directory, "manifest.json"),
    JSON.stringify({ ...validManifest, sha256: createHash("sha256").update(bytes).digest("hex") }),
  );
  try {
    await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("verified npm publish command", () => {
  test("builds an absolute, explicit dry-run command with secure flags", async () => {
    await withRelease(async (directory) => {
      const result = await getVerifiedPublishCommand({
        manifestPath: join(directory, "manifest.json"),
        packagePath: join(directory, "package.json"),
        action: "--dry-run",
      });
      expect(result.artifactPath).toBe(join(directory, validManifest.filename));
      expect(result.args).toEqual([
        "publish",
        join(directory, validManifest.filename),
        "--access",
        "public",
        "--registry=https://registry.npmjs.org",
        "--provenance",
        "--ignore-scripts",
        "--dry-run",
      ]);
    });
  });

  test("keeps the production argv identical to dry-run argv without its final probe flag", async () => {
    await withRelease(async (directory) => {
      const manifestPath = join(directory, "manifest.json");
      const live = await getVerifiedPublishCommand({
        manifestPath,
        packagePath: join(directory, "package.json"),
        action: "--publish",
      });
      const dry = await getVerifiedPublishCommand({
        manifestPath,
        packagePath: join(directory, "package.json"),
        action: "--dry-run",
      });
      expect(live.args).toEqual(dry.args.slice(0, -1));
      expect(live.args).not.toContain("--publish");
      expect(buildNpmArgs(live.artifactPath, "--publish")).toEqual(live.args);
    });
  });

  test("captures the live CLI path without allowing npm to run", async () => {
    await withRelease(async (directory) => {
      let command:
        | { file: string; args: string[]; options: { env: NodeJS.ProcessEnv } }
        | undefined;
      await runVerifiedPublish({
        manifestPath: join(directory, "manifest.json"),
        packagePath: join(directory, "package.json"),
        action: "--publish",
        environment: {
          NPM_TOKEN: "must-not-reach-child",
          NODE_AUTH_TOKEN: "must-not-reach-child",
          GITHUB_ACTIONS: "true",
          ACTIONS_ID_TOKEN_REQUEST_URL: "managed-url",
        },
        execute: async (file, args, options) => {
          command = { file, args, options: { env: options.env ?? {} } };
          return { stdout: "", stderr: "" };
        },
      });
      expect(command).toBeDefined();
      expect(command?.file).toBe("npm");
      expect(command?.args).toEqual(buildNpmArgs(command?.args[1] ?? "", "--publish"));
      expect(command?.args).not.toContain("--publish");
      expect(command?.options.env.NPM_TOKEN).toBeUndefined();
      expect(command?.options.env.NODE_AUTH_TOKEN).toBeUndefined();
      expect(command?.options.env.GITHUB_ACTIONS).toBe("true");
      expect(command?.options.env.ACTIONS_ID_TOKEN_REQUEST_URL).toBe("managed-url");
    });
  });

  test("fails closed without an explicit action, for bad digests, and for symlinks", async () => {
    await withRelease(async (directory) => {
      const manifestPath = join(directory, "manifest.json");
      await expect(
        getVerifiedPublishCommand({ manifestPath, packagePath: join(directory, "package.json") }),
      ).rejects.toThrow("explicitly");
      const manifest = JSON.parse(await Bun.file(manifestPath).text());
      await writeFile(manifestPath, JSON.stringify({ ...manifest, sha256: "b".repeat(64) }));
      await expect(
        getVerifiedPublishCommand({
          manifestPath,
          packagePath: join(directory, "package.json"),
          action: "--dry-run",
        }),
      ).rejects.toThrow("checksum");
    });
    await withRelease(async (directory) => {
      const manifestPath = join(directory, "manifest.json");
      const artifactPath = join(directory, validManifest.filename);
      await rm(artifactPath);
      await symlink(join(directory, "outside.tgz"), artifactPath);
      await writeFile(join(directory, "outside.tgz"), "not the artifact");
      await expect(
        getVerifiedPublishCommand({
          manifestPath,
          packagePath: join(directory, "package.json"),
          action: "--dry-run",
        }),
      ).rejects.toThrow("regular file");
    });
  });
});
