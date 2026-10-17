import { describe, expect, test } from "bun:test";
import type { Mcp } from "@opencode/plugin/effect";
import { Effect, Fiber, Layer } from "effect";
import { makeBrokerRegistry } from "../src/broker-registry.js";
import { ProjectKeyFerryManager, projectDirectory } from "../src/contracts.js";
import type { ProjectKeyFerryManagerFactory } from "../src/contracts.js";
import { makePlugin } from "../src/plugin.js";

const waitFor = async (check: () => boolean) => {
  const deadline = Date.now() + 1_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("deferred plugin fixture timed out");
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
};

function fixture() {
  const values = new Map<string, Mcp.ServerConfig>([
    ["service", { type: "local", command: ["fake"], disabled: false }],
  ]);
  const editor = {
    list: () => [...values.entries()],
    get: (name: string) => values.get(name),
    update: (name: string, update: (config: any) => void) => {
      const config = values.get(name);
      if (config) update(config);
    },
  };
  let transform: ((next: typeof editor) => void) | undefined;
  let registered = 0;
  let starts = 0;
  const factory: ProjectKeyFerryManagerFactory = {
    layer: () =>
      Layer.succeed(ProjectKeyFerryManager, {
        status: Effect.sync(() => ({
          phase: "ready" as const,
          projectDirectory: projectDirectory("/project"),
          generation: 1,
        })),
        ensureStarted: Effect.sync(() => ({
          phase: "ready" as const,
          projectDirectory: projectDirectory("/project"),
          generation: 1,
        })),
        ensureReady: Effect.sync(() => {
          starts += 1;
          return {
            status: {
              phase: "ready" as const,
              projectDirectory: projectDirectory("/project"),
              generation: 1,
            },
            environment: { API_KEY: "fixture-only" },
          };
        }),
        environment: Effect.succeed({ API_KEY: "fixture-only" }),
        refresh: Effect.succeed({
          phase: "ready" as const,
          projectDirectory: projectDirectory("/project"),
          generation: 1,
        }),
        refreshReady: Effect.succeed({
          status: {
            phase: "ready" as const,
            projectDirectory: projectDirectory("/project"),
            generation: 1,
          },
          environment: { API_KEY: "fixture-only" },
        }),
        dispose: Effect.void,
        withExclusive: (effect) => effect,
      }),
  };
  const context = {
    options: {
      projectDirectory: "/project",
      projectConfig: { enabled: false },
      command: ["fake-manager"],
      servers: { service: { env: ["API_KEY"] } },
    },
    location: { project: { directory: "/project" } },
    mcp: {
      transform: (callback: typeof transform) =>
        Effect.sync(() => {
          transform = callback;
        }),
      reload: () => Effect.sync(() => undefined),
    },
    rpc: {
      register: () =>
        Effect.sync(() => {
          registered += 1;
          return { dispose: Effect.void, events: { emit: () => Effect.void } };
        }),
    },
  } as never;
  return {
    context,
    factory,
    editor,
    invoke: () => transform?.(editor),
    get starts() {
      return starts;
    },
    get registered() {
      return registered;
    },
  };
}

describe("deferred native MCP transform bootstrap", () => {
  test("returns before callback, then starts and registers exactly once", async () => {
    const testFixture = fixture();
    const plugin = makePlugin(
      testFixture.factory,
      undefined,
      makeBrokerRegistry({ canonicalize: (path) => Effect.succeed(path) }),
    );
    const fiber = Effect.runFork(
      Effect.scoped(
        Effect.gen(function* () {
          yield* plugin.effect(testFixture.context);
          expect(testFixture.starts).toBe(0);
          expect(testFixture.registered).toBe(0);
          yield* Effect.never;
        }),
      ),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    testFixture.invoke();
    await waitFor(() => testFixture.starts === 1 && testFixture.registered === 1);
    testFixture.invoke();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(testFixture.starts).toBe(1);
    expect(testFixture.registered).toBe(1);
    await Effect.runPromise(Fiber.interrupt(fiber));
  });

  test("closing before callback does not bootstrap later", async () => {
    const testFixture = fixture();
    const plugin = makePlugin(
      testFixture.factory,
      undefined,
      makeBrokerRegistry({ canonicalize: (path) => Effect.succeed(path) }),
    );
    const fiber = Effect.runFork(Effect.scoped(plugin.effect(testFixture.context)));
    await new Promise<void>((resolve) => setImmediate(resolve));
    await Effect.runPromise(Fiber.interrupt(fiber));
    testFixture.invoke();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(testFixture.starts).toBe(0);
    expect(testFixture.registered).toBe(0);
  });
});
