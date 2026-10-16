import { describe, expect, test } from "bun:test";
import { managerOptions, parseOptions } from "../src/options.js";

describe("plugin options", () => {
  test("uses safe defaults and normalizes allowlists", () => {
    const result = parseOptions(
      {
        servers: {
          tools: { env: { API_KEY: "VARLOCK_API_KEY" } },
          docs: { env: ["DOCS_TOKEN"] },
        },
      },
      "/project",
    );

    expect(result.enabled).toBe(true);
    expect(result.projectDirectory).toBe("/project");
    expect(result.adapter.command).toEqual(["varlock"]);
    expect(result.adapter.requireStrictEgress).toBe(true);
    expect(result.adapter.allowPrivateNetwork).toBe(false);
    expect(result.adapter.reloadTimeoutMs).toBe(30_000);
    expect(result.adapter.servers.tools).toEqual({ API_KEY: "VARLOCK_API_KEY" });
    expect(result.adapter.servers.docs).toEqual({ DOCS_TOKEN: "DOCS_TOKEN" });
  });

  test("disabled is explicit and does not invent a manager configuration", () => {
    const result = parseOptions({ enabled: false }, "/project");
    expect(result.enabled).toBe(false);
    expect(result.adapter.servers).toEqual({});
  });

  test("rejects unbounded or malformed configuration", () => {
    expect(() => parseOptions({ refreshTimeoutMs: 900_001 })).toThrow();
    expect(() => parseOptions({ servers: { tools: { env: [] } } })).toThrow();
    expect(() => parseOptions({ command: [] })).toThrow();
    expect(() => parseOptions({ failClosed: false })).toThrow();
    expect(() => parseOptions({ failClosed: 0 })).toThrow();
    expect(() => parseOptions({ enabled: "false" })).toThrow();
    expect(() => parseOptions({ requireStrictEgress: "false" })).toThrow();
    expect(() => parseOptions(JSON.parse('{"servers":{"__proto__":{"env":["TOKEN"]}}}'))).toThrow();
    expect(() =>
      parseOptions(JSON.parse('{"servers":{"safe":{"env":{"__proto__":"TOKEN"}}}}')),
    ).toThrow();
  });

  test("resolves a configured relative project directory against the OpenCode project", () => {
    expect(parseOptions({ projectDirectory: "." }, "/project").projectDirectory).toBe("/project");
    expect(
      parseOptions({ projectDirectory: "folder with spaces" }, "/project").projectDirectory,
    ).toBe("/project/folder with spaces");
    expect(() => parseOptions({ projectDirectory: "" }, "/project")).toThrow(
      "projectDirectory must be a non-empty path",
    );
    expect(() => parseOptions({ projectDirectory: "   \t" }, "/project")).toThrow(
      "projectDirectory must be a non-empty path",
    );
  });

  test("normalizes remote header mappings and includes every source key", () => {
    const result = parseOptions(
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
    expect(result.adapter.servers.remote).toEqual({
      remote: {
        headers: {
          Authorization: { env: "REMOTE_API_KEY", prefix: "Bearer " },
          "X-Tenant": "REMOTE_TENANT",
        },
      },
    });
    expect(managerKeys(result)).toEqual(["REMOTE_API_KEY", "REMOTE_TENANT"]);
  });

  test("rejects raw values, duplicate/control headers, and malformed remote options", () => {
    expect(() =>
      parseOptions({
        servers: { r: { remote: { headers: { Authorization: "raw-secret-value" } } } },
      }),
    ).toThrow();
    expect(() =>
      parseOptions({
        servers: { r: { remote: { headers: { Authorization: { env: "KEY", prefix: "bad\n" } } } } },
      }),
    ).toThrow();
    expect(() =>
      parseOptions({
        servers: { r: { remote: { headers: { Authorization: "KEY", authorization: "OTHER" } } } },
      }),
    ).toThrow();
    expect(() =>
      parseOptions({ servers: { r: { remote: { headers: { Host: "KEY" } } } } }),
    ).toThrow();
    expect(() =>
      parseOptions({
        servers: { r: { env: ["KEY"], remote: { headers: { Authorization: "KEY" } } } },
      }),
    ).toThrow();
    expect(() => parseOptions({ allowPrivateNetwork: "yes" })).toThrow();
  });
});

function managerKeys(result: ReturnType<typeof parseOptions>): string[] {
  const adapter = managerOptions(result, "/project").adapter as {
    readonly environmentKeys?: readonly string[];
  };
  return [...(adapter.environmentKeys ?? [])];
}
