import { describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createServer, type Server } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Effect } from "effect";
import { projectDirectory, ProjectKeyFerryManager } from "../src/contracts.js";
import { makeProjectKeyFerryManager } from "../src/varlock/manager.js";

const execFileAsync = promisify(execFile);
const binary = process.env.VARLOCK_LIVE_BINARY;
const relayUrl = new URL("../src/relay/index.ts", import.meta.url);
let relayModule: any;
try {
  relayModule = await import(relayUrl.href);
} catch {
  // The relay writer may not have landed yet. Keep this integration test
  // optional until the frozen relay contract is available.
  relayModule = undefined;
}
const live = Boolean(binary?.startsWith("/") && relayModule);

type Upstream = {
  readonly server: Server;
  readonly port: number;
  readonly requests: Array<{ method: string; authorization: string | undefined }>;
};

async function listenUpstream(root: string): Promise<Upstream> {
  const key = join(root, "upstream-key.pem");
  const cert = join(root, "upstream-cert.pem");
  await execFileAsync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-sha256",
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost",
      "-keyout",
      key,
      "-out",
      cert,
    ],
    { maxBuffer: 64 * 1024 },
  );
  await chmod(key, 0o600);
  await chmod(cert, 0o644);
  const requests: Array<{ method: string; authorization: string | undefined }> = [];
  const server = createServer(
    { key: await readFile(key), cert: await readFile(cert) },
    (request, response) => {
      requests.push({ method: request.method ?? "", authorization: request.headers.authorization });
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        response.writeHead(200, {
          "content-type": "application/json",
          "mcp-session-id": "remote-live-session",
        });
        response.end(
          JSON.stringify({
            jsonrpc: "2.0",
            result: { ok: true, bytes: Buffer.concat(chunks).byteLength },
            id: 1,
          }),
        );
      });
    },
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    // Bind IPv6 loopback as well as IPv4-mapped loopback. Node's localhost
    // resolution may prefer ::1 while the Varlock allowlist intentionally
    // remains the hostname "localhost".
    server.listen(0, "::", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("upstream did not bind a TCP port");
  return { server, port: address.port, requests };
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function directRelayRequest(
  url: string,
  headers: Record<string, string>,
  body: string,
): Promise<{ status: number; headers: Headers; json: () => Promise<any> }> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const request = httpRequest(
      {
        hostname: target.hostname,
        port: Number(target.port),
        path: target.pathname + target.search,
        method: "POST",
        headers,
        agent: false,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({
            status: response.statusCode ?? 0,
            headers: new Headers(response.headers as Record<string, string>),
            json: async () => JSON.parse(text),
          });
        });
      },
    );
    request.once("error", reject);
    request.end(body);
  });
}

describe("remote Varlock relay", () => {
  test.skipIf(!live)(
    "routes an authenticated client through Varlock to synthetic HTTPS MCP",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "key-ferry-remote-live-"));
      const home = join(root, "home");
      const xdg = join(root, "xdg");
      const project = join(root, "project");
      await Promise.all([mkdir(home), mkdir(xdg), mkdir(project)]);
      const schema = join(project, ".env.schema");
      const wrapper = join(root, "varlock-wrapper.sh");
      const upstream = await listenUpstream(root);
      let relay: any;
      try {
        await writeFile(
          schema,
          [
            '# @proxyConfig={egress="strict"}',
            "# ---",
            '# @sensitive @proxy(domain="localhost")',
            "# @placeholder=sk-placeholder-remote",
            "FAKE_MCP_KEY=sk-real-remote-canary",
            "",
          ].join("\n"),
        );
        await writeFile(
          wrapper,
          [
            "#!/bin/sh",
            `export HOME=${JSON.stringify(home)}`,
            `export XDG_CONFIG_HOME=${JSON.stringify(xdg)}`,
            `export NODE_EXTRA_CA_CERTS=${JSON.stringify(join(root, "upstream-cert.pem"))}`,
            `exec ${JSON.stringify(binary!)} "$@"`,
            "",
          ].join("\n"),
        );
        await chmod(wrapper, 0o700);

        const program = Effect.gen(function* () {
          const manager = yield* ProjectKeyFerryManager;
          const started = yield* manager.ensureStarted;
          expect(started.phase).toBe("ready");
          const environment = yield* manager.environment;
          expect(environment.FAKE_MCP_KEY).toBe("sk-placeholder-remote"); // client never sees the real canary
          expect(environment.HTTP_PROXY).toMatch(/^http:\/\/127\.0\.0\.1:/);
          expect(environment.NODE_EXTRA_CA_CERTS).toMatch(/\/key-ferry-cert-[^/]+\/ca-cert\.pem$/);

          const relayConfig = {
            upstreamUrl: `https://localhost:${upstream.port}`,
            proxyUrl: environment.HTTPS_PROXY,
            managerCaPem: yield* Effect.promise(() =>
              readFile(environment.NODE_EXTRA_CA_CERTS, "utf8"),
            ),
            placeholderHeaders: { Authorization: `Bearer ${environment.FAKE_MCP_KEY}` },
            oauth: false,
            connectTimeoutMs: 10_000,
            idleTimeoutMs: 30_000,
            maxRequestBytes: 1024 * 1024,
            maxConnections: 4,
          };
          const handle = yield* relayModule.startRelay(relayConfig);
          relay = handle;
          yield* handle.health;
          const response = yield* Effect.promise(() =>
            directRelayRequest(
              handle.localUrl,
              {
                [relayModule.RELAY_AUTH_HEADER]: handle.downstreamToken,
                "content-type": "application/json",
              },
              JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
            ),
          );
          expect(response.status).toBe(200);
          expect(response.headers.get("mcp-session-id")).toBe("remote-live-session");
          const body = yield* Effect.promise(
            () => response.json() as Promise<{ result?: { ok?: boolean } }>,
          );
          expect(body.result?.ok).toBe(true);
          expect(
            upstream.requests.some(
              (request) => request.authorization === "Bearer sk-real-remote-canary",
            ),
          ).toBe(true);
          expect(
            upstream.requests.some(
              (request) => request.authorization === `Bearer ${environment.FAKE_MCP_KEY}`,
            ),
          ).toBe(false);

          yield* handle.stop;
          relay = undefined;
          yield* manager.dispose;
        }).pipe(
          Effect.provide(
            makeProjectKeyFerryManager({
              projectDirectory: projectDirectory(project),
              adapter: {
                command: [wrapper],
                environmentKeys: ["FAKE_MCP_KEY"],
                startupTimeoutMs: 30_000,
                commandTimeoutMs: 10_000,
                reloadTimeoutMs: 30_000,
                pollIntervalMs: 100,
                requireStrictEgress: true,
              },
            }),
          ),
        );
        await Effect.runPromise(Effect.scoped(program));
      } finally {
        if (relay) await Effect.runPromise(relay.stop.pipe(Effect.catch(() => Effect.void)));
        await closeServer(upstream.server);
        await rm(root, { recursive: true, force: true });
        expect(existsSync(root)).toBe(false);
      }
    },
    120_000,
  );
});

async function mkdir(path: string): Promise<void> {
  await (await import("node:fs/promises")).mkdir(path, { recursive: true });
}
