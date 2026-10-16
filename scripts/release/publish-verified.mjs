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
const PRODUCTION_ARGS = [
  "publish",
  "--access",
  "public",
  `--registry=${REGISTRY}`,
  "--provenance",
  "--ignore-scripts",
];

function buildProductionArgs(artifactPath) {
  return [PRODUCTION_ARGS[0], artifactPath, ...PRODUCTION_ARGS.slice(1)];
}

export function buildNpmArgs(artifactPath, action) {
  if (action !== "--dry-run" && action !== "--publish") {
    throw new Error("publish action must be explicitly --dry-run or --publish");
  }
  const productionArgs = buildProductionArgs(artifactPath);
  return action === "--dry-run" ? [...productionArgs, "--dry-run"] : productionArgs;
}

export async function getVerifiedPublishCommand({
  manifestPath,
  packagePath = "package.json",
  action,
}) {
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
    args: buildNpmArgs(artifactPath, action),
  };
}

export async function runVerifiedPublish({
  manifestPath,
  packagePath = "package.json",
  action,
  execute = execFileAsync,
  environment = process.env,
}) {
  const { args } = await getVerifiedPublishCommand({ manifestPath, packagePath, action });
  const env = { ...environment };
  if (action === "--publish") {
    delete env.NPM_TOKEN;
    delete env.NODE_AUTH_TOKEN;
  }
  console.log(["npm", ...args].map((arg) => JSON.stringify(arg)).join(" "));
  await execute("npm", args, { stdio: "inherit", env });
}

function parseCliArgs(args) {
  let manifestPath;
  let action;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--manifest") {
      if (manifestPath || !args[index + 1] || args[index + 1].startsWith("--")) {
        throw new Error(
          "usage: node scripts/release/publish-verified.mjs --manifest PATH --dry-run|--publish",
        );
      }
      manifestPath = args[++index];
    } else if (arg === "--dry-run" || arg === "--publish") {
      if (action) {
        throw new Error(
          "usage: node scripts/release/publish-verified.mjs --manifest PATH --dry-run|--publish",
        );
      }
      action = arg;
    } else {
      throw new Error(
        "usage: node scripts/release/publish-verified.mjs --manifest PATH --dry-run|--publish",
      );
    }
  }
  if (!manifestPath || !action) {
    throw new Error(
      "usage: node scripts/release/publish-verified.mjs --manifest PATH --dry-run|--publish",
    );
  }
  return { manifestPath, action };
}

if (fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await runVerifiedPublish({ ...parseCliArgs(process.argv.slice(2)) });
}
