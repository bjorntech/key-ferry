import { readFile } from "node:fs/promises";

const manifestFields = ["commit", "filename", "name", "sha256", "tag", "version"];
const safeTarballFilename = /^[A-Za-z0-9._-]+\.tgz$/;

/** Read and validate a release manifest, parsing its JSON exactly once. */
export async function readReleaseManifest(path) {
  const manifest = JSON.parse(await readFile(path, "utf8"));
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("release manifest must be a JSON object");
  }
  if (Object.keys(manifest).sort().join(",") !== manifestFields.join(",")) {
    throw new Error("invalid release manifest fields");
  }
  for (const field of manifestFields) {
    if (typeof manifest[field] !== "string" || manifest[field].length === 0) {
      throw new Error(`release manifest field ${field} must be a non-empty string`);
    }
  }
  if (!safeTarballFilename.test(manifest.filename)) throw new Error("unsafe tarball filename");
  if (!/^[0-9a-f]{64}$/i.test(manifest.sha256)) throw new Error("invalid release tarball checksum");
  if (!/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(manifest.tag))
    throw new Error("invalid release tag");
  if (!/^[0-9a-f]{40}$/i.test(manifest.commit)) throw new Error("invalid release commit");
  return manifest;
}
