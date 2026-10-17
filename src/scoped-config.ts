import { open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { createScanner, parse, type ParseError } from "jsonc-parser";
import type { ProjectDirectory } from "./contracts.js";
import { projectDirectory } from "./contracts.js";
import {
  managerOptions,
  parseOptions,
  type ProjectConfigActivation,
  type ServerProtection,
  type ValidatedOptions,
} from "./options.js";

export interface ScopedConfigurationLocation {
  readonly project: { readonly directory: string };
}
export interface ScopedConfigurationFileSystem {
  readonly readFile: (path: string) => Promise<string>;
  readonly realpath?: (path: string) => Promise<string>;
}
export interface ScopedGroup {
  readonly id: "global" | "project";
  readonly sourceRoot: ProjectDirectory;
  readonly options: ValidatedOptions;
  readonly manager: ReturnType<typeof managerOptions>;
  readonly environmentKeys: readonly string[];
  readonly servers: Readonly<Record<string, ServerProtection>>;
}
export interface ScopedProjectError {
  readonly code: string;
  readonly server: string;
  readonly message: string;
}
export interface ScopedConfiguration {
  readonly global: ScopedGroup;
  readonly project?: ScopedGroup;
  readonly activation: ProjectConfigActivation;
  readonly bindings: Readonly<Record<string, "global" | "project">>;
  readonly diagnostics: readonly ScopedProjectError[];
}

export const MAX_PROJECT_CONFIG_BYTES = 128 * 1024;
export const MAX_PROJECT_CONFIG_DEPTH = 64;

const defaultFs: ScopedConfigurationFileSystem = {
  readFile: async (path) => {
    const handle = await open(path, "r");
    try {
      const stat = await handle.stat();
      if (stat.size > MAX_PROJECT_CONFIG_BYTES)
        throw new RangeError("project configuration is too large");
      const buffer = Buffer.alloc(MAX_PROJECT_CONFIG_BYTES + 1);
      const result = await handle.read(buffer, 0, buffer.length, 0);
      if (result.bytesRead > MAX_PROJECT_CONFIG_BYTES)
        throw new RangeError("project configuration is too large");
      return buffer.subarray(0, result.bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
  },
  realpath,
};
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const safeMessage = (_error: unknown) => "project configuration is invalid";
const JSONC = { openBrace: 1, closeBrace: 2, openBracket: 3, closeBracket: 4, eof: 17 } as const;
const isOpen = (token: number) => token === JSONC.openBrace || token === JSONC.openBracket;
const isClose = (token: number) => token === JSONC.closeBrace || token === JSONC.closeBracket;

function scanDepth(source: string): void {
  const scanner = createScanner(source, true);
  let depth = 0;
  for (let token = scanner.scan(); token !== JSONC.eof; token = scanner.scan()) {
    if (isOpen(token)) {
      depth++;
      if (depth > MAX_PROJECT_CONFIG_DEPTH)
        throw new RangeError("project configuration is too deeply nested");
    } else if (isClose(token)) {
      depth--;
    }
  }
}

function nullPrototype(value: unknown, depth = 0): unknown {
  if (Array.isArray(value)) return value.map((item) => nullPrototype(item, depth + 1));
  if (value === null || typeof value !== "object") return value;
  if (depth > MAX_PROJECT_CONFIG_DEPTH)
    throw new RangeError("project configuration is too deeply nested");
  const result: Record<string, unknown> = Object.create(null);
  for (const [key, item] of Object.entries(value)) result[key] = nullPrototype(item, depth + 1);
  return result;
}

function parseJsonc(source: string): unknown {
  scanDepth(source);
  const errors: ParseError[] = [];
  const value = parse(source, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0) throw new SyntaxError("invalid project configuration");
  return nullPrototype(value);
}

function group(id: "global" | "project", root: string, options: ValidatedOptions): ScopedGroup {
  const manager = managerOptions(options, root);
  const environmentKeys = Array.isArray(manager.adapter?.environmentKeys)
    ? (manager.adapter.environmentKeys as string[])
    : [];
  return {
    id,
    sourceRoot: projectDirectory(root),
    options,
    manager,
    environmentKeys,
    servers: options.adapter.servers,
  };
}

const diagnostic = (code: string): ScopedProjectError => ({
  code,
  server: "project",
  message: "project configuration is unavailable",
});
const result = (
  global: ScopedGroup,
  bindings: Record<string, "global" | "project">,
  diagnostics: readonly ScopedProjectError[] = [],
): ScopedConfiguration => ({ global, activation: "manual", bindings, diagnostics });

async function projectFile(
  root: string,
  file: string,
  fs: ScopedConfigurationFileSystem,
): Promise<{ source?: string; error?: ScopedProjectError }> {
  const filePath = resolve(root, file);
  if (!inside(relative(root, filePath))) return { error: diagnostic("project_config_escape") };
  const canonicalError = await canonicalFile(root, filePath, fs);
  return canonicalError ? { error: canonicalError } : readProjectFile(filePath, fs);
}

const inside = (path: string) => !path.startsWith("..") && !isAbsolute(path);

async function canonicalFile(
  root: string,
  filePath: string,
  fs: ScopedConfigurationFileSystem,
): Promise<ScopedProjectError | undefined> {
  if (!fs.realpath) return undefined;
  try {
    return inside(relative(root, await fs.realpath(filePath)))
      ? undefined
      : diagnostic("project_config_escape");
  } catch (error) {
    return (error as { code?: string }).code === "ENOENT"
      ? undefined
      : diagnostic("project_config_unavailable");
  }
}

async function readProjectFile(
  filePath: string,
  fs: ScopedConfigurationFileSystem,
): Promise<{ source?: string; error?: ScopedProjectError }> {
  try {
    const source = await fs.readFile(filePath);
    return Buffer.byteLength(source, "utf8") > MAX_PROJECT_CONFIG_BYTES
      ? { error: diagnostic("project_config_too_large") }
      : { source };
  } catch (error) {
    return (error as { code?: string }).code === "ENOENT"
      ? {}
      : { error: diagnostic("project_config_unavailable") };
  }
}

function projectSettings(source: string): Record<string, unknown> | undefined {
  const raw = parseJsonc(source);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw new TypeError("project config must be an object");
  const config = raw as Record<string, unknown>;
  if (config.enabled !== true) return undefined;
  validateProjectKeys(config);
  validateActivation(config.activation);
  validateOverrides(config.overrides);
  return config;
}

function validateProjectKeys(config: Record<string, unknown>): void {
  const allowed = new Set(["enabled", "activation", "overrides", "servers", "projectDirectory"]);
  if (Object.keys(config).some((key) => !allowed.has(key)))
    throw new TypeError("unsupported project config key");
}

function validateActivation(value: unknown): void {
  if (value !== undefined && value !== "auto" && value !== "manual")
    throw new TypeError("project activation is invalid");
}

function validateOverrides(value: unknown): void {
  if (
    value !== undefined &&
    (!Array.isArray(value) || value.some((name) => typeof name !== "string"))
  )
    throw new TypeError("overrides must be an array of server names");
}

async function projectGroup(
  config: Record<string, unknown>,
  root: string,
  fs: ScopedConfigurationFileSystem,
  global: ScopedGroup,
  bindings: Record<string, "global" | "project">,
): Promise<ScopedGroup | ScopedProjectError> {
  const project = readProjectOptions(config, root);
  const projectRoot = await resolveProjectRoot(project.projectDirectory ?? root, root, fs);
  if (typeof projectRoot !== "string") return projectRoot;
  const overrides = (config.overrides ?? []) as string[];
  const names = Object.keys(project.adapter.servers);
  if (!validBindings(names, overrides, project, global))
    return diagnostic("project_config_invalid");
  const canonical: ValidatedOptions = {
    ...project,
    projectDirectory: projectDirectory(projectRoot),
    manager: { ...project.manager, projectDirectory: projectDirectory(projectRoot) },
  };
  for (const name of names) bindings[name] = "project";
  return group("project", projectRoot, canonical);
}

function readProjectOptions(config: Record<string, unknown>, root: string): ValidatedOptions {
  return parseOptions(
    { servers: config.servers ?? {}, projectDirectory: config.projectDirectory ?? "." },
    root,
  );
}

async function resolveProjectRoot(
  path: string,
  root: string,
  fs: ScopedConfigurationFileSystem,
): Promise<string | ScopedProjectError> {
  try {
    const canonical = fs.realpath ? await fs.realpath(path) : path;
    return inside(relative(root, canonical)) ? canonical : diagnostic("project_config_escape");
  } catch {
    return diagnostic("project_root_unavailable");
  }
}

function validBindings(
  names: string[],
  overrides: string[],
  project: ValidatedOptions,
  global: ScopedGroup,
): boolean {
  const collision = names.some((name) => own(global.servers, name) && !overrides.includes(name));
  const invalidOverride = overrides.some(
    (name) => !own(project.adapter.servers, name) || !own(global.servers, name),
  );
  return !collision && !invalidOverride;
}

async function loadProjectPlan(
  global: ScopedGroup,
  root: string,
  fs: ScopedConfigurationFileSystem,
  bindings: Record<string, "global" | "project">,
): Promise<ScopedConfiguration> {
  const loaded = await projectFile(root, global.options.projectConfig.file, fs);
  if (loaded.error) return result(global, bindings, [loaded.error]);
  if (loaded.source === undefined) return result(global, bindings);
  return sourcePlan(loaded.source, global, root, fs, bindings);
}

async function sourcePlan(
  source: string,
  global: ScopedGroup,
  root: string,
  fs: ScopedConfigurationFileSystem,
  bindings: Record<string, "global" | "project">,
): Promise<ScopedConfiguration> {
  try {
    const config = projectSettings(source);
    if (!config) return result(global, bindings);
    const local = await projectGroup(config, root, fs, global, bindings);
    if ("code" in local) return result(global, bindings, [local]);
    const activation =
      global.options.projectConfig.activation === "auto" && config.activation !== "manual"
        ? "auto"
        : "manual";
    return { global, project: local, activation, bindings, diagnostics: [] };
  } catch (error) {
    return result(global, bindings, [
      { code: "project_config_invalid", server: "project", message: safeMessage(error) },
    ]);
  }
}

export async function loadScopedConfiguration(
  globalRaw: unknown,
  location: ScopedConfigurationLocation,
  fs: ScopedConfigurationFileSystem = defaultFs,
): Promise<ScopedConfiguration> {
  const global = parseOptions(globalRaw, location.project.directory);
  const globalGroup = group(
    "global",
    global.projectDirectory ?? location.project.directory,
    global,
  );
  const bindings: Record<string, "global" | "project"> = Object.fromEntries(
    Object.keys(globalGroup.servers).map((name) => [name, "global"]),
  );
  if (!global.enabled || !global.projectConfig.enabled) return result(globalGroup, bindings);
  let root: string;
  try {
    root = await (fs.realpath ?? realpath)(location.project.directory);
  } catch {
    return result(globalGroup, bindings, [diagnostic("project_root_unavailable")]);
  }
  return loadProjectPlan(globalGroup, root, fs, bindings);
}
