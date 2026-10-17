import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Fiber, Layer } from "effect";
import { makeBrokerRegistry } from "../src/broker-registry.js";
import { ProjectKeyFerryManager, projectDirectory, VarlockError } from "../src/contracts.js";
import { makePlugin } from "../src/plugin.js";

type FailureCode = "start_failed" | "protocol_error";
type ManagerInstance = {
  readonly root: string;
  readonly build: number;
  ensureReadyCalls: number;
  disposeCalls: number;
  generation: number;
  ready: boolean;
};

type ScopeFixture = {
  readonly root: string;
  readonly globalRoot: string;
  readonly projectRoot: string;
  readonly values: Map<string, any>;
  readonly reloads: { count: number };
  readonly handlers: { current?: Record<string, any> };
  readonly context: any;
};

const waitFor = async (predicate: () => boolean): Promise<void> => {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("recovery fixture did not reach expected state");
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
};

function managerFor(instance: ManagerInstance, failures: readonly FailureCode[]) {
  const status = () => ({
    phase: instance.ready ? ("ready" as const) : ("starting" as const),
    projectDirectory: projectDirectory(instance.root),
    generation: instance.generation,
  });
  const ensureReady = Effect.gen(function* () {
    instance.ensureReadyCalls += 1;
    const code = failures[instance.build - 1];
    if (code !== undefined)
      return yield* Effect.fail(
        new VarlockError({
          code,
          message: `synthetic raw cause ${code} with secret-canary`,
          retryable: true,
        }),
      );
    instance.ready = true;
    instance.generation = Math.max(instance.generation, 1);
    return {
      status: status(),
      environment: { [instance.root.endsWith("/project") ? "P" : "G"]: `FAKE-${instance.build}` },
    };
  });
  const refreshReady = Effect.gen(function* () {
    instance.generation += 1;
    return {
      status: status(),
      environment: {
        [instance.root.endsWith("/project") ? "P" : "G"]: `REFRESH-${instance.build}`,
      },
    };
  });
  return {
    status: Effect.sync(status),
    ensureStarted: ensureReady.pipe(Effect.map(({ status: value }) => value)),
    ensureReady,
    environment: Effect.succeed({
      [instance.root.endsWith("/project") ? "P" : "G"]: `FAKE-${instance.build}`,
    }),
    refresh: Effect.sync(status),
    refreshReady,
    dispose: Effect.sync(() => {
      instance.disposeCalls += 1;
      instance.ready = false;
    }),
    withExclusive: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
  };
}

function factoryFor(instances: ManagerInstance[], projectFailures: readonly FailureCode[]): any {
  return {
    layer: (options: { projectDirectory: string }) => {
      const root = String(options.projectDirectory);
      const build = instances.filter((item) => item.root === root).length + 1;
      const instance = {
        root,
        build,
        ensureReadyCalls: 0,
        disposeCalls: 0,
        generation: 0,
        ready: false,
      };
      instances.push(instance);
      return Layer.succeed(
        ProjectKeyFerryManager,
        managerFor(instance, root.endsWith("/project") ? projectFailures : []),
      );
    },
  };
}

async function makeFixture(): Promise<ScopeFixture> {
  const root = await mkdtemp(join(tmpdir(), "key-ferry-failed-project-"));
  const globalPath = join(root, "global");
  const projectPath = join(root, "project");
  await mkdir(globalPath, { recursive: true });
  await mkdir(join(projectPath, ".opencode"), { recursive: true });
  const globalRoot = await realpath(globalPath);
  const projectRoot = await realpath(projectPath);
  await writeFile(
    join(projectRoot, ".opencode/key-ferry.jsonc"),
    JSON.stringify({
      enabled: true,
      activation: "auto",
      servers: { "project-service": { env: ["P"] } },
    }),
  );
  const values = new Map<string, any>([
    ["global-service", { type: "local", command: ["fake-global"] }],
    ["project-service", { type: "local", command: ["fake-project"] }],
  ]);
  const reloads = { count: 0 };
  const handlers: { current?: Record<string, any> } = {};
  const editor = {
    list: () => [...values.entries()],
    get: (name: string) => values.get(name),
    update: (name: string, update: (config: any) => void) => {
      const config = values.get(name);
      if (config) update(config);
    },
  };
  const context = {
    options: {
      projectDirectory: globalRoot,
      projectConfig: { enabled: true, activation: "auto" },
      command: ["fake-manager"],
      servers: { "global-service": { env: ["G"] } },
    },
    location: { project: { directory: projectRoot } },
    mcp: {
      transform: (callback: (value: typeof editor) => void) => Effect.sync(() => callback(editor)),
      reload: () => Effect.sync(() => void reloads.count++),
    },
    rpc: {
      register: (_definition: unknown, handlersValue: unknown) =>
        Effect.sync(() => {
          handlers.current = handlersValue as Record<string, any>;
          return { dispose: Effect.void, events: { emit: () => Effect.void } };
        }),
    },
  };
  return { root, globalRoot, projectRoot, values, reloads, handlers, context };
}

function startPlugin(plugin: ReturnType<typeof makePlugin>, fixture: ScopeFixture) {
  return Effect.runFork(
    Effect.scoped(
      Effect.gen(function* () {
        yield* plugin.effect(fixture.context as never);
        yield* Effect.never;
      }),
    ),
  );
}

const rpcContext = { error: (code: string, data: unknown) => ({ code, data }) };

describe("failed project recovery through the public plugin RPC", () => {
  test("doctor retries with a new manager and reconciles project MCP readiness", async () => {
    const fixture = await makeFixture();
    const instances: ManagerInstance[] = [];
    const plugin = makePlugin(
      factoryFor(instances, ["start_failed"]),
      undefined,
      makeBrokerRegistry({ canonicalize: (path) => Effect.succeed(path) }),
    );
    const fiber = startPlugin(plugin, fixture);
    try {
      await waitFor(
        () =>
          fixture.handlers.current !== undefined &&
          instances.some(
            (item) =>
              item.root === fixture.projectRoot && item.build === 1 && item.ensureReadyCalls === 1,
          ),
      );
      expect(
        (await Effect.runPromise(fixture.handlers.current!.status({ scope: "project" }))).phase,
      ).toBe("failed");
      const doctor = await Effect.runPromise(
        fixture.handlers.current!.doctor({ scope: "project" }, rpcContext),
      );
      await waitFor(() =>
        instances.some(
          (item) => item.root === fixture.projectRoot && item.build === 2 && item.ready,
        ),
      );
      await waitFor(() => {
        const value = fixture.values.get("project-service");
        return value?.disabled === false && value?.environment?.P === "FAKE-2";
      });
      const status = await Effect.runPromise(
        fixture.handlers.current!.status({ scope: "project" }),
      );
      expect(doctor.phase).toBe("ready");
      expect(status.phase).toBe("ready");
      expect(status.scopes?.find((scope: any) => scope.scope === "project")?.phase).toBe("ready");
      expect(fixture.values.get("project-service")).toMatchObject({
        disabled: false,
        environment: { P: "FAKE-2" },
      });
      expect(
        instances
          .filter((item) => item.root === fixture.globalRoot)
          .map((item) => [item.build, item.ensureReadyCalls]),
      ).toEqual([[1, 1]]);
      expect(
        instances
          .filter((item) => item.root === fixture.projectRoot)
          .map((item) => [item.build, item.ensureReadyCalls]),
      ).toEqual([
        [1, 1],
        [2, 1],
      ]);
      expect(instances.every((item) => item.disposeCalls === 0)).toBe(true);
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber));
      await rm(fixture.root, { recursive: true, force: true });
    }
    expect(instances.filter((item) => item.root === fixture.globalRoot)).toHaveLength(1);
    expect(instances.filter((item) => item.root === fixture.projectRoot)).toHaveLength(2);
    expect(instances.find((item) => item.root === fixture.globalRoot)?.disposeCalls).toBe(1);
    expect(
      instances.find((item) => item.root === fixture.projectRoot && item.build === 2)?.disposeCalls,
    ).toBe(1);
  });

  test("doctor preserves a typed retry failure while sanitizing its raw cause", async () => {
    const fixture = await makeFixture();
    const instances: ManagerInstance[] = [];
    const plugin = makePlugin(
      factoryFor(instances, ["start_failed", "protocol_error"]),
      undefined,
      makeBrokerRegistry({ canonicalize: (path) => Effect.succeed(path) }),
    );
    const fiber = startPlugin(plugin, fixture);
    try {
      await waitFor(
        () =>
          fixture.handlers.current !== undefined &&
          instances.filter((item) => item.root === fixture.projectRoot).length === 1,
      );
      const initial = await Effect.runPromise(
        fixture.handlers.current!.status({ scope: "project" }),
      );
      expect(initial.phase).toBe("failed");
      expect(initial.error?.code).toBe("start_failed");
      expect(JSON.stringify(initial)).not.toContain("secret-canary");
      await Effect.runPromise(fixture.handlers.current!.doctor({ scope: "project" }, rpcContext));
      await waitFor(
        () =>
          instances.filter((item) => item.root === fixture.projectRoot).length === 2 &&
          instances[1].ensureReadyCalls === 1,
      );
      const retryFailure = await Effect.runPromise(
        fixture.handlers.current!.status({ scope: "project" }),
      );
      expect(retryFailure.phase).toBe("failed");
      expect(retryFailure.error?.code).toBe("protocol_error");
      expect(retryFailure.error?.message).toBe("Varlock returned an invalid response");
      expect(JSON.stringify(retryFailure)).not.toContain("synthetic raw cause");
      expect(JSON.stringify(retryFailure)).not.toContain("secret-canary");
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber));
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("a recovered project refreshes independently without restarting global", async () => {
    const fixture = await makeFixture();
    const instances: ManagerInstance[] = [];
    const plugin = makePlugin(
      factoryFor(instances, ["start_failed"]),
      undefined,
      makeBrokerRegistry({ canonicalize: (path) => Effect.succeed(path) }),
    );
    const fiber = startPlugin(plugin, fixture);
    try {
      await waitFor(
        () =>
          fixture.handlers.current !== undefined &&
          instances.filter((item) => item.root === fixture.projectRoot).length === 1,
      );
      await Effect.runPromise(fixture.handlers.current!.doctor({ scope: "project" }, rpcContext));
      await waitFor(() => fixture.values.get("project-service")?.environment?.P === "FAKE-2");
      const refreshed = await Effect.runPromise(
        fixture.handlers.current!.refresh({ scope: "project" }, rpcContext),
      );
      expect(refreshed.phase).toBe("ready");
      expect(fixture.values.get("project-service")).toMatchObject({
        disabled: false,
        environment: { P: "REFRESH-2" },
      });
      expect(
        instances
          .filter((item) => item.root === fixture.globalRoot)
          .map((item) => item.ensureReadyCalls),
      ).toEqual([1]);
      expect(
        instances.filter((item) => item.root === fixture.projectRoot).map((item) => item.build),
      ).toEqual([1, 2]);
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber));
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});
