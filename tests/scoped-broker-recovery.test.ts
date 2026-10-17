import { describe, expect, test } from "bun:test";
import { Effect, PubSub, Scope, Stream } from "effect";
import type { BrokerLease, BrokerRegistry, BrokerSubscription } from "../src/broker-registry.js";
import {
  projectDirectory,
  type ProjectKeyFerryManagerFactory,
  type ResolvedEnvironment,
  type SafeStatus,
  VarlockError,
} from "../src/contracts.js";
import { loadScopedConfiguration } from "../src/scoped-config.js";
import { makeScopedController } from "../src/scoped-controller.js";

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function editorFor(entries: Record<string, any>) {
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
}

function fakeBroker(
  root: string,
  counters: { acquire: number; refresh: number; retry: number },
): {
  registry: BrokerRegistry;
  emitReady: (environment: ResolvedEnvironment, generation: number) => Promise<void>;
} {
  const events = Effect.runSync(PubSub.unbounded<SafeStatus>({ replay: 1 }));
  const initial: SafeStatus = {
    phase: "ready",
    projectDirectory: projectDirectory(root),
    generation: 1,
  };
  let status = initial;
  let environment: ResolvedEnvironment = { TOKEN: "old-marker" };
  let released = false;

  const failure = new VarlockError({
    code: "refresh_failed",
    message: "controlled refresh failure",
    retryable: true,
  });
  const readyResult = () => ({ status, environment });
  const subscription: BrokerSubscription = {
    current: Effect.sync(() => status),
    changes: Stream.fromPubSub(events),
  };
  const lease: BrokerLease = {
    status: Effect.sync(() => status),
    ensureStarted: Effect.succeed(status),
    ensureReady: Effect.sync(readyResult),
    environment: Effect.sync(() => environment),
    refresh: Effect.fail(failure),
    refreshReady: Effect.gen(function* () {
      counters.refresh++;
      status = { ...status, phase: "starting" };
      yield* PubSub.publish(events, status);
      status = { ...status, phase: "failed", error: failure };
      yield* PubSub.publish(events, status);
      return yield* Effect.fail(failure);
    }),
    dispose: Effect.sync(() => {
      released = true;
    }),
    withExclusive: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
    subscribe: Effect.succeed(subscription),
    release: Effect.sync(() => {
      released = true;
    }),
  };
  const registry: BrokerRegistry = {
    acquire: () =>
      Effect.sync(() => {
        counters.acquire++;
        return lease;
      }),
    retry: () =>
      Effect.sync(() => {
        counters.retry++;
        return readyResult();
      }),
  };

  return {
    registry,
    emitReady: async (nextEnvironment, generation) => {
      if (released) throw new Error("fake broker was released");
      environment = nextEnvironment;
      status = { phase: "ready", projectDirectory: projectDirectory(root), generation };
      await Effect.runPromise(PubSub.publish(events, status));
    },
  };
}

describe("scoped controller broker event recovery contract", () => {
  test("re-enables local MCP protection when a later broker Ready event arrives", async () => {
    const root = `/tmp/key-ferry-fake-broker-${Date.now()}`;
    const configuration = await loadScopedConfiguration(
      { projectConfig: { enabled: false }, servers: { local: { env: ["TOKEN"] } } },
      { project: { directory: root } },
      { readFile: async () => "{}", realpath: async (path) => path },
    );
    const editor = editorFor({
      local: { type: "local", command: ["local"], environment: { NATIVE: "kept" } },
    });
    const counters = { acquire: 0, refresh: 0, retry: 0 };
    const fake = fakeBroker(root, counters);
    const scope = Effect.runSync(Scope.make());
    const factory: ProjectKeyFerryManagerFactory = {
      layer: () => {
        throw new Error("the controlled broker supplies the lease; factory must not be used");
      },
    };
    const controller = makeScopedController({
      configuration,
      factory,
      registry: fake.registry,
      scope,
      reload: () => Effect.void,
      editor: editor.editor,
      startEmptyGlobal: true,
    });
    controller.capture(editor.editor);
    controller.apply(editor.editor);

    try {
      await Effect.runPromise(controller.start);
      await flush();
      expect(editor.values.get("local")).toMatchObject({ disabled: false });

      await expect(
        Effect.runPromise(controller.operation("refresh", { scope: "global" })),
      ).rejects.toThrow("controlled refresh failure");
      expect(controller.runtimes.get("global")?.transitioning).toBe(false);
      expect(editor.values.get("local")).toMatchObject({ disabled: true });
      expect(counters).toEqual({ acquire: 1, refresh: 1, retry: 0 });

      // Contract test: a real registry only emits this after an explicit retry;
      // this fake deliberately supplies the later notification without claiming
      // automatic runtime re-authentication or recovery.
      await fake.emitReady({ TOKEN: "new-ready-marker" }, 2);
      await flush();
      expect((await Effect.runPromise(controller.status)).phase).toBe("ready");
      expect(editor.values.get("local")).toMatchObject({
        disabled: false,
        environment: { NATIVE: "kept", TOKEN: "new-ready-marker" },
      });
      expect(editor.values.get("local")?.environment?.TOKEN).not.toBe("old-marker");
      expect(counters).toEqual({ acquire: 1, refresh: 1, retry: 0 });
    } finally {
      await Effect.runPromise(controller.dispose);
      await Scope.close(scope, { _tag: "Success", value: undefined } as never);
    }
  });
});
