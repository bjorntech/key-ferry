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
