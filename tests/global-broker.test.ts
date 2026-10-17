import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Fiber, Layer } from "effect";
import { ProjectKeyFerryManager, projectDirectory } from "../src/contracts.js";
import { makePlugin } from "../src/plugin.js";
import {
  Process,
  ProcessError,
  type ManagedProcess,
  type ProcessService,
  type RunInput,
  type RunResult,
  type SpawnInput,
} from "../src/services/process.js";
import { makeProjectKeyFerryManager } from "../src/varlock/manager.js";

/**
 * This is deliberately a local MCP fixture.  It exercises the real plugin
 * effect and the real manager; the process boundary is the only substituted
 * dependency.  In particular, no Varlock, 1Password, or network process is
 * started by this test.
 */
type Fixture = {
  readonly service: ProcessService;
  attempts: number;
  failed: boolean;
  readonly spawns: number[];
  readonly stops: number[];
  readonly runs: Array<{ readonly account: string; readonly operation: string }>;
  readonly certDirectories: string[];
};

type FakeMode = "ready" | "fail" | "blocked";

function fakeProcess(
  project: string,
  mode: FakeMode = "ready",
  gate?: Promise<void>,
  refreshGate?: Promise<void>,
): Fixture {
  const fixture: Fixture = {
    service: undefined as never,
    attempts: 0,
    failed: mode === "fail",
    spawns: [],
    stops: [],
    runs: [],
    certDirectories: [],
  };
  let nextPid = 7100;
  const sessions = new Map<number, { readonly certPath: string; readonly uuid: string }>();

  const service: ProcessService = {
    spawn: (input: SpawnInput) =>
      Effect.gen(function* () {
        fixture.attempts += 1;
        if (mode === "blocked") yield* Effect.promise(() => gate!);
        if (fixture.failed)
          return yield* Effect.fail(
            new ProcessError({
              phase: "spawn",
              code: "spawn-failed",
              message: "safe fixture error",
            }),
          );
        const pid = nextPid++;
        fixture.spawns.push(pid);
        const certIndex = input.args.indexOf("--cert-dir");
        const certDirectory = input.args[certIndex + 1];
        assert.equal(typeof certDirectory, "string");
        fixture.certDirectories.push(certDirectory);
        mkdirSync(certDirectory, { recursive: true, mode: 0o700 });
        writeFileSync(join(certDirectory, "ca-cert.pem"), "fixture\n", { mode: 0o600 });
        sessions.set(pid, {
          certPath: join(certDirectory, "ca-cert.pem"),
          uuid: `fixture-session-${pid}`,
        });

        let alive = true;
        const stop = Effect.sync(() => {
          if (alive) {
            alive = false;
            fixture.stops.push(pid);
          }
        });
        const managed: ManagedProcess = {
          pid,
          completion: Effect.never,
          health: Effect.sync(() => ({ pid, running: alive })),
          stop,
        };
        return managed;
      }),
    run: (input: RunInput): Effect.Effect<RunResult, never> => {
      const account = input.cwd === project ? "shared-project" : input.cwd;
      const operation = input.args.includes("status")
        ? "status"
        : input.args.includes("env")
          ? "environment"
          : "other";
      fixture.runs.push({ account, operation });
      if (operation === "other" && refreshGate)
        return Effect.promise(async () => {
          await refreshGate;
          return { code: 0, signal: null, stdout: "{}", stderr: "" };
        });
      if (operation === "status") {
        const records = [...sessions].map(([pid, session]) => ({
          id: `fixture-${pid}`,
          uuid: session.uuid,
          ownerPid: pid,
          cwd: project,
          startedAt: "2026-10-17T00:00:00.000Z",
          updatedAt: "2026-10-17T00:00:01.000Z",
          egressMode: "strict",
          env: {
            HTTP_PROXY: "http://127.0.0.1:43821",
            HTTPS_PROXY: "http://127.0.0.1:43821",
            NODE_EXTRA_CA_CERTS: session.certPath,
          },
          placeholderOverrides: {
            STROM2_API_KEY: "fixture-placeholder",
            FINNVID_API_KEY: "fixture-placeholder",
          },
        }));
        return Effect.succeed({
          code: 0,
          signal: null,
          stdout: JSON.stringify(records),
          stderr: "fixture diagnostics are intentionally omitted",
        });
      }
      const sessionPid = Number(
        input.args[input.args.indexOf("--session") + 1]?.replace("fixture-session-", ""),
      );
      const session = sessions.get(sessionPid);
      assert.ok(session, `fixture session missing for ${input.args.join(" ")}`);
      return Effect.succeed({
        code: 0,
        signal: null,
        stdout: JSON.stringify({
          HTTP_PROXY: "http://127.0.0.1:43821",
          HTTPS_PROXY: "http://127.0.0.1:43821",
          NODE_EXTRA_CA_CERTS: session.certPath,
          STROM2_API_KEY: "fixture-placeholder",
          FINNVID_API_KEY: "fixture-placeholder",
        }),
        stderr: "",
      });
    },
  };
  fixture.service = service;
  return fixture;
}

function managerLayer(fixture: Fixture, project: string) {
  return makeProjectKeyFerryManager(
    {
      projectDirectory: projectDirectory(project),
      adapter: {
        command: ["varlock"],
        environmentKeys: ["STROM2_API_KEY", "FINNVID_API_KEY"],
        startupTimeoutMs: 2_000,
        commandTimeoutMs: 2_000,
        reloadTimeoutMs: 2_000,
        pollIntervalMs: 10,
        requireStrictEgress: true,
      },
    },
    Layer.succeed(Process, Process.of(fixture.service)),
  );
}

function pluginContext(location: string, project: string) {
  const editor = {
    list: () => [],
    get: () => undefined,
    update: () => undefined,
  };
  return {
    // The absolute projectDirectory makes all eleven manager options
    // canonical-identical while the host locations/scopes remain distinct.
    options: {
      projectDirectory: project,
      command: ["varlock"],
      servers: { local: { env: ["STROM2_API_KEY", "FINNVID_API_KEY"] } },
      startupTimeoutMs: 2_000,
      commandTimeoutMs: 2_000,
      reloadTimeoutMs: 2_000,
      pollIntervalMs: 10,
      requireStrictEgress: true,
    },
    location: { project: { directory: location } },
    mcp: {
      transform: (callback: (value: typeof editor) => void) => Effect.sync(() => callback(editor)),
      reload: () => Effect.void,
    },
    rpc: {
      register: () => Effect.succeed({ dispose: Effect.void, events: { emit: () => Effect.void } }),
    },
  } as never;
}

function protectedPluginContext(location: string, project: string) {
  const values = new Map<string, any>([
    ["selected", { type: "local", command: ["fixture"], environment: { KEEP: "ambient" } }],
    ["nativeOAuth", { type: "remote", url: "https://oauth.example.test/mcp" }],
  ]);
  const editor = {
    list: () => [...values.entries()],
    get: (name: string) => values.get(name),
    update: (name: string, update: (config: any) => void) => {
      const config = values.get(name);
      if (config) update(config);
    },
  };
  const context = pluginContext(location, project) as any;
  context.options.servers = { selected: { env: ["STROM2_API_KEY", "FINNVID_API_KEY"] } };
  let transform: ((value: typeof editor) => void) | undefined;
  context.mcp.transform = (callback: (value: typeof editor) => void) =>
    Effect.sync(() => {
      transform = callback;
      callback(editor);
    });
  context.mcp.reload = () =>
    Effect.sync(() => {
      if (editor.get("selected")?.disabled === true) editor.get("selected")!.disabled = undefined;
      transform?.(editor);
    });
  return { context, values };
}

async function runPluginContexts(
  plugin: ReturnType<typeof makePlugin>,
  contexts: readonly unknown[],
) {
  const fibers = contexts.map((context) =>
    Effect.runFork(
      Effect.scoped(
        Effect.gen(function* () {
          yield* plugin.effect(context as never);
          yield* Effect.never;
        }),
      ),
    ),
  );
  return fibers;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("fixture did not reach expected state");
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

test("global broker fanout: eleven plugin scopes must share one manager process", async () => {
  const root = await mkdtemp(join(tmpdir(), "key-ferry-global-broker-"));
  const project = join(root, "project");
  mkdirSync(project, { recursive: true });
  const canonicalProject = await realpath(project);
  const fixture = fakeProcess(canonicalProject);
  const factory = { layer: () => managerLayer(fixture, canonicalProject) };
  const plugin = makePlugin(factory);
  const locations = await Promise.all(
    Array.from({ length: 11 }, (_, index) => mkdtemp(join(root, `host-${index}-`))),
  );

  let fibers: ReturnType<typeof Effect.runFork>[] = [];
  try {
    fibers = await runPluginContexts(
      plugin,
      locations.map((location) => pluginContext(location, canonicalProject)),
    );
    await waitFor(() => fixture.spawns.length === 1);
    assert.equal(fixture.spawns.length, 1);
    assert.equal(fixture.runs.filter((run) => run.operation === "status").length, 1);
    assert.equal(fixture.runs.filter((run) => run.operation === "environment").length, 1);
    for (const fiber of fibers) await Effect.runPromise(Fiber.interrupt(fiber));
    assert.equal(fixture.stops.length, 1);
  } finally {
    for (const fiber of fibers) await Effect.runPromise(Fiber.interrupt(fiber));
    assert.equal(fixture.stops.length, fixture.spawns.length);
    for (const directory of fixture.certDirectories) assert.equal(existsSync(directory), false);
    await rm(root, { recursive: true, force: true });
  }
});

test("global broker does not share managers across distinct Varlock roots", async () => {
  const root = await mkdtemp(join(tmpdir(), "key-ferry-global-broker-roots-"));
  const projects = await Promise.all(
    ["one", "two"].map(async (name) => {
      const path = join(root, name);
      mkdirSync(path, { recursive: true });
      return realpath(path);
    }),
  );
  const fixtures = projects.map((project) => fakeProcess(project));
  const fixtureByProject = new Map(
    projects.map((project, index) => [project, fixtures[index]!]),
  ) as Map<string, Fixture>;
  const factory = {
    layer: (options: { projectDirectory: string }) =>
      managerLayer(fixtureByProject.get(options.projectDirectory)!, options.projectDirectory),
  };
  const plugin = makePlugin(factory);
  const locations = await Promise.all(
    Array.from({ length: 11 }, (_, index) => mkdtemp(join(root, `host-${index}-`))),
  );

  let fibers: ReturnType<typeof Effect.runFork>[] = [];
  try {
    fibers = await runPluginContexts(
      plugin,
      locations.map((location, index) => pluginContext(location, projects[index % 2]!)),
    );
    await waitFor(() => fixtures.every((fixture) => fixture.spawns.length === 1));
    assert.deepEqual(
      fixtures.map((fixture) => fixture.spawns.length),
      [1, 1],
    );
    for (const fiber of fibers) await Effect.runPromise(Fiber.interrupt(fiber));
  } finally {
    for (const fiber of fibers) await Effect.runPromise(Fiber.interrupt(fiber));
    assert.deepEqual(
      fixtures.map((fixture) => fixture.stops.length),
      fixtures.map((fixture) => fixture.spawns.length),
    );
    for (const fixture of fixtures)
      for (const directory of fixture.certDirectories) assert.equal(existsSync(directory), false);
    await rm(root, { recursive: true, force: true });
  }
});

test("failed global startup attempts once and disables only protected local MCP", async () => {
  const root = await mkdtemp(join(tmpdir(), "key-ferry-global-broker-failure-"));
  const project = join(root, "project");
  mkdirSync(project, { recursive: true });
  const canonicalProject = await realpath(project);
  const fixture = fakeProcess(canonicalProject, "fail");
  const plugin = makePlugin({ layer: () => managerLayer(fixture, canonicalProject) });
  const locations = await Promise.all(
    Array.from({ length: 11 }, (_, index) => mkdtemp(join(root, `host-${index}-`))),
  );
  const contexts = locations.map((location) => protectedPluginContext(location, canonicalProject));
  const refreshHandlers: Array<(input: {}, context: { error: Function }) => unknown> = [];
  for (const { context } of contexts) {
    context.rpc.register = (
      _definition: unknown,
      handlers: { refresh: (typeof refreshHandlers)[number] },
    ) =>
      Effect.sync(() => {
        refreshHandlers.push(handlers.refresh);
        return { dispose: Effect.void, events: { emit: () => Effect.void } };
      });
  }

  let fibers: ReturnType<typeof Effect.runFork>[] = [];
  try {
    fibers = await runPluginContexts(
      plugin,
      contexts.map(({ context }) => context),
    );
    await waitFor(
      () =>
        fixture.attempts === 1 &&
        contexts.every(({ values }) => values.get("selected")?.disabled === true),
    );
    for (const { values } of contexts) {
      assert.equal(values.get("selected")?.disabled, true);
      assert.deepEqual(values.get("selected")?.environment, { KEEP: "ambient" });
      assert.equal(values.get("nativeOAuth")?.disabled, undefined);
      assert.doesNotMatch(JSON.stringify(values), /fixture-placeholder|CONTROL_CANARY|DATA_CANARY/);
    }
    assert.equal(fixture.attempts, 1);
    fixture.failed = false;
    await Effect.runPromise(
      Effect.all(
        refreshHandlers.map(
          (refresh) =>
            refresh({}, { error: (code, data) => ({ code, data }) }) as Effect.Effect<unknown>,
        ),
        { concurrency: "unbounded" },
      ),
    );
    assert.equal(fixture.attempts, 2);
  } finally {
    for (const fiber of fibers) await Effect.runPromise(Fiber.interrupt(fiber));
    assert.equal(fixture.stops.length, 1);
    await rm(root, { recursive: true, force: true });
  }
});

test("shared broker remains alive until the last plugin scope releases it", async () => {
  const root = await mkdtemp(join(tmpdir(), "key-ferry-global-broker-lease-"));
  const project = join(root, "project");
  mkdirSync(project, { recursive: true });
  const canonicalProject = await realpath(project);
  const fixture = fakeProcess(canonicalProject);
  const factory = { layer: () => managerLayer(fixture, canonicalProject) };
  const plugin = makePlugin(factory);
  const locations = await Promise.all(
    Array.from({ length: 11 }, (_, index) => mkdtemp(join(root, `host-${index}-`))),
  );
  let registered = 0;
  let signalReady!: () => void;
  const allRegistered = new Promise<void>((resolve) => (signalReady = resolve));
  const contexts = locations.map((location) => {
    const context = pluginContext(location, canonicalProject) as any;
    context.rpc.register = () =>
      Effect.sync(() => {
        registered += 1;
        if (registered === locations.length) signalReady();
        return { dispose: Effect.void, events: { emit: () => Effect.void } };
      });
    return context;
  });

  let fibers: ReturnType<typeof Effect.runFork>[] = [];
  try {
    fibers = contexts.map((context) =>
      Effect.runFork(
        Effect.scoped(
          Effect.gen(function* () {
            yield* plugin.effect(context);
            yield* Effect.never;
          }),
        ),
      ),
    );
    await allRegistered;
    for (const fiber of fibers.slice(0, -1)) {
      await Effect.runPromise(Fiber.interrupt(fiber));
      await Effect.runPromise(Fiber.await(fiber));
    }
    // Each plugin scope owns a separate child; interrupting one scope must not
    // stop the shared process.
    assert.equal(fixture.stops.length, 0);
    await Effect.runPromise(Fiber.interrupt(fibers.at(-1)!));
    await Effect.runPromise(Fiber.await(fibers.at(-1)!));
    assert.equal(fixture.stops.length, 1);
  } finally {
    for (const fiber of fibers) await Effect.runPromise(Fiber.interrupt(fiber));
    assert.equal(fixture.stops.length, fixture.spawns.length);
    for (const directory of fixture.certDirectories) assert.equal(existsSync(directory), false);
    await rm(root, { recursive: true, force: true });
  }
});

test("plugin initialization does not block host startup on a pending broker", async () => {
  const root = await mkdtemp(join(tmpdir(), "key-ferry-global-broker-blocked-"));
  const project = join(root, "project");
  mkdirSync(project, { recursive: true });
  const canonicalProject = await realpath(project);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const fixture = fakeProcess(canonicalProject, "blocked", gate);
  const plugin = makePlugin({ layer: () => managerLayer(fixture, canonicalProject) });
  const location = await mkdtemp(join(root, "host-"));
  const protectedContext = protectedPluginContext(location, canonicalProject);

  try {
    // Initialization runs in the background: the host receives control while
    // the local MCP remains fail-closed.
    await Effect.runPromise(
      Effect.scoped(plugin.effect(protectedContext.context)).pipe(Effect.timeout("1 second")),
    );
    assert.equal(protectedContext.values.get("selected")?.disabled, true);
    assert.equal(protectedContext.values.get("nativeOAuth")?.disabled, undefined);
  } finally {
    release();
    assert.equal(fixture.stops.length, 0);
    await rm(root, { recursive: true, force: true });
  }
});

test("shared refresh gates every local context until the new generation is ready", async () => {
  const root = await mkdtemp(join(tmpdir(), "key-ferry-global-broker-refresh-"));
  const project = join(root, "project");
  mkdirSync(project, { recursive: true });
  const canonicalProject = await realpath(project);
  let releaseRefresh!: () => void;
  const refreshGate = new Promise<void>((resolve) => (releaseRefresh = resolve));
  const fixture = fakeProcess(canonicalProject, "ready", undefined, refreshGate);
  const factory = { layer: () => managerLayer(fixture, canonicalProject) };
  const plugin = makePlugin(factory);
  const locations = await Promise.all(
    ["a", "b"].map((name) => mkdtemp(join(root, `host-${name}-`))),
  );
  const contexts = locations.map((location) => protectedPluginContext(location, canonicalProject));
  const refreshHandlers: Array<(input: {}, context: { error: Function }) => unknown> = [];
  const doctorHandlers: Array<(input: {}, context: { error: Function }) => unknown> = [];
  for (const { context } of contexts) {
    context.rpc.register = (
      _definition: unknown,
      handlers: {
        refresh: (typeof refreshHandlers)[number];
        doctor: (typeof refreshHandlers)[number];
      },
    ) =>
      Effect.sync(() => {
        refreshHandlers.push(handlers.refresh);
        doctorHandlers.push(handlers.doctor);
        return { dispose: Effect.void, events: { emit: () => Effect.void } };
      });
  }
  let fibers: ReturnType<typeof Effect.runFork>[] = [];
  try {
    fibers = await runPluginContexts(
      plugin,
      contexts.map(({ context }) => context),
    );
    await waitFor(() => refreshHandlers.length === 2);
    for (const doctor of doctorHandlers)
      await Effect.runPromise(
        doctor({}, { error: (code, data) => ({ code, data }) }) as Effect.Effect<unknown>,
      );
    await waitFor(() => contexts.every(({ values }) => values.get("selected")?.disabled === false));
    const refreshFiber = Effect.runFork(
      refreshHandlers[0]!(
        {},
        { error: (code, data) => ({ code, data }) },
      ) as Effect.Effect<unknown>,
    );
    await waitFor(() => contexts.every(({ values }) => values.get("selected")?.disabled === true));
    for (const { values } of contexts) {
      assert.equal(values.get("nativeOAuth")?.disabled, undefined);
    }
    releaseRefresh();
    await Effect.runPromise(Fiber.await(refreshFiber));
    await waitFor(() => contexts.every(({ values }) => values.get("selected")?.disabled === false));
    assert.equal(fixture.runs.filter((run) => run.operation === "other").length, 1);
  } finally {
    releaseRefresh();
    for (const fiber of fibers) await Effect.runPromise(Fiber.interrupt(fiber));
    assert.equal(fixture.stops.length, fixture.spawns.length);
    await rm(root, { recursive: true, force: true });
  }
});
