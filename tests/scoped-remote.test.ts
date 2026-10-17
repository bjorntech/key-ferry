import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Fiber, Layer } from "effect";
import { makeBrokerRegistry } from "../src/broker-registry.js";
import {
  ProjectKeyFerryManager,
  projectDirectory,
  type ProjectKeyFerryManagerFactory,
  type ProjectKeyFerryManagerService,
  type SafeStatus,
} from "../src/contracts.js";
import { makePlugin } from "../src/plugin.js";
import {
  RELAY_AUTH_HEADER,
  type RemoteRelayConfig,
  type RemoteRelayHandle,
} from "../src/remote.js";

type State = {
  readonly root: string;
  environment: Readonly<Record<string, string>>;
  readonly refreshApiKey?: string;
  starts: number;
  refreshes: number;
  stops: number;
  generation: number;
  ready: boolean;
};

type Scope = {
  readonly values: Map<string, any>;
  readonly handlers: { current?: Record<string, any> };
  readonly context: unknown;
};

const waitFor = async (predicate: () => boolean) => {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error("remote scoped fixture did not reach expected state");
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
};

const status = (state: State): SafeStatus => ({
  phase: state.ready ? "ready" : "starting",
  projectDirectory: projectDirectory(state.root),
  generation: state.generation,
});

const manager = (state: State): ProjectKeyFerryManagerService => {
  const ensureReady = Effect.sync(() => {
    state.starts += 1;
    state.ready = true;
    state.generation = 1;
    return { status: status(state), environment: state.environment };
  });
  return {
    status: Effect.sync(() => status(state)),
    ensureStarted: ensureReady.pipe(Effect.map(({ status: value }) => value)),
    ensureReady,
    environment: Effect.sync(() => state.environment),
    refresh: Effect.sync(() => {
      state.refreshes += 1;
      state.generation += 1;
      return status(state);
    }),
    refreshReady: Effect.sync(() => {
      state.refreshes += 1;
      state.generation += 1;
      if (state.refreshApiKey)
        state.environment = { ...state.environment, API_KEY: state.refreshApiKey };
      return { status: status(state), environment: state.environment };
    }),
    dispose: Effect.sync(() => {
      state.stops += 1;
      state.ready = false;
    }),
    withExclusive: (effect) => effect,
  };
};

const factoryFor = (states: Map<string, State>): ProjectKeyFerryManagerFactory => ({
  layer: (options) => {
    const state = states.get(String(options.projectDirectory));
    if (!state) throw new Error(`unexpected manager root ${String(options.projectDirectory)}`);
    return Layer.succeed(ProjectKeyFerryManager, manager(state));
  },
});

const scopeContext = (
  location: string,
  options: Record<string, unknown>,
  servers: Record<string, any>,
): Scope => {
  const values = new Map(Object.entries(servers));
  const handlers: { current?: Record<string, any> } = {};
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
      transform: (callback: (value: typeof editor) => void) => Effect.sync(() => callback(editor)),
      reload: () => Effect.void,
    },
    rpc: {
      register: (_definition: unknown, value: unknown) =>
        Effect.sync(() => {
          handlers.current = value as Record<string, any>;
          return { dispose: Effect.void, events: { emit: () => Effect.void } };
        }),
    },
  };
  return { values, handlers, context };
};

const run = (plugin: ReturnType<typeof makePlugin>, scope: Scope) =>
  Effect.runFork(
    Effect.scoped(
      Effect.gen(function* () {
        yield* plugin.effect(scope.context as never);
        yield* Effect.never;
      }),
    ),
  );

const projectSource = () =>
  `{"enabled":true,"activation":"auto","servers":{"project-remote":{"remote":{"headers":{"X-Api-Key":"API_KEY"}}}}}`;

test("public scoped RPC refresh keeps remote relays and placeholders isolated", async () => {
  const root = await mkdtemp(join(tmpdir(), "key-ferry-scoped-remote-"));
  const globalRoot = await realpath(join(root, "global")).catch(async () => {
    await mkdir(join(root, "global"), { recursive: true });
    return realpath(join(root, "global"));
  });
  const projectRoot = await realpath(join(root, "project")).catch(async () => {
    await mkdir(join(root, "project", ".opencode"), { recursive: true });
    return realpath(join(root, "project"));
  });
  const caGlobal = join(globalRoot, "global-ca.pem");
  const caProject = join(projectRoot, "project-ca.pem");
  await writeFile(caGlobal, "-----BEGIN CERTIFICATE-----\nGLOBAL\n-----END CERTIFICATE-----\n");
  await writeFile(caProject, "-----BEGIN CERTIFICATE-----\nPROJECT\n-----END CERTIFICATE-----\n");
  await writeFile(join(projectRoot, ".opencode/key-ferry.jsonc"), projectSource());

  const global: State = {
    root: globalRoot,
    environment: {
      API_KEY: "GLOBAL_MASK",
      HTTPS_PROXY: "https://proxy.example.invalid/global",
      NODE_EXTRA_CA_CERTS: caGlobal,
    },
    starts: 0,
    refreshes: 0,
    stops: 0,
    generation: 0,
    ready: false,
  };
  const project: State = {
    root: projectRoot,
    environment: {
      API_KEY: "PROJECT_MASK",
      HTTPS_PROXY: "https://proxy.example.invalid/project",
      NODE_EXTRA_CA_CERTS: caProject,
    },
    starts: 0,
    refreshes: 0,
    stops: 0,
    generation: 0,
    ready: false,
    refreshApiKey: "PROJECT_MASK_2",
  };
  const relays: Array<{ config: RemoteRelayConfig; token: string; stops: number }> = [];
  const relayFactory = (config: RemoteRelayConfig) =>
    Effect.sync(() => {
      const record = { config, token: `FAKE_DOWNSTREAM_${relays.length + 1}`, stops: 0 };
      relays.push(record);
      const localUrl = `http://127.0.0.1:${4700 + relays.length}`;
      const handle: RemoteRelayHandle = {
        localUrl,
        downstreamToken: record.token,
        health: Effect.succeed({ listening: true, activeRequests: 0, localUrl }),
        stop: Effect.sync(() => {
          record.stops += 1;
        }),
      };
      return handle;
    });
  const options = {
    projectDirectory: globalRoot,
    projectConfig: { enabled: true, activation: "auto" },
    command: ["fake-manager"],
    servers: {
      "global-remote": {
        remote: { headers: { Authorization: { env: "API_KEY", prefix: "Bearer " } } },
      },
    },
  };
  const scope = scopeContext(projectRoot, options, {
    "global-remote": {
      type: "remote",
      url: "https://api.example.invalid/global/mcp",
      oauth: false,
      headers: { "X-Native": "GLOBAL_NATIVE" },
    },
    "project-remote": {
      type: "remote",
      url: "https://api.example.invalid/project/mcp",
      oauth: false,
      headers: { "X-Native": "PROJECT_NATIVE" },
    },
  });
  const plugin = makePlugin(
    factoryFor(
      new Map([
        [globalRoot, global],
        [projectRoot, project],
      ]),
    ),
    relayFactory,
    makeBrokerRegistry({ canonicalize: (path) => Effect.succeed(path) }),
  );
  const fiber = run(plugin, scope);
  try {
    await waitFor(() => global.ready && project.ready && relays.length === 2);
    const globalRelay = relays.find((item) => item.config.upstreamUrl.endsWith("/global/mcp"))!;
    const projectRelay = relays.find((item) => item.config.upstreamUrl.endsWith("/project/mcp"))!;
    expect(globalRelay.config.placeholderHeaders).toEqual({ Authorization: "Bearer GLOBAL_MASK" });
    expect(projectRelay.config.placeholderHeaders).toEqual({ "X-Api-Key": "PROJECT_MASK" });
    expect(globalRelay.config.proxyUrl).toBe(global.environment.HTTPS_PROXY);
    expect(projectRelay.config.proxyUrl).toBe(project.environment.HTTPS_PROXY);
    expect(globalRelay.config.managerCaPem).toContain("GLOBAL");
    expect(projectRelay.config.managerCaPem).toContain("PROJECT");
    expect(scope.values.get("global-remote")?.url).toMatch(/^http:\/\/127\.0\.0\.1:/);
    expect(scope.values.get("global-remote")?.headers?.[RELAY_AUTH_HEADER]).toBe(globalRelay.token);
    expect(scope.values.get("project-remote")?.headers?.[RELAY_AUTH_HEADER]).toBe(
      projectRelay.token,
    );
    expect(globalRelay.token).not.toBe(projectRelay.token);
    expect(scope.values.get("project-remote")?.headers?.["X-Native"]).toBe("PROJECT_NATIVE");

    const globalStarts = global.starts;
    const globalRelayStops = globalRelay.stops;
    await Effect.runPromise(
      scope.handlers.current!.refresh(
        { scope: "project" },
        { error: (code: string, data: unknown) => ({ code, data }) },
      ),
    );
    await waitFor(() => relays.length === 3 && project.refreshes === 1);
    const refreshedProject = relays[2]!;
    expect(refreshedProject.config.upstreamUrl).toBe("https://api.example.invalid/project/mcp");
    expect(refreshedProject.config.placeholderHeaders).toEqual({ "X-Api-Key": "PROJECT_MASK_2" });
    expect(projectRelay.stops).toBe(1);
    expect(global.starts).toBe(globalStarts);
    expect(globalRelay.stops).toBe(globalRelayStops);
    expect(scope.values.get("global-remote")?.headers?.[RELAY_AUTH_HEADER]).toBe(globalRelay.token);
    expect(scope.values.get("project-remote")?.headers?.[RELAY_AUTH_HEADER]).toBe(
      refreshedProject.token,
    );
    const selected = await Effect.runPromise(scope.handlers.current!.status({ scope: "project" }));
    expect(selected.scopes?.[0]).toMatchObject({ scope: "project", phase: "ready", generation: 2 });
  } finally {
    await Effect.runPromise(Fiber.interrupt(fiber));
    await waitFor(() => global.stops === 1 && project.stops === 1);
    expect(relays.filter((item) => item.stops === 1)).toHaveLength(3);
    await rm(root, { recursive: true, force: true });
  }
});
