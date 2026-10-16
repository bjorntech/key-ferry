import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { parseOptions } from "../src/options.js";
import {
  makeRemoteRelayCoordinator,
  RELAY_AUTH_HEADER,
  safeForwardHeaders,
  sourceEnvironmentKeys,
  validateRemoteUrl,
  type RemoteRelayConfig,
  type RemoteRelayHandle,
} from "../src/remote.js";

const caDir = mkdtempSync(join(tmpdir(), "key-ferry-remote-"));
const caPath = join(caDir, "ca-cert.pem");
writeFileSync(caPath, "-----BEGIN CERTIFICATE-----\nsynthetic\n-----END CERTIFICATE-----\n");

const environment = {
  HTTPS_PROXY: "http://127.0.0.1:43210",
  NODE_EXTRA_CA_CERTS: caPath,
  REMOTE_API_KEY: "placeholder-api-key",
  REMOTE_TENANT: "tenant-placeholder",
};

const server = (overrides: Record<string, unknown> = {}) => ({
  type: "remote" as const,
  url: "https://mcp.example.test/mcp",
  oauth: false as const,
  headers: { "X-Trace": "trace-id" },
  ...overrides,
});

const fakeRelay =
  (started: RemoteRelayConfig[], stopped: string[]) => (config: RemoteRelayConfig) => {
    started.push(config);
    const token = `token-${started.length}`;
    const handle: RemoteRelayHandle = {
      localUrl: `http://127.0.0.1:${4000 + started.length}`,
      downstreamToken: token,
      health: Effect.succeed({
        listening: true,
        activeRequests: 0,
        localUrl: `http://127.0.0.1:${4000 + started.length}`,
      }),
      stop: Effect.sync(() => {
        stopped.push(token);
      }),
    };
    return Effect.succeed(handle);
  };

describe("remote adapter contract", () => {
  test("validates HTTPS targets without banning corporate DNS names", () => {
    expect(validateRemoteUrl("https://mcp.example.test/mcp").origin).toBe(
      "https://mcp.example.test",
    );
    expect(() => validateRemoteUrl("http://mcp.example.test/mcp")).toThrow();
    expect(() => validateRemoteUrl("https://user:pass@mcp.example.test/mcp")).toThrow();
    expect(() => validateRemoteUrl("https://127.0.0.1/mcp")).toThrow();
    expect(validateRemoteUrl("https://127.0.0.1/mcp", true).hostname).toBe("127.0.0.1");
    for (const host of [
      "localhost",
      "api.localhost",
      "10.0.0.1",
      "127.0.0.1",
      "169.254.1.1",
      "192.168.1.1",
      "172.16.0.1",
      "[::1]",
      "[fd00::1]",
      "[fe80::1]",
    ]) {
      expect(() => validateRemoteUrl(`https://${host}/mcp`)).toThrow();
      expect(validateRemoteUrl(`https://${host}/mcp`, true).protocol).toBe("https:");
    }
    expect(() => validateRemoteUrl("not a URL")).toThrow("remote MCP URL is invalid");
    expect(() => validateRemoteUrl("https://mcp.example.test/#fragment")).toThrow();
  });

  test("starts a relay with placeholder headers and preserves safe custom headers", async () => {
    const started: RemoteRelayConfig[] = [];
    const stopped: string[] = [];
    const coordinator = makeRemoteRelayCoordinator(fakeRelay(started, stopped));
    const options = parseOptions(
      {
        servers: {
          remote: {
            remote: {
              headers: {
                Authorization: { env: "REMOTE_API_KEY", prefix: "Bearer " },
                "X-Tenant": "REMOTE_TENANT",
              },
            },
          },
        },
      },
      "/project",
    );

    await Effect.runPromise(
      Effect.scoped(
        coordinator.reconcile(
          new Map([["remote", server()]]),
          options.adapter.servers,
          environment,
          1,
        ),
      ),
    );

    expect(started).toHaveLength(1);
    expect(started[0]?.oauth).toBe(false);
    expect(started[0]?.placeholderHeaders).toEqual({
      Authorization: "Bearer placeholder-api-key",
      "X-Tenant": "tenant-placeholder",
    });
    expect(safeForwardHeaders(server().headers, options.adapter.servers.remote as any)).toEqual({
      "X-Trace": "trace-id",
    });
    expect(JSON.stringify(coordinator.diagnostics)).not.toContain("token-");
    expect(RELAY_AUTH_HEADER).toBe("x-varlock-relay-token");
    expect(sourceEnvironmentKeys(options.adapter.servers.remote as any)).toEqual([
      "REMOTE_API_KEY",
      "REMOTE_TENANT",
    ]);
  });

  test("requires explicit oauth:false and fails closed without direct fallback", async () => {
    const started: RemoteRelayConfig[] = [];
    const coordinator = makeRemoteRelayCoordinator(fakeRelay(started, []), true);
    const options = parseOptions(
      {
        servers: {
          remote: { remote: { headers: { Authorization: "REMOTE_API_KEY" } } },
        },
      },
      "/project",
    );

    await Effect.runPromise(
      Effect.scoped(
        coordinator.reconcile(
          new Map([["remote", server({ oauth: undefined })]]),
          options.adapter.servers,
          environment,
          1,
        ),
      ),
    );

    expect(started).toHaveLength(0);
    expect(coordinator.diagnostics[0]?.code).toBe("remote_oauth_required");
    expect(coordinator.diagnostics[0]?.message).toContain("oauth:false");
  });

  test("stops old generation before replacing relay and never exposes tokens", async () => {
    const started: RemoteRelayConfig[] = [];
    const stopped: string[] = [];
    const coordinator = makeRemoteRelayCoordinator(fakeRelay(started, stopped));
    const options = parseOptions(
      {
        servers: {
          remote: { remote: { headers: { Authorization: "REMOTE_API_KEY" } } },
        },
      },
      "/project",
    );
    const configs = new Map([["remote", server()]]);
    await Effect.runPromise(
      Effect.scoped(coordinator.reconcile(configs, options.adapter.servers, environment, 1)),
    );
    await Effect.runPromise(
      Effect.scoped(coordinator.reconcile(configs, options.adapter.servers, environment, 2)),
    );

    expect(started).toHaveLength(2);
    expect(stopped).toEqual(["token-1"]);
    expect(JSON.stringify(coordinator.diagnostics)).not.toContain("token-2");
  });

  test("rejects unsafe configured headers", () => {
    const mapping = parseOptions(
      {
        servers: {
          remote: { remote: { headers: { Authorization: "REMOTE_API_KEY" } } },
        },
      },
      "/project",
    ).adapter.servers.remote as any;
    expect(safeForwardHeaders({ Cookie: "raw-secret" }, mapping)).toBeUndefined();
    expect(safeForwardHeaders({ Connection: "keep-alive" }, mapping)).toBeUndefined();
    expect(safeForwardHeaders({ authorization: "raw-secret" }, mapping)).toEqual({});
    expect(safeForwardHeaders({ "X-Bad": "line\nbreak" }, mapping)).toBeUndefined();
    expect(safeForwardHeaders({ "MCP-Protocol-Version": "2025-06-18" }, mapping)).toBeUndefined();
    const mappedTenant = parseOptions(
      { servers: { remote: { remote: { headers: { "X-Tenant": "REMOTE_API_KEY" } } } } },
      "/project",
    ).adapter.servers.remote as any;
    expect(safeForwardHeaders({ "X-Tenant": "mapped-value" }, mappedTenant)).toEqual({});
    expect(safeForwardHeaders({ "x-tenant": "mapped-value" }, mappedTenant)).toEqual({});
    expect(safeForwardHeaders({ "bad header": "value" }, mapping)).toBeUndefined();
  });

  test("fails closed for unavailable servers, missing wiring, placeholders, and bad CA", async () => {
    const started: RemoteRelayConfig[] = [];
    const stopped: string[] = [];
    const options = parseOptions(
      { servers: { remote: { remote: { headers: { Authorization: "REMOTE_API_KEY" } } } } },
      "/project",
    );
    const configs = options.adapter.servers;
    const coordinator = makeRemoteRelayCoordinator(fakeRelay(started, stopped));
    const noFactory = makeRemoteRelayCoordinator(undefined);
    await Effect.runPromise(
      Effect.scoped(noFactory.reconcile(new Map([["remote", server()]]), configs, environment, 0)),
    );
    expect(noFactory.diagnostics[0]?.code).toBe("remote_unavailable");
    await Effect.runPromise(
      Effect.scoped(coordinator.reconcile(new Map(), configs, environment, 1)),
    );
    expect(coordinator.diagnostics[0]?.code).toBe("remote_unavailable");
    await Effect.runPromise(
      Effect.scoped(
        coordinator.reconcile(
          new Map([["remote", server()]]),
          configs,
          { ...environment, REMOTE_API_KEY: undefined },
          2,
        ),
      ),
    );
    expect(coordinator.diagnostics[0]?.code).toBe("remote_missing_placeholder");
    await Effect.runPromise(
      Effect.scoped(
        coordinator.reconcile(
          new Map([["remote", server()]]),
          configs,
          { ...environment, HTTPS_PROXY: undefined, HTTP_PROXY: undefined },
          3,
        ),
      ),
    );
    expect(coordinator.diagnostics[0]?.code).toBe("remote_relay_failed");
    await Effect.runPromise(
      Effect.scoped(
        coordinator.reconcile(new Map([["remote", server()]]), configs, environment, 4),
      ),
    );
    expect(started).toHaveLength(1);
    const badCaPath = join(caDir, "bad-ca.pem");
    writeFileSync(badCaPath, "not a certificate");
    await Effect.runPromise(
      Effect.scoped(
        coordinator.reconcile(
          new Map([["remote", server()]]),
          configs,
          { ...environment, NODE_EXTRA_CA_CERTS: badCaPath },
          5,
        ),
      ),
    );
    expect(coordinator.diagnostics[0]?.code).toBe("remote_relay_failed");
    expect(stopped).toEqual(["token-1"]);
    await Effect.runPromise(
      Effect.scoped(
        coordinator.reconcile(
          new Map([["remote", server({ url: "https://127.0.0.1/mcp" })]]),
          configs,
          environment,
          6,
        ),
      ),
    );
    expect(coordinator.diagnostics[0]?.code).toBe("remote_invalid_url");
    expect(coordinator.handles.size).toBe(0);
  });

  test("reports relay startup failure without publishing a capability", async () => {
    const failingFactory = (_config: RemoteRelayConfig) =>
      Effect.fail<RemoteRelayHandle>(new Error("synthetic startup failure"));
    const options = parseOptions(
      { servers: { remote: { remote: { headers: { Authorization: "REMOTE_API_KEY" } } } } },
      "/project",
    );
    const coordinator = makeRemoteRelayCoordinator(failingFactory, true);
    await Effect.runPromise(
      Effect.scoped(
        coordinator.reconcile(
          new Map([["remote", server()]]),
          options.adapter.servers,
          environment,
          1,
        ),
      ),
    );
    expect(coordinator.diagnostics).toEqual([
      { server: "remote", code: "remote_relay_failed", message: "remote relay could not start" },
    ]);
    expect(coordinator.handles.size).toBe(0);
  });

  test("reports unhealthy relays, tolerates stop failures, and handles disabled servers", async () => {
    const stopped: string[] = [];
    const unhealthyFactory = (_config: RemoteRelayConfig) =>
      Effect.succeed<RemoteRelayHandle>({
        localUrl: "http://127.0.0.1:4999",
        downstreamToken: "synthetic-token",
        health: Effect.fail("health failed"),
        stop: Effect.fail("stop failed"),
      });
    const options = parseOptions(
      { servers: { remote: { remote: { headers: { Authorization: "REMOTE_API_KEY" } } } } },
      "/project",
    );
    const coordinator = makeRemoteRelayCoordinator(unhealthyFactory, true);
    const configs = options.adapter.servers;
    await Effect.runPromise(
      Effect.scoped(
        coordinator.reconcile(new Map([["remote", server()]]), configs, environment, 1),
      ),
    );
    expect(await Effect.runPromise(coordinator.health)).toBe(false);
    await Effect.runPromise(
      Effect.scoped(
        coordinator.reconcile(
          new Map([["remote", server({ disabled: true })]]),
          configs,
          environment,
          2,
        ),
      ),
    );
    expect(coordinator.handles.size).toBe(0);
    await Effect.runPromise(
      Effect.scoped(
        coordinator.reconcile(new Map([["remote", server()]]), configs, environment, 3),
      ),
    );
    await Effect.runPromise(
      Effect.scoped(
        coordinator.reconcile(
          new Map([["remote", server({ oauth: undefined })]]),
          configs,
          environment,
          4,
        ),
      ),
    );
    expect(coordinator.diagnostics[0]?.code).toBe("remote_oauth_required");
    expect(coordinator.handles.size).toBe(0);
    await Effect.runPromise(coordinator.stopAll);
    expect(stopped).toEqual([]);
  });
});

afterAll(() => {
  rmSync(caDir, { recursive: true, force: true });
});
