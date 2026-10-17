import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Fiber, Layer } from "effect";
import { makeBrokerRegistry } from "../src/broker-registry.js";
import { ProjectKeyFerryManager, projectDirectory, VarlockError } from "../src/contracts.js";
import type {
  ProjectKeyFerryManagerFactory,
  ProjectKeyFerryManagerService,
} from "../src/contracts.js";
import { makePlugin } from "../src/plugin.js";

type ManagerState = {
  readonly root: string;
  readonly keys: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  starts: number;
  refreshes?: number;
  stops: number;
  ready: boolean;
  fail?: boolean;
};

type ScopeContext = {
  readonly context: unknown;
  readonly values: Map<string, any>;
  readonly reloads: { count: number };
  readonly handlers: { current?: Record<string, any> };
};

const waitFor = async (predicate: () => boolean): Promise<void> => {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("scoped fixture did not reach expected state");
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
};

function managerFor(state: ManagerState, gate?: Promise<void>): ProjectKeyFerryManagerService {
  const status = () => ({
    phase: state.ready ? ("ready" as const) : ("starting" as const),
    projectDirectory: projectDirectory(state.root),
    generation: state.ready ? 1 : 0,
  });
  const readySnapshot = () => ({ status: status(), environment: state.environment });
  const ensureReady = Effect.gen(function* () {
    state.starts += 1;
    if (gate) yield* Effect.promise(() => gate);
    if (state.fail)
      return yield* Effect.fail(
        new VarlockError({
          code: "start_failed",
          message: "fixture startup failed",
          retryable: true,
        }),
      );
    state.ready = true;
    return readySnapshot();
  });
  return {
    status: Effect.sync(status),
    ensureStarted: ensureReady.pipe(Effect.map(({ status: value }) => value)),
    ensureReady,
    environment: Effect.sync(() => state.environment),
    refresh: Effect.sync(status),
    refreshReady: Effect.sync(() => {
      state.refreshes = (state.refreshes ?? 0) + 1;
      return readySnapshot();
    }),
    dispose: Effect.sync(() => {
      state.stops += 1;
      state.ready = false;
    }),
    withExclusive: (effect) => effect,
  };
}

function factoryFor(
  states: Map<string, ManagerState>,
  gate?: Promise<void>,
): ProjectKeyFerryManagerFactory {
  return {
    layer: (options) => {
      const root = String(options.projectDirectory);
      const state = states.get(root);
      if (!state) throw new Error(`unexpected manager root: ${root}`);
      return Layer.succeed(
        ProjectKeyFerryManager,
        managerFor(state, state.keys.includes("P") ? gate : undefined),
      );
    },
  };
}

function scopeContext(
  location: string,
  options: Record<string, unknown>,
  servers: Record<string, any>,
): ScopeContext {
  const values = new Map(Object.entries(servers));
  const reloads = { count: 0 };
  const handlers: { current?: Record<string, any> } = {};
  let transform: ((value: typeof editor) => void) | undefined;
  const editor = {
    list: () => [...values.entries()],
    get: (name: string) => values.get(name),
    update: (name: string, update: (config: any) => void) => {
      const value = values.get(name);
      if (value) update(value);
    },
  };
  const context = {
    options,
    location: { project: { directory: location } },
    mcp: {
      transform: (callback: (value: typeof editor) => void) =>
        Effect.sync(() => {
          transform = callback;
          callback(editor);
        }),
      reload: () =>
        Effect.sync(() => {
          reloads.count++;
          transform?.(editor);
        }),
    },
    rpc: {
      register: (_definition: unknown, value: unknown) =>
        Effect.sync(() => {
          handlers.current = value as Record<string, any>;
          return { dispose: Effect.void, events: { emit: () => Effect.void } };
        }),
    },
  };
  return { context, values, reloads, handlers };
}

async function fixtureRoot(): Promise<{
  root: string;
  globalRoot: string;
  projectA: string;
  projectB: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "key-ferry-scoped-plugin-"));
  const globalRoot = await realpath(join(root, "global-root")).catch(async () => {
    await mkdir(join(root, "global-root"), { recursive: true });
    return realpath(join(root, "global-root"));
  });
  const projectA = join(root, "project-a");
  const projectB = join(root, "project-b");
  await mkdir(projectA, { recursive: true });
  await mkdir(projectB, { recursive: true });
  return {
    root,
    globalRoot,
    projectA: await realpath(projectA),
    projectB: await realpath(projectB),
  };
}

const globalOptions = (globalRoot: string) => ({
  projectDirectory: globalRoot,
  projectConfig: { enabled: true, activation: "auto" },
  command: ["fake-manager"],
  servers: { "global-service": { env: ["G"] } },
});

const projectFile = (activation = "auto") =>
  `{\n  "enabled": true,\n  "activation": "${activation}",\n  "servers": { "project-service": { "env": ["P"] } }\n}`;

const projectFileWith = (
  servers: Record<string, unknown>,
  activation = "auto",
  overrides?: string[],
) => JSON.stringify({ enabled: true, activation, ...(overrides ? { overrides } : {}), servers });

function run(plugin: ReturnType<typeof makePlugin>, scopes: readonly ScopeContext[]) {
  return scopes.map(({ context }) =>
    Effect.runFork(
      Effect.scoped(
        Effect.gen(function* () {
          yield* plugin.effect(context as never);
          yield* Effect.never;
        }),
      ),
    ),
  );
}

describe("public scoped plugin integration", () => {
  test("shares the global lease while isolating a project lease and environment keys", async () => {
    const fixture = await fixtureRoot();
    await mkdir(join(fixture.projectA, ".opencode"), { recursive: true });
    await writeFile(join(fixture.projectA, ".opencode/key-ferry.jsonc"), projectFile());
    const global = {
      root: fixture.globalRoot,
      keys: ["G"],
      environment: { G: "global-token" },
      starts: 0,
      stops: 0,
      ready: false,
    };
    const project = {
      root: fixture.projectA,
      keys: ["P"],
      environment: { P: "project-token" },
      starts: 0,
      stops: 0,
      ready: false,
    };
    const states = new Map([globalRootEntry(global), [fixture.projectA, project] as const]);
    const plugin = makePlugin(
      factoryFor(states),
      undefined,
      makeBrokerRegistry({ canonicalize: (path) => Effect.succeed(path) }),
    );
    const a = scopeContext(fixture.projectA, globalOptions(fixture.globalRoot), {
      "global-service": { type: "local", command: ["global"] },
      "project-service": { type: "local", command: ["project"] },
    });
    const b = scopeContext(fixture.projectB, globalOptions(fixture.globalRoot), {
      "global-service": { type: "local", command: ["global"] },
    });
    const fibers = run(plugin, [a, b]);
    try {
      await waitFor(() => global.starts === 1 && project.starts === 1);
      expect(global.starts).toBe(1);
      expect(project.starts).toBe(1);
      expect(a.values.get("global-service")?.environment).toEqual({ G: "global-token" });
      expect(a.values.get("project-service")?.environment).toEqual({ P: "project-token" });
      expect(b.values.get("global-service")?.environment).toEqual({ G: "global-token" });
      expect(a.values.get("project-service")?.environment).not.toHaveProperty("G");
      expect(a.values.get("global-service")?.environment).not.toHaveProperty("P");
    } finally {
      for (const fiber of fibers) await Effect.runPromise(Fiber.interrupt(fiber));
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("defers a blocked project without blocking global MCP readiness", async () => {
    const fixture = await fixtureRoot();
    await mkdir(join(fixture.projectA, ".opencode"), { recursive: true });
    await writeFile(join(fixture.projectA, ".opencode/key-ferry.jsonc"), projectFile());
    let unblock!: () => void;
    const gate = new Promise<void>((resolve) => (unblock = resolve));
    const global = {
      root: fixture.globalRoot,
      keys: ["G"],
      environment: { G: "global-token" },
      starts: 0,
      stops: 0,
      ready: false,
    };
    const project = {
      root: fixture.projectA,
      keys: ["P"],
      environment: { P: "project-token" },
      starts: 0,
      stops: 0,
      ready: false,
    };
    const states = new Map([globalRootEntry(global), [fixture.projectA, project] as const]);
    const plugin = makePlugin(
      factoryFor(states, gate),
      undefined,
      makeBrokerRegistry({ canonicalize: (path) => Effect.succeed(path) }),
    );
    const a = scopeContext(fixture.projectA, globalOptions(fixture.globalRoot), {
      "global-service": { type: "local", command: ["global"] },
      "project-service": { type: "local", command: ["project"] },
    });
    const b = scopeContext(fixture.projectB, globalOptions(fixture.globalRoot), {
      "global-service": { type: "local", command: ["global"] },
    });
    const fibers = run(plugin, [a, b]);
    try {
      await waitFor(() => global.ready && a.values.get("global-service")?.disabled === false);
      expect(a.values.get("project-service")?.disabled).toBe(true);
      expect(b.values.get("global-service")?.disabled).toBe(false);
      const starts = global.starts;
      unblock();
      await waitFor(() => project.ready && a.values.get("project-service")?.disabled === false);
      expect(global.starts).toBe(starts);
    } finally {
      unblock();
      for (const fiber of fibers) await Effect.runPromise(Fiber.interrupt(fiber));
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("releases only the project lease when A unloads, then global after B", async () => {
    const fixture = await fixtureRoot();
    await mkdir(join(fixture.projectA, ".opencode"), { recursive: true });
    await writeFile(join(fixture.projectA, ".opencode/key-ferry.jsonc"), projectFile());
    const global = {
      root: fixture.globalRoot,
      keys: ["G"],
      environment: { G: "global-token" },
      starts: 0,
      stops: 0,
      ready: false,
    };
    const project = {
      root: fixture.projectA,
      keys: ["P"],
      environment: { P: "project-token" },
      starts: 0,
      stops: 0,
      ready: false,
    };
    const states = new Map([globalRootEntry(global), [fixture.projectA, project] as const]);
    const plugin = makePlugin(
      factoryFor(states),
      undefined,
      makeBrokerRegistry({ canonicalize: (path) => Effect.succeed(path) }),
    );
    const a = scopeContext(fixture.projectA, globalOptions(fixture.globalRoot), {
      "global-service": { type: "local", command: ["global"] },
      "project-service": { type: "local", command: ["project"] },
    });
    const b = scopeContext(fixture.projectB, globalOptions(fixture.globalRoot), {
      "global-service": { type: "local", command: ["global"] },
    });
    const fibers = run(plugin, [a, b]);
    try {
      await waitFor(() => global.ready && project.ready);
      await Effect.runPromise(Fiber.interrupt(fibers[0]!));
      await waitFor(() => project.stops === 1);
      expect(global.stops).toBe(0);
      await Effect.runPromise(Fiber.interrupt(fibers[1]!));
      await waitFor(() => global.stops === 1);
    } finally {
      for (const fiber of fibers) await Effect.runPromise(Fiber.interrupt(fiber));
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("fails closed for a project startup failure without taking down global MCP", async () => {
    const fixture = await fixtureRoot();
    await mkdir(join(fixture.projectA, ".opencode"), { recursive: true });
    await writeFile(join(fixture.projectA, ".opencode/key-ferry.jsonc"), projectFile());
    const global = {
      root: fixture.globalRoot,
      keys: ["G"],
      environment: { G: "global-token" },
      starts: 0,
      stops: 0,
      ready: false,
    };
    const project = {
      root: fixture.projectA,
      keys: ["P"],
      environment: { P: "project-token" },
      starts: 0,
      stops: 0,
      ready: false,
      fail: true,
    };
    const states = new Map([globalRootEntry(global), [fixture.projectA, project] as const]);
    const plugin = makePlugin(
      factoryFor(states),
      undefined,
      makeBrokerRegistry({ canonicalize: (path) => Effect.succeed(path) }),
    );
    const a = scopeContext(fixture.projectA, globalOptions(fixture.globalRoot), {
      "global-service": { type: "local", command: ["global"] },
      "project-service": { type: "local", command: ["project"] },
    });
    const b = scopeContext(fixture.projectB, globalOptions(fixture.globalRoot), {
      "global-service": { type: "local", command: ["global"] },
    });
    const fibers = run(plugin, [a, b]);
    try {
      await waitFor(() => global.ready && project.starts === 1);
      expect(a.values.get("global-service")?.disabled).toBe(false);
      expect(b.values.get("global-service")?.disabled).toBe(false);
      expect(a.values.get("project-service")?.disabled).toBe(true);
      expect(global.stops).toBe(0);
    } finally {
      for (const fiber of fibers) await Effect.runPromise(Fiber.interrupt(fiber));
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("keeps a healthy project scope available when global startup fails", async () => {
    const fixture = await fixtureRoot();
    await mkdir(join(fixture.projectA, ".opencode"), { recursive: true });
    await writeFile(join(fixture.projectA, ".opencode/key-ferry.jsonc"), projectFile());
    const global = {
      root: fixture.globalRoot,
      keys: ["G"],
      environment: { G: "global-token" },
      starts: 0,
      stops: 0,
      ready: false,
      fail: true,
    };
    const project = {
      root: fixture.projectA,
      keys: ["P"],
      environment: { P: "project-token" },
      starts: 0,
      stops: 0,
      ready: false,
    };
    const plugin = makePlugin(
      factoryFor(new Map([globalRootEntry(global), [fixture.projectA, project] as const])),
      undefined,
      makeBrokerRegistry({ canonicalize: (path) => Effect.succeed(path) }),
    );
    const scope = scopeContext(fixture.projectA, globalOptions(fixture.globalRoot), {
      "global-service": { type: "local", command: ["global"] },
      "project-service": { type: "local", command: ["project"] },
      untouched: { type: "local", command: ["unrelated"] },
    });
    const fiber = run(plugin, [scope])[0]!;
    try {
      await waitFor(() => project.ready && scope.handlers.current !== undefined);
      const current = scope.handlers.current!;
      const aggregate = await Effect.runPromise(current.status({}));
      const projectStatus = await Effect.runPromise(current.status({ scope: "project" }));
      expect(global.starts).toBe(1);
      expect(project.starts).toBe(1);
      expect(scope.values.get("global-service")?.disabled).toBe(true);
      expect(scope.values.get("project-service")?.disabled).toBe(false);
      expect(scope.values.get("untouched")?.disabled).toBeUndefined();
      expect(aggregate.phase).toBe("degraded");
      expect(aggregate.scopes?.find((item: any) => item.scope === "global")?.phase).toBe("failed");
      expect(projectStatus.phase).toBe("ready");
      expect(projectStatus.scopes?.[0]?.scope).toBe("project");
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber));
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("does not let global root acquisition failure prevent project startup", async () => {
    const fixture = await fixtureRoot();
    await mkdir(join(fixture.projectA, ".opencode"), { recursive: true });
    await writeFile(join(fixture.projectA, ".opencode/key-ferry.jsonc"), projectFile());
    const global = {
      root: fixture.globalRoot,
      keys: ["G"],
      environment: { G: "global-token" },
      starts: 0,
      stops: 0,
      ready: false,
    };
    const project = {
      root: fixture.projectA,
      keys: ["P"],
      environment: { P: "project-token" },
      starts: 0,
      stops: 0,
      ready: false,
    };
    const plugin = makePlugin(
      factoryFor(new Map([globalRootEntry(global), [fixture.projectA, project] as const])),
      undefined,
      makeBrokerRegistry({
        canonicalize: (path) =>
          path === fixture.globalRoot
            ? Effect.fail(new Error("global canonicalization failed"))
            : Effect.succeed(path),
      }),
    );
    const scope = scopeContext(fixture.projectA, globalOptions(fixture.globalRoot), {
      "global-service": { type: "local", command: ["global"] },
      "project-service": { type: "local", command: ["project"] },
    });
    const fiber = run(plugin, [scope])[0]!;
    try {
      await waitFor(() => project.ready && scope.handlers.current !== undefined);
      const projectStatus = await Effect.runPromise(
        scope.handlers.current!.status({ scope: "project" }),
      );
      expect(global.starts).toBe(0);
      expect(project.starts).toBe(1);
      expect(scope.values.get("global-service")?.disabled).toBe(true);
      expect(scope.values.get("project-service")?.disabled).toBe(false);
      expect(projectStatus.phase).toBe("ready");
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber));
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("starts only an auto project when the global protection set is empty", async () => {
    const fixture = await fixtureRoot();
    await mkdir(join(fixture.projectA, ".opencode"), { recursive: true });
    await writeFile(join(fixture.projectA, ".opencode/key-ferry.jsonc"), projectFile());
    const global = {
      root: fixture.globalRoot,
      keys: ["G"],
      environment: { G: "global-token" },
      starts: 0,
      stops: 0,
      ready: false,
    };
    const project = {
      root: fixture.projectA,
      keys: ["P"],
      environment: { P: "project-token" },
      starts: 0,
      stops: 0,
      ready: false,
    };
    const plugin = makePlugin(
      factoryFor(new Map([globalRootEntry(global), [fixture.projectA, project] as const])),
      undefined,
      makeBrokerRegistry({ canonicalize: (path) => Effect.succeed(path) }),
    );
    const options = { ...globalOptions(fixture.globalRoot), servers: {} };
    const scope = scopeContext(fixture.projectA, options, {
      "project-service": { type: "local", command: ["project"] },
    });
    const fiber = run(plugin, [scope])[0]!;
    try {
      await waitFor(() => project.ready && scope.handlers.current !== undefined);
      const initial = await Effect.runPromise(scope.handlers.current!.status({}));
      expect(global.starts).toBe(0);
      expect(project.starts).toBe(1);
      expect(initial.phase).toBe("ready");
      expect(initial.projectDirectory).toBe(fixture.projectA);
      expect(initial.scopes?.[0]?.scope).toBe("project");
      expect(scope.values.get("project-service")?.disabled).toBe(false);
      await Effect.runPromise(
        scope.handlers.current!.refresh(
          {},
          { error: (code: string, data: unknown) => ({ code, data }) },
        ),
      );
      expect(project.starts).toBe(1);
      expect(project.refreshes).toBe(1);
      const refreshed = await Effect.runPromise(scope.handlers.current!.status({}));
      expect(refreshed.generation).toBe(1);
      expect(global.starts).toBe(0);
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber));
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("manual project activation does not auto-start or disable the global scope", async () => {
    const fixture = await fixtureRoot();
    await mkdir(join(fixture.projectA, ".opencode"), { recursive: true });
    await writeFile(join(fixture.projectA, ".opencode/key-ferry.jsonc"), projectFile("manual"));
    const global = {
      root: fixture.globalRoot,
      keys: ["G"],
      environment: { G: "global-token" },
      starts: 0,
      stops: 0,
      ready: false,
    };
    const project = {
      root: fixture.projectA,
      keys: ["P"],
      environment: { P: "project-token" },
      starts: 0,
      stops: 0,
      ready: false,
    };
    const states = new Map([globalRootEntry(global), [fixture.projectA, project] as const]);
    const plugin = makePlugin(
      factoryFor(states),
      undefined,
      makeBrokerRegistry({ canonicalize: (path) => Effect.succeed(path) }),
    );
    const a = scopeContext(fixture.projectA, globalOptions(fixture.globalRoot), {
      "global-service": { type: "local", command: ["global"] },
      "project-service": { type: "local", command: ["project"] },
    });
    const fibers = run(plugin, [a]);
    try {
      await waitFor(() => global.ready);
      expect(project.starts).toBe(0);
      expect(a.values.get("global-service")?.disabled).toBe(false);
      expect(a.values.get("project-service")?.disabled).toBe(true);
    } finally {
      for (const fiber of fibers) await Effect.runPromise(Fiber.interrupt(fiber));
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("activates a manual project only through the typed public RPC", async () => {
    const fixture = await fixtureRoot();
    await mkdir(join(fixture.projectA, ".opencode"), { recursive: true });
    await writeFile(join(fixture.projectA, ".opencode/key-ferry.jsonc"), projectFile("manual"));
    const global = {
      root: fixture.globalRoot,
      keys: ["G"],
      environment: { G: "GLOBAL" },
      starts: 0,
      stops: 0,
      ready: false,
    };
    const project = {
      root: fixture.projectA,
      keys: ["P"],
      environment: { P: "PROJECT" },
      starts: 0,
      stops: 0,
      ready: false,
    };
    const plugin = makePlugin(
      factoryFor(new Map([globalRootEntry(global), [fixture.projectA, project] as const])),
      undefined,
      makeBrokerRegistry({ canonicalize: (path) => Effect.succeed(path) }),
    );
    const scope = scopeContext(fixture.projectA, globalOptions(fixture.globalRoot), {
      "global-service": { type: "local", command: ["global"] },
      "project-service": { type: "local", command: ["project"] },
    });
    const fibers = run(plugin, [scope]);
    const rpcContext = { error: (code: string, data: unknown) => ({ code, data }) };
    try {
      await waitFor(() => global.ready && scope.handlers.current !== undefined);
      expect(project.starts).toBe(0);
      await Effect.runPromise(scope.handlers.current!.status({ scope: "project" }));
      await Effect.runPromise(scope.handlers.current!.refresh({ scope: "project" }, rpcContext));
      await Effect.runPromise(
        scope.handlers.current!.doctor({ server: "project-service" }, rpcContext),
      );
      expect(project.starts).toBe(0);
      await Effect.runPromise(scope.handlers.current!.activateProject({}, rpcContext));
      await waitFor(() => project.ready);
      expect(project.starts).toBe(1);
      await Effect.runPromise(scope.handlers.current!.activateProject({}, rpcContext));
      expect(project.starts).toBe(1);
      expect(scope.values.get("project-service")?.environment).toEqual({ P: "PROJECT" });
      expect(global.starts).toBe(1);
    } finally {
      for (const fiber of fibers) await Effect.runPromise(Fiber.interrupt(fiber));
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("routes status selectors without falling back to another scope", async () => {
    const fixture = await fixtureRoot();
    await mkdir(join(fixture.projectA, ".opencode"), { recursive: true });
    await writeFile(join(fixture.projectA, ".opencode/key-ferry.jsonc"), projectFile());
    const global = {
      root: fixture.globalRoot,
      keys: ["G"],
      environment: { G: "GLOBAL" },
      starts: 0,
      stops: 0,
      ready: false,
    };
    const project = {
      root: fixture.projectA,
      keys: ["P"],
      environment: { P: "PROJECT" },
      starts: 0,
      stops: 0,
      ready: false,
    };
    const plugin = makePlugin(
      factoryFor(new Map([globalRootEntry(global), [fixture.projectA, project] as const])),
      undefined,
      makeBrokerRegistry({ canonicalize: (path) => Effect.succeed(path) }),
    );
    const scope = scopeContext(fixture.projectA, globalOptions(fixture.globalRoot), {
      "global-service": { type: "local", command: ["global"] },
      "project-service": { type: "local", command: ["project"] },
    });
    const fibers = run(plugin, [scope]);
    try {
      await waitFor(() => global.ready && project.ready && scope.handlers.current !== undefined);
      const handlers = scope.handlers.current!;
      const projectStatus = await Effect.runPromise(handlers.status({ scope: "project" }));
      const globalStatus = await Effect.runPromise(handlers.status({ scope: "global" }));
      const serverStatus = await Effect.runPromise(handlers.status({ server: "project-service" }));
      expect(projectStatus.scopes?.[0]?.scope).toBe("project");
      expect(globalStatus.scopes?.[0]?.scope).toBe("global");
      expect(serverStatus.scopes?.[0]?.scope).toBe("project");
      const starts = { global: global.starts, project: project.starts };
      const mismatch = await Effect.runPromise(
        handlers.status({ scope: "global", server: "project-service" }),
      );
      const unbound = await Effect.runPromise(handlers.status({ server: "not-bound" }));
      expect(mismatch.phase).toBe("failed");
      expect(unbound.phase).toBe("failed");
      expect(mismatch.diagnostics?.[0]?.code).toBe("server_unbound");
      expect(unbound.diagnostics?.[0]?.code).toBe("server_unbound");
      expect(global.starts).toBe(starts.global);
      expect(project.starts).toBe(starts.project);
    } finally {
      for (const fiber of fibers) await Effect.runPromise(Fiber.interrupt(fiber));
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("watches semantic project changes and keeps global lifecycle stable", async () => {
    const fixture = await fixtureRoot();
    const configPath = join(fixture.projectA, ".opencode/key-ferry.jsonc");
    await mkdir(join(fixture.projectA, ".opencode"), { recursive: true });
    await writeFile(configPath, projectFileWith({ "project-service": { env: ["P"] } }));
    const global = {
      root: fixture.globalRoot,
      keys: ["G"],
      environment: { G: "GLOBAL" },
      starts: 0,
      stops: 0,
      ready: false,
    };
    const project = {
      root: fixture.projectA,
      keys: ["P", "P2"],
      environment: { P: "OLD", P2: "NEXT" },
      starts: 0,
      stops: 0,
      ready: false,
    };
    const plugin = makePlugin(
      factoryFor(new Map([globalRootEntry(global), [fixture.projectA, project] as const])),
      undefined,
      makeBrokerRegistry({ canonicalize: (path) => Effect.succeed(path) }),
    );
    const scope = scopeContext(fixture.projectA, globalOptions(fixture.globalRoot), {
      "global-service": { type: "local", command: ["global"] },
      "project-service": { type: "local", command: ["project"] },
    });
    const fibers = run(plugin, [scope]);
    try {
      await waitFor(() => global.ready && project.starts === 1);
      const reloads = scope.reloads.count;
      await writeFile(
        configPath,
        `// formatting only\n${projectFileWith({ "project-service": { env: ["P"] } })}`,
      );
      await new Promise((resolve) => setTimeout(resolve, 350));
      expect(project.starts).toBe(1);
      expect(global.starts).toBe(1);
      await writeFile(configPath, projectFileWith({ "project-service": { env: ["P2"] } }));
      await waitFor(() => project.starts === 2 && project.stops === 1);
      expect(scope.values.get("project-service")?.environment).toEqual({ P2: "NEXT" });
      expect(global.starts).toBe(1);
      expect(scope.reloads.count).toBeGreaterThan(reloads);
      await writeFile(configPath, "{ invalid");
      await waitFor(
        () => project.stops === 2 && scope.values.get("project-service")?.disabled === true,
      );
      expect(global.ready).toBe(true);
      await writeFile(configPath, projectFileWith({ "project-service": { env: ["P2"] } }));
      await waitFor(() => project.starts === 3 && project.ready);
      expect(global.starts).toBe(1);
    } finally {
      for (const fiber of fibers) await Effect.runPromise(Fiber.interrupt(fiber));
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("fails closed on a collision and permits only an explicit project override", async () => {
    const fixture = await fixtureRoot();
    const configPath = join(fixture.projectA, ".opencode/key-ferry.jsonc");
    await mkdir(join(fixture.projectA, ".opencode"), { recursive: true });
    await writeFile(configPath, projectFileWith({ "global-service": { env: ["P"] } }));
    const global = {
      root: fixture.globalRoot,
      keys: ["G1", "G2"],
      environment: { G1: "GLOBAL-ONE", G2: "GLOBAL-TWO" },
      starts: 0,
      stops: 0,
      ready: false,
    };
    const project = {
      root: fixture.projectA,
      keys: ["P"],
      environment: { P: "PROJECT" },
      starts: 0,
      stops: 0,
      ready: false,
    };
    const options = {
      ...globalOptions(fixture.globalRoot),
      servers: {
        "global-service": { env: ["G1"] },
        "global-other": { env: ["G2"] },
      },
    };
    const plugin = makePlugin(
      factoryFor(new Map([globalRootEntry(global), [fixture.projectA, project] as const])),
      undefined,
      makeBrokerRegistry({ canonicalize: (path) => Effect.succeed(path) }),
    );
    const scope = scopeContext(fixture.projectA, options, {
      "global-service": { type: "local", command: ["global"] },
      "global-other": { type: "local", command: ["other"] },
    });
    const fibers = run(plugin, [scope]);
    try {
      await waitFor(() => global.ready && scope.handlers.current !== undefined);
      expect(project.starts).toBe(0);
      expect(scope.values.get("global-service")?.environment).toEqual({ G1: "GLOBAL-ONE" });
      await writeFile(
        configPath,
        projectFileWith({ "global-service": { env: ["P"] } }, "auto", ["global-service"]),
      );
      await waitFor(() => project.ready);
      expect(scope.values.get("global-service")?.environment).toEqual({ P: "PROJECT" });
      expect(scope.values.get("global-other")?.environment).toEqual({ G2: "GLOBAL-TWO" });
      expect(global.starts).toBe(1);
    } finally {
      for (const fiber of fibers) await Effect.runPromise(Fiber.interrupt(fiber));
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});

function globalRootEntry(state: ManagerState): readonly [string, ManagerState] {
  return [state.root, state] as const;
}
