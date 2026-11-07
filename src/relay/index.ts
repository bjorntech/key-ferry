import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  Agent as HttpAgent,
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { request as httpsRequest } from "node:https";
import type { Socket, AddressInfo } from "node:net";
import { PassThrough } from "node:stream";
import { connect as tlsConnect } from "node:tls";
import { Data, Effect } from "effect";

export const RELAY_AUTH_HEADER = "x-varlock-relay-token";

export type RelayErrorCode =
  | "invalid-config"
  | "bind-failed"
  | "unauthorized"
  | "path-denied"
  | "body-too-large"
  | "upstream-connect-failed"
  | "upstream-tls-failed"
  | "timeout"
  | "closed"
  | "unsupported"
  | "io";

export class RelayError extends Data.TaggedError("RelayError")<{
  readonly code: RelayErrorCode;
  readonly message: string;
}> {}

export interface RelayConfig {
  readonly upstreamUrl: string;
  readonly proxyUrl: string;
  readonly managerCaPem: string;
  readonly placeholderHeaders: Readonly<Record<string, string>>;
  readonly oauth: false;
  readonly maxRequestBytes?: number;
  readonly connectTimeoutMs?: number;
  readonly idleTimeoutMs?: number;
  readonly maxConnections?: number;
  /** Opaque coordinator binding; the relay does not inspect secret values. */
  readonly binding?: unknown;
}

export interface RelayHealth {
  readonly listening: boolean;
  readonly activeRequests: number;
  readonly localUrl: string;
}

export interface RelayHandle {
  readonly localUrl: string;
  /** Internal capability. Never include this in public RPC, logs, or status. */
  readonly downstreamToken: string;
  readonly health: Effect.Effect<RelayHealth>;
  readonly stop: Effect.Effect<void, RelayError>;
}

const maxDefault = 4 * 1024 * 1024;
const connectDefault = 10_000;
const idleDefault = 120_000;
const connectionsDefault = 32;
const routesDefault = 256;
const hopByHop = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const rejectedCredentialHeaders = new Set(["authorization", "cookie", "proxy-authorization"]);

const failure = (code: RelayErrorCode): RelayError =>
  new RelayError({ code, message: `relay ${code}` });

const parseUrl = (value: string, allowHttps: boolean): URL | undefined => {
  try {
    const url = new URL(value);
    if (
      (!allowHttps && url.protocol !== "http:" && url.protocol !== "https:") ||
      (allowHttps && url.protocol !== "https:")
    )
      return undefined;
    if (url.username || url.password || url.hash) return undefined;
    return url;
  } catch {
    return undefined;
  }
};

const isLoopback = (address: string | undefined): boolean =>
  address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";

const cleanHeaders = (
  headers: IncomingMessage["headers"],
  configured: Readonly<Record<string, string>>,
  target: URL,
): Record<string, string | string[]> => {
  const result: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (lower === RELAY_AUTH_HEADER || hopByHop.has(lower) || lower === "host") continue;
    const replacement = configured[lower];
    if (replacement !== undefined) {
      result[lower] = replacement;
      continue;
    }
    if (rejectedCredentialHeaders.has(lower)) continue;
    if (value !== undefined) result[lower] = value;
  }
  // The native MCP adapter deliberately does not carry credential headers.
  // Inject the complete allowlisted set here, including headers absent from
  // the downstream request, so authentication does not depend on clients
  // echoing a header name back to the relay.
  for (const [name, value] of Object.entries(configured)) result[name.toLowerCase()] = value;
  result.host = target.host;
  result["accept-encoding"] = "identity";
  return result;
};

const responseHeaders = (
  headers: Record<string, string | string[] | undefined>,
  upstream: URL,
  localOrigin: string,
  register: (url: URL) => void,
) => {
  const result: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (hopByHop.has(lower)) continue;
    if (value === undefined) continue;
    if (lower === "location") {
      const location = Array.isArray(value) ? value[0] : value;
      if (location === undefined) continue;
      try {
        const target = new URL(location, upstream);
        if (
          target.protocol !== "https:" ||
          target.origin !== upstream.origin ||
          target.username ||
          target.password ||
          target.hash
        )
          continue;
        register(target);
        result["location"] = `${localOrigin}${target.pathname}${target.search}`;
      } catch {
        continue;
      }
    } else result[lower] = value;
  }
  return result;
};

const write = (res: ServerResponse, chunk: Uint8Array, signal: AbortSignal): Promise<void> => {
  if (res.write(chunk)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const done = () => {
      cleanup();
      resolve();
    };
    const fail = () => {
      cleanup();
      reject(failure("closed"));
    };
    const cleanup = () => {
      res.removeListener("drain", done);
      res.removeListener("close", fail);
      signal.removeEventListener("abort", fail);
    };
    res.once("drain", done);
    res.once("close", fail);
    signal.addEventListener("abort", fail, { once: true });
  });
};

const endpointRewrite = async function* (
  source: AsyncIterable<Uint8Array>,
  upstream: URL,
  localOrigin: string,
  register: (url: URL) => void,
  maxFrame: number,
): AsyncGenerator<Uint8Array> {
  const decoder = new TextDecoder();
  let pending = "";
  let frame = "";
  const emit = (value: string) => new TextEncoder().encode(value);
  for await (const chunk of source) {
    pending += decoder.decode(chunk, { stream: true });
    if (pending.length > maxFrame * 2) throw failure("body-too-large");
    let index;
    while ((index = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, index + 1);
      pending = pending.slice(index + 1);
      frame += line;
      if (frame.length > maxFrame) throw failure("body-too-large");
      if (line === "\n" || line === "\r\n") {
        const match = frame.match(
          /(^|\r?\n)event:\s*endpoint\s*\r?\n(?:data:\s*)([^\r\n]+)(?:\r?\n|$)/,
        );
        if (match) {
          let endpoint: URL;
          try {
            endpoint = new URL(match[2], upstream);
          } catch {
            throw failure("path-denied");
          }
          if (
            endpoint.protocol !== "https:" ||
            endpoint.origin !== upstream.origin ||
            endpoint.username ||
            endpoint.password ||
            endpoint.hash
          )
            throw failure("path-denied");
          register(endpoint);
          frame = frame.replace(match[2], `${localOrigin}${endpoint.pathname}${endpoint.search}`);
        }
        yield emit(frame);
        frame = "";
      }
    }
  }
  pending += decoder.decode();
  if (pending) frame += pending;
  if (frame) yield emit(frame);
};

const throughProxy = (
  target: URL,
  proxy: URL,
  ca: string,
  method: string,
  headers: Record<string, string | string[]>,
  body: PassThrough | undefined,
  connectTimeout: number,
  idleTimeout: number,
  signal: AbortSignal,
): Promise<{
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: IncomingMessage;
}> =>
  new Promise((resolve, reject) => {
    const connectRequest = (proxy.protocol === "https:" ? httpsRequest : httpRequest)({
      hostname: proxy.hostname,
      port: proxy.port || (proxy.protocol === "https:" ? 443 : 80),
      method: "CONNECT",
      path: `${target.hostname}:${target.port || 443}`,
      timeout: connectTimeout,
    });
    let settled = false;
    let tls: import("node:tls").TLSSocket | undefined;
    let request: import("node:http").ClientRequest | undefined;
    const fail = () => {
      if (!settled) {
        settled = true;
        reject(failure("upstream-connect-failed"));
      }
    };
    const cancel = () => {
      connectRequest.destroy();
      tls?.destroy();
      request?.destroy();
      if (!settled) {
        settled = true;
        reject(failure("closed"));
      }
    };
    signal.addEventListener("abort", cancel, { once: true });
    connectRequest.once("error", fail);
    connectRequest.once("timeout", () => {
      connectRequest.destroy();
      if (!settled) {
        settled = true;
        reject(failure("timeout"));
      }
    });
    connectRequest.once("connect", (response, socket) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        fail();
        return;
      }
      try {
        tls = tlsConnect({ socket, servername: target.hostname, ca, rejectUnauthorized: true });
      } catch {
        socket.destroy();
        if (!settled) {
          settled = true;
          reject(failure("upstream-tls-failed"));
        }
        return;
      }
      tls.once("error", () => {
        if (!settled) {
          settled = true;
          reject(failure("upstream-tls-failed"));
        }
      });
      tls.once("secureConnect", () => {
        // The CONNECT socket is already a verified TLS connection to the
        // Varlock MITM endpoint. Pass that socket to the plain HTTP framing
        // API so no second TLS layer is created or validated.
        class TunnelAgent extends HttpAgent {
          override createConnection(
            _options: Parameters<HttpAgent["createConnection"]>[0],
            callback?: Parameters<HttpAgent["createConnection"]>[1],
          ) {
            const socket = tls!;
            callback?.(null, socket);
            return socket;
          }
        }
        const socketAgent = new TunnelAgent({ keepAlive: false });
        request = httpRequest({
          hostname: target.hostname,
          port: target.port || 443,
          path: `${target.pathname}${target.search}`,
          method,
          headers,
          agent: socketAgent,
          timeout: idleTimeout,
        });
        request.once("error", () => {
          if (!settled) {
            settled = true;
            reject(failure("upstream-connect-failed"));
          }
        });
        const clientRequest = request;
        clientRequest.once("timeout", () => clientRequest.destroy(failure("timeout")));
        request.once("response", (upstreamResponse) => {
          settled = true;
          signal.removeEventListener("abort", cancel);
          resolve({
            statusCode: upstreamResponse.statusCode ?? 502,
            headers: upstreamResponse.headers,
            body: upstreamResponse,
          });
        });
        if (body) body.pipe(request);
        else request.end();
      });
    });
    connectRequest.end();
  });

const start = (
  config: RelayConfig,
): Effect.Effect<RelayHandle, RelayError, import("effect/Scope").Scope> => {
  const upstream = parseUrl(config.upstreamUrl, true);
  const proxy = parseUrl(config.proxyUrl, false);
  if (!upstream || !proxy || config.oauth !== false || !config.managerCaPem)
    return Effect.fail(failure("invalid-config"));
  const maxBytes = config.maxRequestBytes ?? maxDefault;
  const maxConnections = config.maxConnections ?? connectionsDefault;
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    !Number.isSafeInteger(maxConnections) ||
    maxConnections < 1
  )
    return Effect.fail(failure("invalid-config"));

  return Effect.acquireRelease(
    Effect.callback<RelayHandle, RelayError>((resume) => {
      let server: Server;
      const token = randomBytes(32).toString("base64url");
      const tokenBytes = Buffer.from(token);
      const sockets = new Set<Socket>();
      const routes = new Map<string, URL>();
      const baseKey = `${upstream.pathname}${upstream.search}`;
      routes.set(baseKey, upstream);
      let active = 0;
      let listening = false;
      let stopped = false;
      const controllers = new Set<AbortController>();
      const localOrigin = () => {
        const address = server.address();
        return address && typeof address !== "string"
          ? `http://127.0.0.1:${(address as AddressInfo).port}`
          : "http://127.0.0.1";
      };
      const register = (target: URL) => {
        const key = `${target.pathname}${target.search}`;
        if (routes.has(key)) return;
        if (routes.size >= routesDefault) throw failure("path-denied");
        routes.set(key, target);
      };
      const reject = (res: ServerResponse, status: number, message = "") => {
        const body = Buffer.from(message);
        if (!res.headersSent)
          res.writeHead(status, {
            "content-type": "text/plain",
            "content-length": body.byteLength,
          });
        res.end(body);
      };
      const forwardResponse = async (
        req: IncomingMessage,
        res: ServerResponse,
        target: URL,
        controller: AbortController,
        body: PassThrough,
      ) => {
        const upstreamResponse = await throughProxy(
          target,
          proxy,
          config.managerCaPem,
          req.method ?? "GET",
          cleanHeaders(
            req.headers,
            Object.fromEntries(
              Object.entries(config.placeholderHeaders).map(([k, v]) => [k.toLowerCase(), v]),
            ),
            target,
          ),
          requestBody(req.method, body),
          config.connectTimeoutMs ?? connectDefault,
          config.idleTimeoutMs ?? idleDefault,
          controller.signal,
        );
        controller.signal.addEventListener("abort", () => upstreamResponse.body.destroy(), {
          once: true,
        });
        await writeRelayResponse(res, upstreamResponse, controller.signal);
      };
      const requestBody = (method: string | undefined, body: PassThrough) =>
        method === "GET" || method === "HEAD" ? undefined : body;
      const writeRelayResponse = async (
        res: ServerResponse,
        upstreamResponse: {
          statusCode: number;
          headers: Record<string, string | string[] | undefined>;
          body: IncomingMessage;
        },
        signal: AbortSignal,
      ) => {
        const headers = responseHeaders(
          upstreamResponse.headers,
          upstream,
          localOrigin(),
          register,
        );
        const contentType =
          typeof headers["content-type"] === "string" ? headers["content-type"] : "";
        const rewrittenSse = contentType.toLowerCase().includes("text/event-stream");
        if (rewrittenSse && unsupportedEncoding(headers)) throw failure("unsupported");
        if (rewrittenSse) {
          delete headers["content-length"];
          delete headers["content-encoding"];
        }
        await streamRelayResponse(res, upstreamResponse, headers, rewrittenSse, signal);
      };
      const unsupportedEncoding = (headers: Record<string, string | string[] | undefined>) =>
        headers["content-encoding"] !== undefined && headers["content-encoding"] !== "identity";
      const streamRelayResponse = async (
        res: ServerResponse,
        upstreamResponse: { statusCode: number; body: IncomingMessage },
        headers: Record<string, string | string[] | undefined>,
        rewrittenSse: boolean,
        signal: AbortSignal,
      ) => {
        const stream = rewrittenSse
          ? endpointRewrite(upstreamResponse.body, upstream, localOrigin(), register, maxBytes)
          : upstreamResponse.body;
        const iterator = stream[Symbol.asyncIterator]();
        const first = await iterator.next();
        res.writeHead(upstreamResponse.statusCode, headers);
        if (!first.done) await write(res, first.value, signal);
        for await (const chunk of { [Symbol.asyncIterator]: () => iterator })
          await write(res, chunk, signal);
        res.end();
      };
      const authorize = (req: IncomingMessage): URL | number => {
        const access = authorizeAccess(req);
        if (access !== undefined) return access;
        return authorizeRoute(req);
      };
      const authorizeAccess = (req: IncomingMessage): number | undefined => {
        if (stopped || !isLoopback(req.socket.remoteAddress)) return 403;
        const supplied = req.headers[RELAY_AUTH_HEADER];
        const received = typeof supplied === "string" ? Buffer.from(supplied) : Buffer.alloc(0);
        return invalidToken(received) ? 401 : undefined;
      };
      const invalidToken = (received: Buffer) =>
        received.length !== tokenBytes.length || !timingSafeEqual(received, tokenBytes);
      const authorizeRoute = (req: IncomingMessage): URL | number => {
        const target = routes.get(req.url ?? "/");
        if (!target || target.origin !== upstream.origin) return 404;
        return target;
      };
      const validateRequest = (req: IncomingMessage): number | undefined => {
        if (!new Set(["GET", "POST", "DELETE"]).has(req.method ?? "GET")) return 405;
        if (active >= maxConnections) return 429;
        const length = req.headers["content-length"];
        if (oversizedHeader(length)) return 413;
        return undefined;
      };
      const oversizedHeader = (length: string | undefined) => !!length && Number(length) > maxBytes;
      const setupBody = (req: IncomingMessage, controller: AbortController) => {
        const body = new PassThrough();
        const state = { oversized: false };
        let bytes = 0;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const reset = () => {
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => {
            controller.abort();
            body.destroy(failure("timeout"));
            req.destroy();
          }, config.idleTimeoutMs ?? idleDefault);
        };
        reset();
        req.on("data", (chunk: Buffer) => {
          reset();
          bytes += chunk.byteLength;
          if (bytes > maxBytes && !state.oversized) {
            state.oversized = true;
            body.destroy(failure("body-too-large"));
            req.destroy();
          }
        });
        req.on("end", () => {
          if (timer) clearTimeout(timer);
          body.end();
        });
        req.on("error", (cause) => body.destroy(cause));
        req.pipe(body);
        return { body, state, timer: () => timer };
      };
      const failResponse = (
        res: ServerResponse,
        cause: unknown,
        oversized: boolean,
        controller: AbortController,
      ) => {
        controller.abort();
        if (res.headersSent) return res.destroy();
        const unavailable = isUnavailable(cause);
        reject(
          res,
          oversized ? 413 : 502,
          unavailable ? "key-ferry relay unavailable; broker connection failed" : "",
        );
      };
      const isUnavailable = (cause: unknown) =>
        cause instanceof RelayError &&
        (cause.code === "upstream-connect-failed" || cause.code === "upstream-tls-failed");
      const runAuthorized = async (req: IncomingMessage, res: ServerResponse, target: URL) => {
        active++;
        const controller = new AbortController();
        controllers.add(controller);
        let finished = false;
        const cancel = () => {
          if (!finished && !res.writableEnded) controller.abort();
        };
        req.once("aborted", cancel);
        res.once("close", cancel);
        const prepared = setupBody(req, controller);
        try {
          await forwardResponse(req, res, target, controller, prepared.body);
        } catch (cause) {
          failResponse(res, cause, prepared.state.oversized, controller);
        } finally {
          finished = true;
          controllers.delete(controller);
          req.removeListener("aborted", cancel);
          res.removeListener("close", cancel);
          const timer = prepared.timer();
          if (timer) clearTimeout(timer);
          active--;
        }
      };
      const dispatch = async (req: IncomingMessage, res: ServerResponse) => {
        const authorized = authorize(req);
        if (typeof authorized === "number") return reject(res, authorized);
        const invalid = validateRequest(req);
        if (invalid !== undefined) return reject(res, invalid);
        await runAuthorized(req, res, authorized);
      };
      const handle = (req: IncomingMessage, res: ServerResponse): Effect.Effect<void, never> =>
        Effect.promise(() => dispatch(req, res)).pipe(
          Effect.asVoid,
          Effect.catch(() => Effect.void),
        );
      server = createServer((req, res) => {
        void Effect.runFork(handle(req, res));
      });
      server.maxConnections = maxConnections;
      server.on("connection", (socket) => {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
      });
      server.once("error", () => {
        if (!listening) resume(Effect.fail(failure("bind-failed")));
      });
      server.listen(0, "127.0.0.1", () => {
        listening = true;
        const address = server.address();
        if (!address || typeof address === "string") {
          resume(Effect.fail(failure("bind-failed")));
          return;
        }
        const localUrl = `http://127.0.0.1:${address.port}${upstream.pathname}${upstream.search}`;
        const stop = Effect.suspend(() => {
          if (stopped) return Effect.void;
          stopped = true;
          for (const controller of controllers) controller.abort();
          for (const socket of sockets) socket.destroy();
          return Effect.tryPromise({
            try: () => new Promise<void>((resolve) => server.close(() => resolve())),
            catch: () => failure("closed"),
          }).pipe(Effect.asVoid);
        });
        resume(
          Effect.succeed({
            localUrl,
            downstreamToken: token,
            health: Effect.sync(() => ({
              listening: listening && !stopped,
              activeRequests: active,
              localUrl,
            })),
            stop,
          }),
        );
      });
      return Effect.sync(() => {
        stopped = true;
        for (const controller of controllers) controller.abort();
        for (const socket of sockets) socket.destroy();
        server?.close();
      });
    }),
    (relay) => relay.stop.pipe(Effect.catch(() => Effect.void)),
  );
};

export const startRelay = start;
