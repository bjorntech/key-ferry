import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { Effect, Fiber, Layer } from "effect";
import { makeBrokerRegistry } from "../src/broker-registry.js";
import {
  ProjectKeyFerryManager,
  projectDirectory,
  type ProjectKeyFerryManagerFactory,
  type ProjectKeyFerryManagerService,
} from "../src/contracts.js";
import { makePlugin } from "../src/plugin.js";
import {
  RELAY_AUTH_HEADER,
  type RemoteRelayConfig,
  type RemoteRelayHandle,
} from "../src/remote.js";

type ManagerState = {
  readonly root: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly gate?: Promise<void>;
  ready: boolean;
  starts: number;
  stops: number;
  generation: number;
};

type NativeDraft = Record<string, any>;

type NativeState = {
  readonly pristine: Record<string, NativeDraft>;
  readonly applied: Map<string, NativeDraft>;
  readonly clients: Map<string, NativeDraft>;
  readonly replacements: Map<string, number>;
  readonly outsideFrameErrors: string[];
  readonly reloads: { count: number };
  callback?: (editor: NativeEditor) => void;
};

type NativeEditor = {
  list(): readonly [string, NativeDraft][];
  get(name: string): NativeDraft | undefined;
  update(name: string, update: (config: NativeDraft) => void): void;
};

const clone = <T>(value: T): T => structuredClone(value);

function nativeContext(
  location: string,
  options: Record<string, unknown>,
  initial: Record<string, NativeDraft>,
  native: NativeState,
) {
  let current = clone(initial);
  const editor = (): NativeEditor => ({
    list: () => Object.entries(current),
    get: (name) => current[name],
    update: (name, update) => {
      const value = current[name];
      if (!value) return;
      try {
        update(value);
      } catch (error) {
        native.outsideFrameErrors.push(String(error));
        throw error;
      }
    },
  });
  const applyCallback = (callback: (editor: NativeEditor) => void) => {
    current = clone(native.pristine);
    callback(editor());
    for (const [name, draft] of Object.entries(current)) {
      const previous = native.applied.get(name);
      if (!previous || !isDeepStrictEqual(previous, draft)) {
        native.applied.set(name, clone(draft));
        native.clients.set(name, clone(draft));
        native.replacements.set(name, (native.replacements.get(name) ?? 0) + 1);
      }
    }
  };
  const context = {
    options,
    location: { project: { directory: location } },
    mcp: {
      transform: (callback: (value: NativeEditor) => void) =>
        Effect.sync(() => {
          native.callback = callback;
          applyCallback(callback);
        }),
      reload: () =>
        Effect.sync(() => {
          native.reloads.count += 1;
          const old = native.applied.get("target");
          if (old) {
            expect(old).toEqual(native.applied.get("target"));
            expect(old.disabled).toBe(true);
          }
          if (!native.callback) throw new Error("native callback was not registered");
          applyCallback(native.callback);
        }),
    },
    rpc: {
      register: (_definition: unknown, value: unknown) =>
        Effect.sync(() => ({ dispose: Effect.void, events: { emit: () => Effect.void }, value })),
    },
  };
  return { context, native };
}

function manager(state: ManagerState): ProjectKeyFerryManagerService {
  const status = () => ({
    phase: state.ready ? ("ready" as const) : ("starting" as const),
    projectDirectory: projectDirectory(state.root),
    generation: state.generation,
  });
  const ensureReady = Effect.promise(async () => {
    state.starts += 1;
    if (state.gate) await state.gate;
    state.ready = true;
    state.generation = 1;
    return { status: status(), environment: state.environment };
  });
  return {
    status: Effect.sync(status),
    ensureStarted: ensureReady.pipe(Effect.map(({ status: value }) => value)),
    ensureReady,
    environment: Effect.succeed(state.environment),
    refresh: Effect.sync(status),
    refreshReady: ensureReady,
    dispose: Effect.sync(() => {
      state.stops += 1;
      state.ready = false;
    }),
    withExclusive: (effect) => effect,
  };
}

const factoryFor = (state: ManagerState): ProjectKeyFerryManagerFactory => ({
  layer: (options) => Layer.succeed(ProjectKeyFerryManager, manager(state)),
});

const run = (plugin: ReturnType<typeof makePlugin>, context: unknown) =>
  Effect.runFork(
    Effect.scoped(
      Effect.gen(function* () {
        yield* plugin.effect(context as never);
        yield* Effect.never;
      }),
    ),
  );

const waitFor = async (predicate: () => boolean) => {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error("native draft fixture did not reach expected state");
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
};

describe("native OpenCode draft reconciliation", () => {
  test("replays a fresh local draft after asynchronous readiness", async () => {
    const root = await mkdtemp(join(tmpdir(), "key-ferry-native-local-"));
    await mkdir(join(root, ".opencode"), { recursive: true });
    await writeFile(
      join(root, ".opencode/key-ferry.jsonc"),
      JSON.stringify({
        enabled: true,
        activation: "auto",
        servers: { target: { env: ["OUTPUT_TOKEN"] } },
      }),
    );
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => (openGate = resolve));
    const managerState: ManagerState = {
      root,
      gate,
      environment: { OUTPUT_TOKEN: "OUTPUT_TOKEN_FAKE" },
      ready: false,
      starts: 0,
      stops: 0,
      generation: 0,
    };
    const native: NativeState = {
      pristine: {
        target: {
          type: "local",
          command: ["native-target"],
          disabled: false,
          environment: { USER_FLAG: "preserve-me" },
        },
      },
      applied: new Map(),
      clients: new Map(),
      replacements: new Map(),
      outsideFrameErrors: [],
      reloads: { count: 0 },
    };
    const scope = nativeContext(
      root,
      { projectConfig: { enabled: true, activation: "auto" }, command: ["fake-manager"] },
      native.pristine,
      native,
    );
    const plugin = makePlugin(
      factoryFor(managerState),
      undefined,
      makeBrokerRegistry({ canonicalize: (path) => Effect.succeed(path) }),
    );
    const fiber = run(plugin, scope.context);
    try {
      await waitFor(() => native.applied.has("target") && managerState.starts === 1);
      const first = native.applied.get("target")!;
      expect(first.disabled).toBe(true);
      expect(first.environment).toEqual({ USER_FLAG: "preserve-me" });
      openGate();
      await waitFor(() => native.clients.get("target")?.disabled === false);
      expect(native.clients.get("target")?.environment).toEqual({
        USER_FLAG: "preserve-me",
        OUTPUT_TOKEN: "OUTPUT_TOKEN_FAKE",
      });
      expect(native.replacements.get("target")).toBe(2);
      expect(first).toEqual({
        type: "local",
        command: ["native-target"],
        disabled: true,
        environment: { USER_FLAG: "preserve-me" },
      });
      expect(native.outsideFrameErrors).toEqual([]);
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber));
      expect(managerState.stops).toBe(1);
      await rm(root, { recursive: true, force: true });
    }
  });

  test("keeps the real remote source unchanged until relay readiness replay", async () => {
    const root = await mkdtemp(join(tmpdir(), "key-ferry-native-remote-"));
    await mkdir(join(root, ".opencode"), { recursive: true });
    const caPath = join(root, "fake-ca.pem");
    await writeFile(caPath, "-----BEGIN CERTIFICATE-----\nFAKE\n-----END CERTIFICATE-----\n");
    await writeFile(
      join(root, ".opencode/key-ferry.jsonc"),
      JSON.stringify({
        enabled: true,
        activation: "auto",
        servers: { target: { remote: { headers: { "X-MCP-Access-Key": "REMOTE_TOKEN" } } } },
      }),
    );
    let openGate!: () => void;
    const state: ManagerState = {
      root,
      gate: new Promise<void>((resolve) => (openGate = resolve)),
      environment: {
        REMOTE_TOKEN: "REMOTE_TOKEN_FAKE",
        HTTPS_PROXY: "http://127.0.0.1:4999",
        NODE_EXTRA_CA_CERTS: caPath,
      },
      ready: false,
      starts: 0,
      stops: 0,
      generation: 0,
    };
    const native: NativeState = {
      pristine: {
        target: {
          type: "remote",
          url: "https://api.example.invalid/mcp",
          oauth: false,
          disabled: false,
          headers: { "X-Native": "preserve-me" },
        },
      },
      applied: new Map(),
      clients: new Map(),
      replacements: new Map(),
      outsideFrameErrors: [],
      reloads: { count: 0 },
    };
    const scope = nativeContext(
      root,
      { projectConfig: { enabled: true, activation: "auto" }, command: ["fake-manager"] },
      native.pristine,
      native,
    );
    const relays: RemoteRelayConfig[] = [];
    const relayStops: number[] = [];
    const relayFactory = (config: RemoteRelayConfig) =>
      Effect.sync(() => {
        relays.push(config);
        const index = relayStops.push(0) - 1;
        const localUrl = `http://127.0.0.1:${4800 + relays.length}`;
        const handle: RemoteRelayHandle = {
          localUrl,
          downstreamToken: "RELAY_TOKEN_FAKE",
          health: Effect.succeed({ listening: true, activeRequests: 0, localUrl }),
          stop: Effect.sync(() => {
            relayStops[index] += 1;
          }),
        };
        return handle;
      });
    const plugin = makePlugin(
      factoryFor(state),
      relayFactory,
      makeBrokerRegistry({ canonicalize: (path) => Effect.succeed(path) }),
    );
    const fiber = run(plugin, scope.context);
    try {
      await waitFor(() => native.applied.has("target"));
      expect(native.applied.get("target")).toEqual({
        ...native.pristine.target,
        disabled: true,
      });
      openGate();
      await waitFor(() => native.clients.get("target")?.url === "http://127.0.0.1:4801");
      expect(native.clients.get("target")?.headers).toEqual({
        "X-Native": "preserve-me",
        [RELAY_AUTH_HEADER]: "RELAY_TOKEN_FAKE",
      });
      expect(native.applied.get("target")?.url).toBe("http://127.0.0.1:4801");
      expect(relays[0]?.upstreamUrl).toBe("https://api.example.invalid/mcp");
      expect(relays[0]?.placeholderHeaders).toEqual({ "X-MCP-Access-Key": "REMOTE_TOKEN_FAKE" });
      expect(native.replacements.get("target")).toBe(2);
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber));
      await rm(root, { recursive: true, force: true });
    }
  });
});
