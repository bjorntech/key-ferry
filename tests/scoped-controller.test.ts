import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Deferred, Effect, Fiber, Layer, Scope } from "effect";
import { makeBrokerRegistry, type BrokerRegistry } from "../src/broker-registry.js";
import {
  ProjectKeyFerryManager,
  projectDirectory,
  type ProjectKeyFerryManagerFactory,
  VarlockError,
} from "../src/contracts.js";
import type { RemoteRelayConfig, RemoteRelayHandle } from "../src/remote.js";
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
  startupError?: VarlockError,
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
          if (startupError) return yield* Effect.fail(startupError);
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

function firstAcquireFailureRegistry(): BrokerRegistry {
  const registry = makeBrokerRegistry({ canonicalize: (path) => Effect.succeed(path) });
  let acquisitions = 0;
  return {
    ...registry,
    acquire: (factory, options) => {
      acquisitions++;
      return acquisitions === 1
        ? Effect.fail(
            new VarlockError({
              code: "start_failed",
              message: "synthetic initial startup failure",
              retryable: true,
            }),
          )
        : registry.acquire(factory, options);
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

  test("doctor waits for readiness when it acquires the first broker lease", async () => {
    const { root, project } = await roots();
    let unblock!: () => void;
    const gate = new Promise<void>((resolve) => (unblock = resolve));
    const config = await configuration(
      project,
      '{"enabled":true,"servers":{"project":{"env":["P"]}}}',
    );
    const editor = editorFor({ project: { type: "local", command: ["project"] } });
    const scope = Effect.runSync(Scope.make());
    const controllerWithRegistry = makeScopedController({
      configuration: config,
      factory: managerFactory(project, { P: "ready" }, gate),
      registry: firstAcquireFailureRegistry(),
      scope,
      reload: () => Effect.void,
    });
    controllerWithRegistry.capture(editor.editor);
    controllerWithRegistry.apply(editor.editor);
    let doctor: ReturnType<typeof Effect.runFork> | undefined;
    try {
      await Effect.runPromise(controllerWithRegistry.start);
      doctor = Effect.runFork(controllerWithRegistry.operation("doctor", { scope: "project" }));
      await new Promise((resolve) => setImmediate(resolve));
      unblock();
      const status = await Effect.runPromise(Fiber.join(doctor));
      expect(status.phase).toBe("ready");
      await Effect.runPromise(controllerWithRegistry.dispose);
      await Effect.runPromise(controllerWithRegistry.dispose);
    } finally {
      unblock();
      if (doctor) await Effect.runPromise(Fiber.interrupt(doctor));
      await Effect.runPromise(controllerWithRegistry.dispose);
      await Scope.close(scope, { _tag: "Success", value: undefined } as never);
      await rm(root, { recursive: true, force: true });
    }
  });

  test("doctor reuses the newly acquired observer reconciliation", async () => {
    const { root, project } = await roots();
    const caPath = join(root, "ca.pem");
    await writeFile(caPath, "-----BEGIN CERTIFICATE-----\nsynthetic\n-----END CERTIFICATE-----\n");
    const config = await configuration(
      project,
      '{"enabled":true,"servers":{"project-remote":{"remote":{"headers":{"Authorization":"P"}}}}}',
    );
    const editor = editorFor({
      "project-remote": {
        type: "remote",
        url: "https://mcp.example.test/mcp",
        oauth: false,
        headers: { "X-Native": "native" },
      },
    });
    const started: RemoteRelayConfig[] = [];
    const stopped: string[] = [];
    const relayFactory = (relayConfig: RemoteRelayConfig) => {
      started.push(relayConfig);
      const token = `relay-${started.length}`;
      const handle: RemoteRelayHandle = {
        localUrl: `http://127.0.0.1:${4800 + started.length}`,
        downstreamToken: token,
        health: Effect.succeed({
          listening: true,
          activeRequests: 0,
          localUrl: `http://127.0.0.1:${4800 + started.length}`,
        }),
        stop: Effect.sync(() => void stopped.push(token)),
      };
      return Effect.succeed(handle);
    };
    let reloads = 0;
    const scope = Effect.runSync(Scope.make());
    const controller = makeScopedController({
      configuration: config,
      factory: managerFactory(project, {
        P: "ready",
        HTTPS_PROXY: "https://proxy.example.test",
        NODE_EXTRA_CA_CERTS: caPath,
      }),
      registry: firstAcquireFailureRegistry(),
      relayFactory,
      scope,
      reload: () => Effect.sync(() => reloads++),
    });
    controller.capture(editor.editor);
    controller.apply(editor.editor);
    try {
      await Effect.runPromise(controller.start);
      const status = await Effect.runPromise(controller.operation("doctor", { scope: "project" }));
      expect(status.phase).toBe("ready");
      expect(started).toHaveLength(1);
      expect(reloads).toBe(1);
      expect(controller.runtimes.get("project")?.remote.handles.size).toBe(1);
      await Effect.runPromise(controller.dispose);
      expect(stopped).toEqual(["relay-1"]);
      expect(controller.runtimes.get("project")?.remote.handles.size).toBe(0);
    } finally {
      await Effect.runPromise(controller.dispose);
      await Scope.close(scope, { _tag: "Success", value: undefined } as never);
      await rm(root, { recursive: true, force: true });
    }
  });

  test("an operation arriving during the initial acquisition shares its lease", async () => {
    const { root, project } = await roots();
    const config = await configuration(
      project,
      '{"enabled":true,"servers":{"project":{"env":["P"]}}}',
    );
    const editor = editorFor({ project: { type: "local", command: ["project"] } });
    const scope = Effect.runSync(Scope.make());
    const gate = Effect.runSync(Deferred.make<void>());
    const registry = makeBrokerRegistry({ canonicalize: (path) => Effect.succeed(path) });
    let acquisitions = 0;
    let releases = 0;
    const controller = makeScopedController({
      configuration: config,
      factory: managerFactory(project, { P: "ready" }),
      registry: {
        ...registry,
        acquire: (factory, options) => {
          acquisitions++;
          return Deferred.await(gate).pipe(
            Effect.andThen(registry.acquire(factory, options)),
            Effect.map((lease) => ({
              ...lease,
              release: Effect.sync(() => releases++).pipe(Effect.andThen(lease.release)),
            })),
          );
        },
      },
      scope,
      reload: () => Effect.void,
    });
    controller.capture(editor.editor);
    controller.apply(editor.editor);
    let start: ReturnType<typeof Effect.runFork> | undefined;
    let refresh: ReturnType<typeof Effect.runFork> | undefined;
    try {
      start = Effect.runFork(controller.start);
      await new Promise((resolve) => setImmediate(resolve));
      // The runtime exists but its lease is still being acquired.
      expect(controller.runtimes.get("project")?.lease).toBeUndefined();
      refresh = Effect.runFork(controller.operation("refresh", { scope: "project" }));
      await new Promise((resolve) => setImmediate(resolve));
      await Effect.runPromise(Deferred.succeed(gate, undefined));
      await Effect.runPromise(Fiber.join(start));
      expect((await Effect.runPromise(Fiber.join(refresh))).phase).toBe("ready");
      expect(acquisitions).toBe(1);
      await Effect.runPromise(controller.dispose);
      expect(releases).toBe(1);
    } finally {
      await Effect.runPromise(Deferred.succeed(gate, undefined));
      for (const fiber of [start, refresh]) {
        if (fiber) await Effect.runPromise(Fiber.interrupt(fiber));
      }
      await Effect.runPromise(controller.dispose);
      await Scope.close(scope, { _tag: "Success", value: undefined } as never);
      await rm(root, { recursive: true, force: true });
    }
  });

  test.each(["refresh", "doctor"] as const)(
    "a lease acquired after disposal is released instead of adopted (%s)",
    async (kind) => {
      const { root, project } = await roots();
      const config = await configuration(
        project,
        '{"enabled":true,"servers":{"project":{"env":["P"]}}}',
      );
      const editor = editorFor({ project: { type: "local", command: ["project"] } });
      const scope = Effect.runSync(Scope.make());
      const gate = Effect.runSync(Deferred.make<void>());
      const registry = makeBrokerRegistry({ canonicalize: (path) => Effect.succeed(path) });
      let acquisitions = 0;
      let releases = 0;
      const controller = makeScopedController({
        configuration: config,
        factory: managerFactory(project, { P: "ready" }),
        registry: {
          ...registry,
          acquire: (factory, options) => {
            acquisitions++;
            if (acquisitions === 1)
              return Effect.fail(
                new VarlockError({ code: "start_failed", message: "synthetic", retryable: true }),
              );
            return Deferred.await(gate).pipe(
              Effect.andThen(registry.acquire(factory, options)),
              Effect.map((lease) => ({
                ...lease,
                release: Effect.sync(() => releases++).pipe(Effect.andThen(lease.release)),
              })),
            );
          },
        },
        scope,
        reload: () => Effect.void,
      });
      controller.capture(editor.editor);
      controller.apply(editor.editor);
      let operation: ReturnType<typeof Effect.runFork> | undefined;
      try {
        await Effect.runPromise(controller.start);
        operation = Effect.runFork(controller.operation(kind, { scope: "project" }));
        await new Promise((resolve) => setImmediate(resolve));
        await Effect.runPromise(controller.dispose);
        await Effect.runPromise(Deferred.succeed(gate, undefined));
        const exit = await Effect.runPromise(Fiber.await(operation));
        // Refresh reports the retired scope; doctor reports status and leaves
        // the scope stopped rather than recording a failure for it.
        expect(exit._tag).toBe(kind === "refresh" ? "Failure" : "Success");
        expect(acquisitions).toBe(2);
        expect(releases).toBe(1);
        expect(controller.runtimes.get("project")?.lease).toBeUndefined();
        expect(controller.runtimes.get("project")?.status?.phase).toBe("stopped");
        await Effect.runPromise(controller.dispose);
        expect(releases).toBe(1);
      } finally {
        await Effect.runPromise(Deferred.succeed(gate, undefined));
        if (operation) await Effect.runPromise(Fiber.interrupt(operation));
        await Effect.runPromise(controller.dispose);
        await Scope.close(scope, { _tag: "Success", value: undefined } as never);
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  test("doctor waiting on the observer settles when the controller is disposed", async () => {
    const { root, project } = await roots();
    const config = await configuration(
      project,
      '{"enabled":true,"servers":{"project":{"env":["P"]}}}',
    );
    const editor = editorFor({ project: { type: "local", command: ["project"] } });
    const scope = Effect.runSync(Scope.make());
    const controller = makeScopedController({
      configuration: config,
      factory: managerFactory(project, { P: "ready" }, new Promise(() => {})),
      registry: firstAcquireFailureRegistry(),
      scope,
      reload: () => Effect.void,
    });
    controller.capture(editor.editor);
    controller.apply(editor.editor);
    let doctor: ReturnType<typeof Effect.runFork> | undefined;
    try {
      await Effect.runPromise(controller.start);
      doctor = Effect.runFork(controller.operation("doctor", { scope: "project" }));
      const deadline = Date.now() + 2_000;
      while (!controller.runtimes.get("project")?.observer && Date.now() < deadline)
        await new Promise((resolve) => setImmediate(resolve));
      expect(controller.runtimes.get("project")?.observer).toBeDefined();
      await Effect.runPromise(controller.dispose);
      // Disposal releases the lease, which settles the pending startup, so the
      // doctor call returns the stopped status instead of waiting forever.
      const status = await Effect.runPromise(Fiber.join(doctor).pipe(Effect.timeout("2 seconds")));
      expect(status.phase).toBe("stopped");
    } finally {
      if (doctor) await Effect.runPromise(Fiber.interrupt(doctor));
      await Effect.runPromise(controller.dispose);
      await Scope.close(scope, { _tag: "Success", value: undefined } as never);
      await rm(root, { recursive: true, force: true });
    }
  });

  test("doctor reports a genuine first-start readiness failure", async () => {
    const { root, project } = await roots();
    const config = await configuration(
      project,
      '{"enabled":true,"servers":{"project":{"env":["P"]}}}',
    );
    const editor = editorFor({ project: { type: "local", command: ["project"] } });
    const scope = Effect.runSync(Scope.make());
    const controller = makeScopedController({
      configuration: config,
      factory: managerFactory(
        project,
        { P: "unused" },
        undefined,
        undefined,
        new VarlockError({
          code: "protocol_error",
          message: "synthetic startup failure",
          retryable: false,
        }),
      ),
      registry: firstAcquireFailureRegistry(),
      scope,
      reload: () => Effect.void,
    });
    controller.capture(editor.editor);
    controller.apply(editor.editor);
    try {
      await Effect.runPromise(controller.start);
      const status = await Effect.runPromise(controller.operation("doctor", { scope: "project" }));
      expect(status.phase).toBe("failed");
      expect(status.scopes?.[0]?.error?.code).toBe("protocol_error");
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
