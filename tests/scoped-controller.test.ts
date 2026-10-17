import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Fiber, Layer, Scope } from "effect";
import { makeBrokerRegistry } from "../src/broker-registry.js";
import {
  ProjectKeyFerryManager,
  projectDirectory,
  type ProjectKeyFerryManagerFactory,
} from "../src/contracts.js";
import { loadScopedConfiguration } from "../src/scoped-config.js";
import { makeScopedController } from "../src/scoped-controller.js";

const editorFor = (entries: Record<string, any>) => {
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

async function roots() {
  const root = await mkdtemp(join(tmpdir(), "key-ferry-controller-"));
  const project = join(root, "project");
  await mkdir(join(project, ".opencode"), { recursive: true });
  return { root, project: await realpath(project) };
}

function managerFactory(
  root: string,
  environment: Record<string, string>,
  gate?: Promise<void>,
  refreshGate?: Promise<void>,
): ProjectKeyFerryManagerFactory {
  return {
    layer: (options) => {
      const service = {
        status: Effect.succeed({
          phase: "starting" as const,
          projectDirectory: projectDirectory(root),
          generation: 0,
        }),
        ensureStarted: Effect.succeed({
          phase: "starting" as const,
          projectDirectory: projectDirectory(root),
          generation: 0,
        }),
        ensureReady: Effect.gen(function* () {
          if (gate) yield* Effect.promise(() => gate);
          return {
            status: {
              phase: "ready" as const,
              projectDirectory: projectDirectory(root),
              generation: 1,
            },
            environment,
          };
        }),
        environment: Effect.succeed(environment),
        refresh: Effect.succeed({
          phase: "ready" as const,
          projectDirectory: projectDirectory(root),
          generation: 1,
        }),
        refreshReady: Effect.gen(function* () {
          if (refreshGate) yield* Effect.promise(() => refreshGate);
          return {
            status: {
              phase: "ready" as const,
              projectDirectory: projectDirectory(root),
              generation: 2,
            },
            environment,
          };
        }),
        dispose: Effect.void,
        withExclusive: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
      };
      return Layer.succeed(ProjectKeyFerryManager, service);
    },
  };
}

async function configuration(project: string, source: string) {
  return loadScopedConfiguration(
    { projectConfig: { enabled: true, activation: "auto" }, servers: {} },
    { project: { directory: project } },
    {
      readFile: async () => source,
      realpath: async (path) => path,
    },
  );
}

function runController(
  config: Awaited<ReturnType<typeof configuration>>,
  factory: ProjectKeyFerryManagerFactory,
  editor: ReturnType<typeof editorFor>,
  reload: () => Effect.Effect<void> = () => Effect.void,
) {
  const scope = Effect.runSync(Scope.make());
  let controller: ReturnType<typeof makeScopedController>;
  const nativeReload = reload;
  controller = makeScopedController({
    configuration: config,
    factory,
    registry: makeBrokerRegistry({ canonicalize: (path) => Effect.succeed(path) }),
    scope,
    reload: () =>
      Effect.gen(function* () {
        yield* nativeReload();
        controller.apply(editor.editor);
      }),
  });
  controller.capture(editor.editor);
  controller.apply(editor.editor);
  return { controller, scope };
}

describe("scoped controller lifecycle invariants", () => {
  test.each(["{}", '{"enabled":false}'])(
    "retains manual project protection after project removal (%s)",
    async (replacement) => {
      const { root, project } = await roots();
      let acquisitions = 0;
      const config = await loadScopedConfiguration(
        {
          projectConfig: { enabled: true, activation: "manual" },
          servers: { global: { env: ["G"] } },
        },
        { project: { directory: project } },
        {
          readFile: async () =>
            '{"enabled":true,"activation":"manual","servers":{"project":{"env":["P"]}}}',
          realpath: async (path) => path,
        },
      );
      const base = managerFactory(project, { G: "global", P: "project" });
      const factory: ProjectKeyFerryManagerFactory = {
        layer: (options) => {
          acquisitions++;
          return base.layer(options);
        },
      };
      const editor = editorFor({
        global: { type: "local", command: ["global"] },
        project: { type: "local", command: ["project"] },
      });
      const { controller, scope } = runController(config, factory, editor);
      try {
        await Effect.runPromise(controller.start);
        await new Promise((resolve) => setImmediate(resolve));
        expect(acquisitions).toBe(1);
        editor.values.set("project", { type: "local", command: ["project"] });
        const next = await loadScopedConfiguration(
          {
            projectConfig: { enabled: true, activation: "manual" },
            servers: { global: { env: ["G"] } },
          },
          { project: { directory: project } },
          { readFile: async () => replacement, realpath: async (path) => path },
        );
        await Effect.runPromise(controller.replaceProject(next));
        expect(editor.values.get("project")?.disabled).toBe(true);
        expect(editor.values.get("global")?.disabled).not.toBe(true);
        expect(acquisitions).toBe(1);
      } finally {
        await Effect.runPromise(controller.dispose);
        await Scope.close(scope, { _tag: "Success", value: undefined } as never);
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  test("retired project cannot publish a late ready result", async () => {
    const { root, project } = await roots();
    let unblock!: () => void;
    const gate = new Promise<void>((resolve) => (unblock = resolve));
    const config = await configuration(
      project,
      '{"enabled":true,"servers":{"project":{"env":["P"]}}}',
    );
    const editor = editorFor({ project: { type: "local", command: ["project"] } });
    const { controller, scope } = runController(
      config,
      managerFactory(project, { P: "old" }, gate),
      editor,
    );
    try {
      await Effect.runPromise(controller.start);
      const retiring = controller.replaceProject(await configuration(project, '{"enabled":false}'));
      await Effect.runPromise(retiring);
      unblock();
      await new Promise((resolve) => setImmediate(resolve));
      expect((await Effect.runPromise(controller.status)).scopes?.[0]?.phase).not.toBe("ready");
      expect(editor.values.get("project")?.disabled).toBe(true);
    } finally {
      await Effect.runPromise(controller.dispose);
      await Scope.close(scope, { _tag: "Success", value: undefined } as never);
      await rm(root, { recursive: true, force: true });
    }
  });

  test("refresh closes only the selected group while its backend is blocked", async () => {
    const { root, project } = await roots();
    let unblock!: () => void;
    const gate = new Promise<void>((resolve) => (unblock = resolve));
    const config = await configuration(
      project,
      '{"enabled":true,"servers":{"project":{"env":["P"]}}}',
    );
    const editor = editorFor({ project: { type: "local", command: ["project"] } });
    const { controller, scope } = runController(
      config,
      managerFactory(project, { P: "value" }, undefined, gate),
      editor,
    );
    try {
      await Effect.runPromise(controller.start);
      await new Promise((resolve) => setImmediate(resolve));
      const refresh = Effect.runFork(controller.operation("refresh", { scope: "project" }));
      await new Promise((resolve) => setImmediate(resolve));
      expect((await Effect.runPromise(controller.status)).scopes?.[0]?.phase).toBe("starting");
      expect(editor.values.get("project")?.disabled).toBe(true);
      unblock();
      await Effect.runPromise(
        Effect.promise(() => new Promise((resolve) => setImmediate(resolve))),
      );
      await Effect.runPromise(Fiber.await(refresh));
    } finally {
      unblock();
      await Effect.runPromise(controller.dispose);
      await Scope.close(scope, { _tag: "Success", value: undefined } as never);
      await rm(root, { recursive: true, force: true });
    }
  });

  test("failed refresh does not leave the runtime transitioning", async () => {
    const { root, project } = await roots();
    const config = await configuration(
      project,
      '{"enabled":true,"servers":{"project":{"env":["P"]}}}',
    );
    const editor = editorFor({ project: { type: "local", command: ["project"] } });
    let reloads = 0;
    const { controller, scope } = runController(
      config,
      managerFactory(project, { P: "value" }),
      editor,
      () => {
        reloads++;
        return reloads > 1 ? Effect.fail(new Error("reload failed")) : Effect.void;
      },
    );
    try {
      await Effect.runPromise(controller.start);
      await new Promise((resolve) => setImmediate(resolve));
      await expect(
        Effect.runPromise(controller.operation("refresh", { scope: "project" })),
      ).rejects.toThrow("reload failed");
      expect(controller.runtimes.get("project")?.transitioning).toBe(false);
    } finally {
      await Effect.runPromise(controller.dispose);
      await Scope.close(scope, { _tag: "Success", value: undefined } as never);
      await rm(root, { recursive: true, force: true });
    }
  });

  test("replaces managed environment keys without removing native values", async () => {
    const { root, project } = await roots();
    const first = await configuration(
      project,
      '{"enabled":true,"servers":{"project":{"env":["TOKEN"]}}}',
    );
    const second = await configuration(
      project,
      '{"enabled":true,"servers":{"project":{"env":["OTHER"]}}}',
    );
    const editor = editorFor({
      project: { type: "local", command: ["project"], environment: { UNRELATED: "native" } },
    });
    const { controller, scope } = runController(
      first,
      managerFactory(project, { TOKEN: "old", OTHER: "new" }),
      editor,
    );
    try {
      await Effect.runPromise(controller.start);
      await new Promise((resolve) => setImmediate(resolve));
      expect(editor.values.get("project")?.environment).toEqual({
        UNRELATED: "native",
        TOKEN: "old",
      });
      await Effect.runPromise(controller.replaceProject(second));
      await new Promise((resolve) => setImmediate(resolve));
      expect(editor.values.get("project")?.environment).toEqual({
        UNRELATED: "native",
        OTHER: "new",
      });
    } finally {
      await Effect.runPromise(controller.dispose);
      await Scope.close(scope, { _tag: "Success", value: undefined } as never);
      await rm(root, { recursive: true, force: true });
    }
  });
});
