import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import { connect, createServer as createNetServer, type Server as NetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { startRelay, RELAY_AUTH_HEADER } from "../src/relay/index.js";

let dir: string;
let upstream: HttpsServer;
let proxy: NetServer;
let upstreamPort = 0;
let proxyPort = 0;
let seenApiKey = "";
let seenHost = "";
let endpointValue = "";
let upstreamBodies: string[] = [];

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "key-ferry-relay-"));
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost",
      "-keyout",
      join(dir, "key.pem"),
      "-out",
      join(dir, "cert.pem"),
    ],
    { stdio: "ignore" },
  );
  upstream = createHttpsServer(
    { key: readFileSync(join(dir, "key.pem")), cert: readFileSync(join(dir, "cert.pem")) },
    (req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.once("end", () => {
        upstreamBodies.push(Buffer.concat(chunks).toString());
      });
      if (req.headers["x-api-key"] !== undefined) seenApiKey = String(req.headers["x-api-key"]);
      seenHost = String(req.headers.host ?? "");
      if (req.url === "/sse") {
        const payload = `event:endpoint\ndata: ${endpointValue}\n\n`;
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "content-length": Buffer.byteLength(payload),
        });
        res.end(payload);
        return;
      }
      req.on("end", () => {
        res.writeHead(200, {
          "content-type": "application/json",
          "mcp-session-id": "session-test",
        });
        res.end(JSON.stringify({ method: req.method, body: Buffer.concat(chunks).toString() }));
      });
    },
  );
  proxy = createNetServer((client) => {
    client.once("data", (data) => {
      const line = data.toString().split("\r\n", 1)[0];
      const target = line.split(" ")[1];
      const [host, portText] = target.split(":");
      const socket = connect(Number(portText), host === "localhost" ? "127.0.0.1" : host, () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        socket.write(data.subarray(data.indexOf("\r\n\r\n") + 4));
        client.pipe(socket).pipe(client);
      });
      socket.on("error", () => client.destroy());
    });
  });
  return Promise.all([
    new Promise<void>((resolve) =>
      upstream.listen(0, "127.0.0.1", () => {
        upstreamPort = (upstream.address() as { port: number }).port;
        resolve();
      }),
    ),
    new Promise<void>((resolve) =>
      proxy.listen(0, "127.0.0.1", () => {
        proxyPort = (proxy.address() as { port: number }).port;
        resolve();
      }),
    ),
  ]).then(() => {
    endpointValue = `https://localhost:${upstreamPort}/messages?session=x`;
  });
});

const rawRelayRequest = (url: string, token: string, request: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const target = new URL(url);
    const socket = connect(Number(target.port), target.hostname);
    let response = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("raw relay request timed out"));
    }, 2_000);
    // Keep the client socket open until the response arrives. Half-closing
    // immediately can make the relay's response-close cancellation win the
    // race before the upstream response is copied back.
    socket.on("connect", () => socket.write(request.replace("AUTH_TOKEN", token)));
    socket.on("data", (chunk) => {
      response += chunk.toString();
      if (response.includes("\r\n0\r\n\r\n") || response.includes("400 Bad Request")) {
        clearTimeout(timer);
        socket.destroy();
        resolve(response);
      }
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.on("close", () => {
      clearTimeout(timer);
      resolve(response);
    });
  });

afterAll(() => {
  upstream.close();
  proxy.close();
  rmSync(dir, { recursive: true, force: true });
});

const withRelay = <A>(
  program: (url: string, token: string) => Promise<A>,
  upstreamPath = "/mcp",
  overrides: Partial<Parameters<typeof startRelay>[0]> = {},
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const relay = yield* startRelay({
          upstreamUrl: `https://localhost:${upstreamPort}${upstreamPath}`,
          proxyUrl: `http://127.0.0.1:${proxyPort}`,
          managerCaPem: readFileSync(join(dir, "cert.pem"), "utf8"),
          placeholderHeaders: { "x-api-key": "FAKE_PLACEHOLDER" },
          oauth: false,
          ...overrides,
        });
        return yield* Effect.tryPromise(() => program(relay.localUrl, relay.downstreamToken));
      }),
    ),
  );

describe("fixed-target relay", () => {
  it("forwards valid chunked framing and rejects conflicting framing before upstream", async () => {
    upstreamBodies = [];
    const result = await withRelay(async (url, token) => {
      const valid = await rawRelayRequest(
        url,
        token,
        `POST /mcp HTTP/1.1\r\nHost: localhost\r\n${RELAY_AUTH_HEADER}: AUTH_TOKEN\r\nTransfer-Encoding: chunked\r\nConnection: keep-alive\r\n\r\n5\r\nhello\r\n0\r\n\r\n`,
      );
      const beforeConflict = upstreamBodies.length;
      const conflict = await rawRelayRequest(
        url,
        token,
        `POST /mcp HTTP/1.1\r\nHost: localhost\r\n${RELAY_AUTH_HEADER}: AUTH_TOKEN\r\nContent-Length: 5\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n5\r\nhello\r\n0\r\n\r\n`,
      );
      return { valid, conflict, beforeConflict, afterConflict: upstreamBodies.length };
    });
    expect(result.valid).toContain("200");
    expect(result.beforeConflict).toBe(1);
    expect(result.conflict).toContain("400 Bad Request");
    expect(result.afterConflict).toBe(result.beforeConflict);
    expect(upstreamBodies).toEqual(["hello"]);
  });

  it("does not forward bytes beyond a declared content length", async () => {
    upstreamBodies = [];
    const result = await withRelay(async (url, token) =>
      rawRelayRequest(
        url,
        token,
        `POST /mcp HTTP/1.1\r\nHost: localhost\r\n${RELAY_AUTH_HEADER}: AUTH_TOKEN\r\nContent-Length: 3\r\nConnection: close\r\n\r\nhello`,
      ),
    );
    expect(result).toContain("400 Bad Request");
    // Bun's parser rejects the extra bytes before dispatching this request;
    // implementations that dispatch first may expose only the declared prefix.
    expect(upstreamBodies).not.toContain("hello");
    expect(upstreamBodies.every((body) => body === "hel")).toBe(true);
  });

  it("authenticates, uses CONNECT, streams methods, and replaces credentials", async () => {
    const result = await withRelay(async (url, token) => {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          [RELAY_AUTH_HEADER]: token,
          host: "attacker.invalid",
          authorization: "Bearer oauth-must-not-forward",
          "mcp-protocol-version": "2025-11-25",
        },
        body: "hello",
      });
      const get = await fetch(url, { headers: { [RELAY_AUTH_HEADER]: token } });
      const del = await fetch(url, { method: "DELETE", headers: { [RELAY_AUTH_HEADER]: token } });
      return {
        status: response.status,
        get: get.status,
        del: del.status,
        body: (await response.json()) as { method: string; body: string },
        session: response.headers.get("mcp-session-id"),
      };
    });
    expect(result.status).toBe(200);
    expect(result.get).toBe(200);
    expect(result.del).toBe(200);
    expect(result.body).toEqual({ method: "POST", body: "hello" });
    expect(result.session).toBe("session-test");
    expect(seenApiKey).toBe("FAKE_PLACEHOLDER");
    expect(seenHost).toBe(`localhost:${upstreamPort}`);
  });

  it("rejects missing auth and paths outside the fixed target", async () => {
    const result = await withRelay(async (url, token) => ({
      unauthenticated: (await fetch(url)).status,
      denied: (
        await fetch(`${new URL(url).origin}/other`, { headers: { [RELAY_AUTH_HEADER]: token } })
      ).status,
    }));
    expect(result).toEqual({ unauthenticated: 401, denied: 404 });
  });

  it("bounds request bodies and fails closed on CA errors", async () => {
    const limited = await withRelay(
      async (url, token) =>
        (
          await fetch(url, {
            method: "POST",
            headers: { [RELAY_AUTH_HEADER]: token },
            body: "123456789",
          })
        ).status,
      "/mcp",
      { maxRequestBytes: 3 },
    );
    expect(limited).toBe(413);
    const badCa = await withRelay(
      async (url, token) => (await fetch(url, { headers: { [RELAY_AUTH_HEADER]: token } })).status,
      "/mcp",
      { managerCaPem: "not-a-certificate" },
    );
    expect(badCa).toBe(502);
  });

  it("rewrites only a same-origin SSE endpoint", async () => {
    const result = await withRelay(async (url, token) => {
      const response = await fetch(url, { headers: { [RELAY_AUTH_HEADER]: token } });
      return {
        status: response.status,
        length: response.headers.get("content-length"),
        encoding: response.headers.get("content-encoding"),
        text: await response.text(),
      };
    }, "/sse");
    expect(result.status).toBe(200);
    expect(result.text).toContain(`data: http://127.0.0.1:`);
    expect(result.text).toContain("/messages?session=x");
    expect(result.text.length).toBeGreaterThan(0);
    expect(result.length).toBeNull();
    expect(result.encoding).toBeNull();
  });

  it("fails closed for an external SSE endpoint", async () => {
    endpointValue = "https://attacker.invalid/messages";
    const result = await withRelay(async (url, token) => {
      const response = await fetch(url, { headers: { [RELAY_AUTH_HEADER]: token } });
      return { status: response.status, text: await response.text() };
    }, "/sse");
    expect(result.status).toBe(502);
    endpointValue = `https://localhost:${upstreamPort}/messages?session=x`;
  });

  it("bounds same-origin SSE route registration", async () => {
    endpointValue = Array.from(
      { length: 300 },
      (_, index) => `event:endpoint\ndata: https://localhost:${upstreamPort}/messages/${index}\n\n`,
    ).join("");
    const result = await withRelay(async (url, token) => {
      const response = await fetch(url, { headers: { [RELAY_AUTH_HEADER]: token } });
      return { status: response.status, body: await response.text().catch(() => "") };
    }, "/sse");
    // The bounded route table fails closed instead of accepting an unbounded
    // stream of endpoint URLs.
    expect(result.status).toBe(502);
    endpointValue = `https://localhost:${upstreamPort}/messages?session=x`;
  });
});
