import { describe, expect, test } from "bun:test";
import {
  loadScopedConfiguration,
  type ScopedConfigurationFileSystem,
} from "../src/project-config.js";

const filesystem = (
  source: string,
  root = "/workspace/project",
): ScopedConfigurationFileSystem & { reads: string[] } => {
  const reads: string[] = [];
  return {
    reads,
    realpath: async (path) => (path === "/workspace/project" ? root : path),
    readFile: async (path) => {
      reads.push(path);
      return source;
    },
  };
};

describe("project configuration loader", () => {
  test("does not inspect the filesystem when globally disabled", async () => {
    const fs = filesystem("{ enabled: true }");
    const result = await loadScopedConfiguration(
      { enabled: false, projectConfig: { enabled: true } },
      { project: { directory: "/workspace/project" } },
      fs,
    );
    expect(fs.reads).toEqual([]);
    expect(result.project).toBeUndefined();
  });

  test("loads JSONC relative to the project, independent of process cwd", async () => {
    const fs = filesystem(
      `// local only\n{ "enabled": true, "servers": { "local": { "env": ["LOCAL_KEY"], }, }, }`,
    );
    const result = await loadScopedConfiguration(
      {
        projectConfig: { enabled: true, activation: "auto" },
        servers: { global: { env: ["GLOBAL_KEY"] } },
      },
      { project: { directory: "/workspace/project" } },
      fs,
    );
    expect(fs.reads).toEqual(["/workspace/project/.opencode/key-ferry.jsonc"]);
    expect(result.project?.sourceRoot).toBe("/workspace/project");
    expect(result.project?.environmentKeys).toEqual(["LOCAL_KEY"]);
    expect(result.global.environmentKeys).toEqual(["GLOBAL_KEY"]);
    expect(result.activation).toBe("auto");
  });

  test("manual global policy cannot be escalated and local manual can restrict auto", async () => {
    const localAuto = filesystem('{ "enabled": true, "activation": "auto", "servers": {} }');
    const restricted = await loadScopedConfiguration(
      { projectConfig: { enabled: true, activation: "manual" } },
      { project: { directory: "/workspace/project" } },
      localAuto,
    );
    expect(restricted.activation).toBe("manual");
    const globalAuto = filesystem('{ "enabled": true, "activation": "manual", "servers": {} }');
    const manual = await loadScopedConfiguration(
      { projectConfig: { enabled: true, activation: "auto" } },
      { project: { directory: "/workspace/project" } },
      globalAuto,
    );
    expect(manual.activation).toBe("manual");
  });

  test("malformed project input keeps global group and does not leak source text", async () => {
    const secret = "TOP_SECRET_VALUE";
    const fs = filesystem(
      `{ "enabled": true, "servers": { "bad": { "env": ["${secret}"] }, "unknown": 1 } }`,
    );
    const result = await loadScopedConfiguration(
      { projectConfig: { enabled: true }, servers: { global: { env: ["GLOBAL"] } } },
      { project: { directory: "/workspace/project" } },
      fs,
    );
    expect(result.project).toBeUndefined();
    expect(result.global.environmentKeys).toEqual(["GLOBAL"]);
    expect(JSON.stringify(result.diagnostics)).not.toContain(secret);
  });

  test("rejects malformed settings and keeps parsed maps off Object.prototype", async () => {
    const malformed = await loadScopedConfiguration(
      { projectConfig: { enabled: true } },
      { project: { directory: "/workspace/project" } },
      filesystem('{ "enabled": true, "activation": 12, "servers": {} }'),
    );
    expect(malformed.diagnostics[0]?.code).toBe("project_config_invalid");
    const safe = await loadScopedConfiguration(
      { projectConfig: { enabled: true } },
      { project: { directory: "/workspace/project" } },
      filesystem('{ "enabled": true, "servers": { "safe": { "env": ["KEY"] } } }'),
    );
    expect(safe.project?.servers.safe).toBeDefined();
    expect(Object.getPrototypeOf(safe.project?.servers)).toBe(null);
    expect(({} as Record<string, unknown>).KEY).toBeUndefined();
  });
});
