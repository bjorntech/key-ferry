import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Deferred, Effect, Fiber, Layer } from "effect";
import { makeBrokerRegistry } from "../src/broker-registry.js";
import { ProjectKeyFerryManager } from "../src/contracts.js";
import { parseOptions } from "../src/options.js";
import { applyProtection } from "../src/plugin.js";
import {
  makeRemoteRelayCoordinator,
  RELAY_AUTH_HEADER,
  type RemoteRelayConfig,
  type RemoteRelayHandle,
} from "../src/remote.js";

const ca = join(mkdtempSync(join(tmpdir(), "key-ferry-stale-relay-")), "ca.pem");
writeFileSync(ca, "-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----\n");

test("rebuilds a relay when proxy/session wiring changes at the same generation", async () => {
  const started: RemoteRelayConfig[] = [];
  const stopped: string[] = [];
  const factory = (config: RemoteRelayConfig) => {
    started.push(config);
    const token = `relay-${started.length}`;
    const handle: RemoteRelayHandle = {
      localUrl: `http://127.0.0.1:${4000 + started.length}`,
      downstreamToken: token,
      health: Effect.succeed({ listening: true, activeRequests: 0, localUrl: "local" }),
      stop: Effect.sync(() => void stopped.push(token)),
    };
    return Effect.succeed(handle);
  };
  const options = parseOptions(
    { servers: { remote: { remote: { headers: { Authorization: "TOKEN" } } } } },
    "/project",
  );
  const coordinator = makeRemoteRelayCoordinator(factory, true);
  const server = new Map([
    ["remote", { type: "remote" as const, url: "https://127.0.0.1/mcp", oauth: false as const }],
  ]);
  const base = { HTTPS_PROXY: "http://127.0.0.1:4100", NODE_EXTRA_CA_CERTS: ca, TOKEN: "secret" };
  await Effect.runPromise(
    Effect.scoped(coordinator.reconcile(server, options.adapter.servers, base, 7, "session-a")),
  );
  await Effect.runPromise(
    Effect.scoped(
      coordinator.reconcile(
        server,
        options.adapter.servers,
        { ...base, HTTPS_PROXY: "http://127.0.0.1:4200" },
        7,
        "session-b",
      ),
    ),
  );
  expect(started).toHaveLength(2);
  expect(stopped).toEqual(["relay-1"]);
  expect(started[1]?.binding?.brokerSessionId).toBe("session-b");
  expect(started[1]?.binding?.proxyPort).toBe(4200);
  expect(started[1]?.binding?.tokenFingerprint).not.toContain("secret");
});

test("idle expiry removes the relay and a new acquire rebuilds it", async () => {
  const started: RemoteRelayConfig[] = [];
  const stopped: string[] = [];
  const coordinator = makeRemoteRelayCoordinator((config) => {
    started.push(config);
    const token = `idle-${started.length}`;
    return Effect.succeed<RemoteRelayHandle>({
      localUrl: `http://127.0.0.1:${4500 + started.length}`,
      downstreamToken: token,
      health: Effect.succeed({ listening: true, activeRequests: 0, localUrl: "local" }),
      stop: Effect.sync(() => void stopped.push(token)),
    });
  }, true);
  const options = parseOptions(
    { servers: { remote: { remote: { headers: { Authorization: "TOKEN" } } } } },
    "/project",
  );
  const server = new Map([
    ["remote", { type: "remote" as const, url: "https://127.0.0.1/mcp", oauth: false as const }],
  ]);
  const environment = {
    HTTPS_PROXY: "http://127.0.0.1:4300",
    NODE_EXTRA_CA_CERTS: ca,
    TOKEN: "secret",
  };
  await Effect.runPromise(
    Effect.scoped(coordinator.reconcile(server, options.adapter.servers, environment, 1, "one")),
  );
  await Effect.runPromise(
    Effect.scoped(coordinator.reconcile(new Map(), options.adapter.servers, environment, 1, "one")),
  );
  expect(coordinator.handles.size).toBe(0);
  await Effect.runPromise(
    Effect.scoped(coordinator.reconcile(server, options.adapter.servers, environment, 1, "two")),
  );
  expect(started).toHaveLength(2);
  expect(stopped).toEqual(["idle-1"]);
  expect(started[1]?.binding?.brokerSessionId).toBe("two");
});

test("reacquire waits for in-flight disposal before starting a replacement", async () => {
  const releaseDisposal = await Effect.runPromise(Deferred.make<void>());
  const events: string[] = [];
  let starts = 0;
  const directory = "/tmp/key-ferry-in-flight-disposal";
  const factory = {
    layer: () => {
      starts++;
      events.push(`start-${starts}`);
      const status = {
        phase: "ready" as const,
        projectDirectory: directory as any,
        generation: starts,
      };
      return Layer.succeed(ProjectKeyFerryManager, {
        status: Effect.succeed(status),
        ensureStarted: Effect.succeed(status),
        ensureReady: Effect.succeed({ status, environment: {} }),
        environment: Effect.succeed({}),
        refresh: Effect.succeed(status),
        refreshReady: Effect.succeed({ status, environment: {} }),
        dispose: Deferred.await(releaseDisposal).pipe(
          Effect.tap(() => Effect.sync(() => events.push("disposed"))),
        ),
        withExclusive: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
      });
    },
  } as any;
  const registry = makeBrokerRegistry({
    canonicalize: (value) => Effect.succeed(value),
    idleTimeoutMs: 0,
  });
  await Effect.runPromise(
    Effect.gen(function* () {
      const adapter = {
        command: ["varlock"],
        environmentKeys: [],
        startupTimeoutMs: 100,
        commandTimeoutMs: 100,
        reloadTimeoutMs: 100,
        pollIntervalMs: 10,
        requireStrictEgress: true,
      };
      const first = yield* registry.acquire(factory, {
        projectDirectory: directory,
        adapter,
      } as any);
      yield* first.ensureReady;
      const released = yield* Effect.forkChild(first.release);
      yield* Effect.yieldNow;
      const second = yield* registry
        .acquire(factory, { projectDirectory: directory, adapter } as any)
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      expect(starts).toBe(1);
      expect(events).toEqual(["start-1"]);
      yield* Deferred.succeed(releaseDisposal, undefined);
      const replacement = yield* Fiber.join(second);
      yield* replacement.ensureReady;
      yield* Fiber.join(released);
      expect(events).toEqual(["start-1", "disposed", "start-2"]);
      yield* replacement.release;
      yield* registry.shutdown;
    }),
  );
});

describe("stale relay binding", () => {
  test("disables managed remotes without a relay and restores them after recovery", () => {
    const values = new Map<string, any>([
      [
        "remote",
        {
          type: "remote",
          url: "https://upstream.example.test/mcp",
          oauth: false,
          headers: { "X-Native": "safe" },
        },
      ],
    ]);
    const editor = {
      get: (name: string) => values.get(name),
      update: (name: string, update: (config: any) => void) => update(values.get(name)),
    } as any;
    const options = parseOptions(
      { servers: { remote: { remote: { headers: { Authorization: "TOKEN" } } } } },
      "/project",
    ).adapter;
    applyProtection(editor, options, { ready: false, environment: {}, remoteHandles: new Map() });
    expect(values.get("remote")).toMatchObject({
      url: "https://upstream.example.test/mcp",
      disabled: true,
    });
    expect(values.get("remote").headers).not.toHaveProperty(RELAY_AUTH_HEADER);

    values.get("remote").disabled = false;
    const handle = {
      localUrl: "http://127.0.0.1:4900/mcp",
      downstreamToken: "relay-token",
      health: Effect.succeed({ listening: true, activeRequests: 0, localUrl: "local" }),
      stop: Effect.void,
    };
    applyProtection(editor, options, {
      ready: true,
      environment: { TOKEN: "secret" },
      remoteHandles: new Map([["remote", handle]]),
    });
    expect(values.get("remote")).toMatchObject({
      url: handle.localUrl,
      disabled: false,
      headers: { [RELAY_AUTH_HEADER]: handle.downstreamToken },
    });
  });

  test("does not expose a relay capability after it is stopped", async () => {
    const coordinator = makeRemoteRelayCoordinator(undefined, true);
    const options = parseOptions(
      { servers: { remote: { remote: { headers: { Authorization: "TOKEN" } } } } },
      "/project",
    );
    await Effect.runPromise(
      Effect.scoped(
        coordinator.reconcile(new Map(), options.adapter.servers, {}, 1, "dead-session"),
      ),
    );
    expect(coordinator.handles.size).toBe(0);
  });
});
