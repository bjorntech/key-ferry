import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadScopedConfiguration,
  MAX_PROJECT_CONFIG_BYTES,
  MAX_PROJECT_CONFIG_DEPTH,
} from "../src/scoped-config.js";

const fake = (text: string) => ({
  realpath: async (path: string) => path,
  readFile: async () => text,
});

describe("scoped bindings", () => {
  test("rejects collisions unless explicitly overridden and never unions keys", async () => {
    const base = {
      projectConfig: { enabled: true },
      servers: { shared: { env: ["GLOBAL"] }, onlyGlobal: { env: ["G"] } },
    };
    const rejected = await loadScopedConfiguration(
      base,
      { project: { directory: "/project" } },
      fake('{ "enabled": true, "servers": { "shared": { "env": ["LOCAL"] } } }'),
    );
    expect(rejected.project).toBeUndefined();
    expect(rejected.diagnostics[0]?.code).toBe("project_config_invalid");
    const accepted = await loadScopedConfiguration(
      base,
      { project: { directory: "/project" } },
      fake(
        '{ "enabled": true, "overrides": ["shared"], "servers": { "shared": { "env": ["LOCAL"] }, "onlyLocal": { "env": ["L"] } } }',
      ),
    );
    expect(accepted.bindings).toEqual({
      shared: "project",
      onlyGlobal: "global",
      onlyLocal: "project",
    });
    expect(accepted.global.environmentKeys).toEqual(["GLOBAL", "G"]);
    expect(accepted.project?.environmentKeys).toEqual(["LOCAL", "L"]);
  });

  test("rejects project roots and files that escape the root", async () => {
    const fs = {
      realpath: async (path: string) => (path === "/project" ? "/canonical" : "/outside/file"),
      readFile: async () => "{}",
    };
    const result = await loadScopedConfiguration(
      { projectConfig: { enabled: true, file: "../config.jsonc" } },
      { project: { directory: "/project" } },
      fs,
    );
    expect(result.project).toBeUndefined();
    expect(result.diagnostics[0]?.code).toBe("project_config_escape");
  });

  test("canonicalizes local roots and rejects an escaping configured root", async () => {
    const fs = {
      realpath: async (path: string) =>
        path === "/project"
          ? "/canonical"
          : path.includes(".opencode")
            ? "/canonical/.opencode/key-ferry.jsonc"
            : "/outside",
      readFile: async () => '{ "enabled": true, "projectDirectory": "local", "servers": {} }',
    };
    const result = await loadScopedConfiguration(
      { projectConfig: { enabled: true } },
      { project: { directory: "/project" } },
      fs,
    );
    expect(result.project).toBeUndefined();
    expect(result.diagnostics[0]?.code).toBe("project_config_escape");
  });

  test("handles file realpath failures without changing the global plan", async () => {
    let read = false;
    const fs = {
      realpath: async (path: string) => {
        if (path === "/project") return path;
        const error = Object.assign(new Error("private path"), { code: "EACCES" });
        throw error;
      },
      readFile: async () => {
        read = true;
        return "{}";
      },
    };
    const result = await loadScopedConfiguration(
      { projectConfig: { enabled: true }, servers: { global: { env: ["GLOBAL"] } } },
      { project: { directory: "/project" } },
      fs,
    );
    expect(read).toBe(false);
    expect(result.global.environmentKeys).toEqual(["GLOBAL"]);
    expect(result.diagnostics[0]?.code).toBe("project_config_unavailable");
  });

  test("enforces byte and nesting budgets while allowing braces in strings", async () => {
    const valid = '{ "enabled": true, "servers": { "url": { "env": ["KEY"] } } }';
    const exact = `${valid}//${"x".repeat(MAX_PROJECT_CONFIG_BYTES - Buffer.byteLength(valid) - 2)}`;
    const within = await loadScopedConfiguration(
      { projectConfig: { enabled: true } },
      { project: { directory: "/project" } },
      fake(exact),
    );
    expect(within.project?.environmentKeys).toEqual(["KEY"]);
    const oversized = await loadScopedConfiguration(
      { projectConfig: { enabled: true } },
      { project: { directory: "/project" } },
      fake(`${valid}${" ".repeat(MAX_PROJECT_CONFIG_BYTES)}`),
    );
    expect(oversized.diagnostics[0]?.code).toBe("project_config_too_large");
    const nested = `${"{".repeat(MAX_PROJECT_CONFIG_DEPTH + 1)}${"}".repeat(MAX_PROJECT_CONFIG_DEPTH + 1)}`;
    const tooDeep = await loadScopedConfiguration(
      { projectConfig: { enabled: true } },
      { project: { directory: "/project" } },
      fake(nested),
    );
    expect(tooDeep.diagnostics[0]?.code).toBe("project_config_invalid");
  });

  test("checks real temporary symlinks before reading project content", async () => {
    const root = await mkdtemp(join(tmpdir(), "key-ferry-project-"));
    const outside = await mkdtemp(join(tmpdir(), "key-ferry-outside-"));
    try {
      await writeFile(join(outside, "config.jsonc"), '{ "enabled": true, "servers": {} }');
      await mkdir(join(root, ".opencode"), { recursive: true });
      await symlink(join(outside, "config.jsonc"), join(root, ".opencode/key-ferry.jsonc"));
      let read = false;
      const result = await loadScopedConfiguration(
        { projectConfig: { enabled: true } },
        { project: { directory: root } },
        {
          realpath,
          readFile: async (path) => {
            read = true;
            return readFile(path, "utf8");
          },
        },
      );
      expect(read).toBe(false);
      expect(result.diagnostics[0]?.code).toBe("project_config_escape");
    } finally {
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(outside, { recursive: true, force: true }),
      ]);
    }
  });
});
