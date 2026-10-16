import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

const stableTag = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const packageName = "@bjorntech/key-ferry";
const releaseDirectory = "release";

const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const tag = process.env.GITHUB_REF?.replace("refs/tags/", "");
const commit = process.env.GITHUB_SHA;

if (!tag || !stableTag.test(tag)) {
  throw new Error(
    `Release ref must be a stable vX.Y.Z tag, received ${process.env.GITHUB_REF ?? "none"}`,
  );
}
if (packageJson.name !== packageName) {
  throw new Error(`package.json name must be ${packageName}`);
}
if (!stableTag.test(`v${packageJson.version}`) || tag !== `v${packageJson.version}`) {
  throw new Error(`Release tag ${tag} does not match package version ${packageJson.version}`);
}
if (!commit || !/^[0-9a-f]{40}$/i.test(commit)) {
  throw new Error("GITHUB_SHA must be a full commit SHA");
}

const tarballs = (await readdir(releaseDirectory)).filter((file) => file.endsWith(".tgz"));
const expectedFilename = `${packageName.slice(1).replaceAll("/", "-")}-${packageJson.version}.tgz`;
if (tarballs.length !== 1 || tarballs[0] !== expectedFilename) {
  throw new Error(`Expected exactly ${expectedFilename} in ${releaseDirectory}`);
}

const tarball = join(releaseDirectory, tarballs[0]);
const sha256 = createHash("sha256")
  .update(await readFile(tarball))
  .digest("hex");
const manifest = {
  name: packageJson.name,
  version: packageJson.version,
  tag,
  commit,
  filename: basename(tarball),
  sha256,
};
await writeFile(join(releaseDirectory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
