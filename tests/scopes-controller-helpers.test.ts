import { describe, expect, test } from "bun:test";
import {
  captureEditor,
  cleanManagedEnvironment,
  configurationFingerprint,
  groupStatus,
  runtimeEnvironment,
  selectRuntime,
  selectedStatus,
} from "../src/scopes/controller-helpers.js";

const editor = (entries: Record<string, any>) => {
  const values = new Map(Object.entries(entries));
  return {
    values,
    editor: {
      list: () => [...values.entries()] as any,
      get: (name: string) => values.get(name),
      update: (name: string, update: (value: any) => void) => {
        const value = values.get(name);
        if (value) update(value);
      },
    },
  };
};

const runtime = (overrides: Record<string, unknown> = {}) =>
  ({
    id: "project",
    group: { sourceRoot: "/project" },
    remote: { diagnostics: [], handles: {}, stopAll: undefined },
    mappings: { local: { OUT: "TOKEN" }, remote: { remote: "https://example.test" } },
    state: { ready: true, environment: { TOKEN: "secret" } },
    status: { phase: "ready", projectDirectory: "/project", generation: 2 },
    ...overrides,
  }) as any;

describe("scoped controller helper projections", () => {
  test("fingerprints the effective project root, not only its mappings", () => {
    const makeConfiguration = (
      root: string,
      servers: Record<string, any> = { local: { OUT: "TOKEN" } },
    ) =>
      ({
        global: {
          sourceRoot: "/workspace",
          servers: {},
          manager: { projectDirectory: "/workspace" },
        },
        project: { sourceRoot: root, servers, manager: { projectDirectory: root } },
        activation: "auto",
        bindings: { local: "project" },
        diagnostics: [],
      }) as any;

    expect(configurationFingerprint(makeConfiguration("/workspace/sub-a"))).not.toBe(
      configurationFingerprint(makeConfiguration("/workspace/sub-b")),
    );
  });

  test("canonical roots and equivalent setting order keep the fingerprint stable", () => {
    const first = {
      global: {
        sourceRoot: "/workspace",
        servers: {},
        manager: { projectDirectory: "/workspace" },
      },
      project: {
        sourceRoot: "/workspace/project",
        servers: { first: { B: "two", A: "one" } },
        manager: { projectDirectory: "/workspace/project" },
      },
      activation: "auto",
      bindings: { first: "project", second: "global" },
      diagnostics: [],
    } as any;
    const equivalent = {
      global: {
        sourceRoot: "/workspace",
        servers: {},
        manager: { projectDirectory: "/workspace/project" },
      },
      project: {
        sourceRoot: "/workspace/project",
        servers: { first: { A: "one", B: "two" } },
        manager: { projectDirectory: "/workspace/project" },
      },
      activation: "auto",
      bindings: { second: "global", first: "project" },
      diagnostics: [],
    } as any;

    expect(configurationFingerprint(first)).toBe(configurationFingerprint(equivalent));
  });

  test("captures safe native snapshots and restores managed keys", () => {
    const current = editor({
      local: { type: "local", environment: { NATIVE: "keep" } },
      remote: { type: "remote", url: "https://example.test", headers: { A: "B" } },
    });
    const snapshot = captureEditor(current.editor);
    expect(snapshot.disabled).toEqual(new Set());
    expect(snapshot.remote.get("remote")?.url).toBe("https://example.test");
    const managed = new Map<string, Map<string, any>>([
      [
        "local",
        new Map([["project", { original: { OUT: undefined }, injected: { OUT: "secret" } }]]),
      ],
    ]);
    current.values.get("local").environment.OUT = "secret";
    cleanManagedEnvironment(
      current.editor,
      managed,
      new Map([["local", { OUT: "secret" }]]),
      snapshot.environments as any,
    );
    expect(current.values.get("local").environment).toEqual({ NATIVE: "keep" });
  });

  test("preserves user edits and projects only ready local mappings", () => {
    const current = editor({ local: { type: "local", environment: {} } });
    const managed = new Map<string, Map<string, any>>();
    const injected = new Map<string, Record<string, string>>();
    runtimeEnvironment(current.editor, runtime(), new Map([["local", {}]]), managed, injected);
    expect(current.values.get("local").environment).toEqual({});
    expect(managed.get("local")?.get("project").injected).toEqual({ OUT: "secret" });
    current.values.get("local").environment.OUT = "user-change";
    cleanManagedEnvironment(current.editor, managed, injected, new Map([["local", {}]]));
    expect(current.values.get("local").environment.OUT).toBe("user-change");
  });

  test("restores a captured native value when an injected value is unchanged", () => {
    const current = editor({ local: { type: "local", environment: { OUT: "native" } } });
    const managed = new Map<string, Map<string, any>>();
    const injected = new Map([["local", { OUT: "secret" }]]);
    current.values.get("local").environment.OUT = "secret";
    cleanManagedEnvironment(
      current.editor,
      managed,
      injected,
      new Map([["local", { OUT: "native" }]]),
    );
    expect(current.values.get("local").environment.OUT).toBe("native");
  });

  test("selects requested scope and reports unbound servers safely", () => {
    const runtimes = new Map([["project", runtime()]]);
    expect(selectRuntime(runtimes, { local: "project" }, { server: "local" })).toBeDefined();
    expect(selectRuntime(runtimes, { local: "project" }, { scope: "global" })).toBeUndefined();
    const status = selectedStatus(
      undefined,
      {
        global: { sourceRoot: "/global" },
        project: undefined,
        bindings: {},
      } as any,
      { server: "missing" },
    );
    expect(status.diagnostics?.[0]?.code).toBe("server_unbound");
    expect(groupStatus(runtime())).toMatchObject({ scope: "project", phase: "ready" });
  });
});
