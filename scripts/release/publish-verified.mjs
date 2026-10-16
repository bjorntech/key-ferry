import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { readReleaseManifest } from "./read-manifest.mjs";

const execFileAsync = promisify(execFile);
const REGISTRY = "https://registry.npmjs.org";
const PACKAGE_NAME = "@bjorntech/key-ferry";

export async function getVerifiedPublishCommand({
  manifestPath,
  packagePath = "package.json",
  action,
}) {
  if (action !== "--dry-run" && action !== "--publish") {
    throw new Error("publish action must be explicitly --dry-run or --publish");
  }
  const absoluteManifest = resolve(manifestPath);
  const manifest = await readReleaseManifest(absoluteManifest);
  const artifactDirectory = dirname(absoluteManifest);
  const artifactPath = resolve(artifactDirectory, manifest.filename);
  if (
    relative(artifactDirectory, artifactPath).startsWith("..") ||
    isAbsolute(relative(artifactDirectory, artifactPath))
  ) {
    throw new Error("release artifact must be contained by the manifest directory");
  }
  const artifactStats = await lstat(artifactPath);
  if (!artifactStats.isFile() || artifactStats.isSymbolicLink()) {
    throw new Error("release artifact must be a regular file, not a symlink");
  }
  const digest = createHash("sha256")
    .update(await readFile(artifactPath))
    .digest("hex");
  if (digest !== manifest.sha256.toLowerCase())
    throw new Error("release tarball checksum mismatch");
  const packageJson = JSON.parse(await readFile(resolve(packagePath), "utf8"));
  if (
    packageJson.name !== PACKAGE_NAME ||
    packageJson.name !== manifest.name ||
    packageJson.version !== manifest.version
  ) {
    throw new Error("release manifest does not match package metadata");
  }
  return {
    manifest,
    artifactPath,
    args: [
      "publish",
      artifactPath,
      "--access",
      "public",
      `--registry=${REGISTRY}`,
      "--provenance",
      "--ignore-scripts",
      action,
    ],
  };
}

if (fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  const value = (name) => {
    const index = args.indexOf(name);
    return index === -1 ? undefined : args[index + 1];
  };
  const action = args.includes("--dry-run")
    ? "--dry-run"
    : args.includes("--publish")
      ? "--publish"
      : undefined;
  const manifestPath = value("--manifest");
  if (!manifestPath || !action || (args.includes("--dry-run") && args.includes("--publish"))) {
    throw new Error(
      "usage: node scripts/release/publish-verified.mjs --manifest PATH --dry-run|--publish",
    );
  }
  const { args: npmArgs } = await getVerifiedPublishCommand({ manifestPath, action });
  if (action === "--publish") {
    delete process.env.NPM_TOKEN;
    delete process.env.NODE_AUTH_TOKEN;
  }
  console.log(["npm", ...npmArgs].map((arg) => JSON.stringify(arg)).join(" "));
  await execFileAsync("npm", npmArgs, { stdio: "inherit" });
}
