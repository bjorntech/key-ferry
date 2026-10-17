import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, Scope } from "effect";
import { makeBrokerRegistry } from "../src/broker-registry.js";
import {
  ProjectKeyFerryManager,
  projectDirectory,
  type ProjectKeyFerryManagerFactory,
} from "../src/contracts.js";
import { loadScopedConfiguration } from "../src/scoped-config.js";
import { makeScopedController } from "../src/scoped-controller.js";

const editorFor = (entries: Record<string, any>) => {
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
};

test("watcher restarts a project when only its canonical root changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "key-ferry-review-"));
  const subA = await realpath(
    await mkdir(join(root, "subA"), { recursive: true }).then(() => join(root, "subA")),
  );
  const subB = await realpath(
    await mkdir(join(root, "subB"), { recursive: true }).then(() => join(root, "subB")),
  );
  const source = (directory: string) =>
    `{"enabled":true,"activation":"auto","projectDirectory":"${directory}","servers":{"project":{"env":["P"]}}}`;
  const read = {
    readFile: async () => source("subA"),
    realpath: async (path: string) => realpath(path),
  };
  const config = await loadScopedConfiguration(
    { projectConfig: { enabled: true, activation: "auto" }, servers: { global: { env: ["G"] } } },
    { project: { directory: root } },
    read,
  );
  const started: string[] = [];
  const disposed: string[] = [];
  const factory: ProjectKeyFerryManagerFactory = {
    layer: (options) => {
      const directory = String(options.projectDirectory);
      started.push(directory);
      const service = {
        status: Effect.succeed({
          phase: "starting" as const,
          projectDirectory: projectDirectory(directory),
          generation: 0,
        }),
        ensureStarted: Effect.succeed({
          phase: "starting" as const,
          projectDirectory: projectDirectory(directory),
          generation: 0,
        }),
        ensureReady: Effect.succeed({
          status: {
            phase: "ready" as const,
            projectDirectory: projectDirectory(directory),
            generation: 1,
          },
          environment: { P: directory, G: "global" },
        }),
        environment: Effect.succeed({ P: directory, G: "global" }),
        refresh: Effect.succeed({
          phase: "ready" as const,
          projectDirectory: projectDirectory(directory),
          generation: 1,
        }),
        refreshReady: Effect.succeed({
          status: {
            phase: "ready" as const,
            projectDirectory: projectDirectory(directory),
            generation: 2,
          },
          environment: { P: directory, G: "global" },
        }),
        dispose: Effect.sync(() => {
          disposed.push(directory);
        }),
        withExclusive: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
      };
      return Layer.succeed(ProjectKeyFerryManager, service);
    },
  };
  const editor = editorFor({
    global: { type: "local", command: ["global"] },
    project: { type: "local", command: ["project"] },
  });
  const scope = Effect.runSync(Scope.make());
  const controller = makeScopedController({
    configuration: config,
    factory,
    registry: makeBrokerRegistry({ canonicalize: (path) => Effect.succeed(path) }),
    scope,
    reload: () => Effect.void,
    editor: editor.editor,
    watchIntervalMs: 1,
  });
  let next = false;
  try {
    controller.capture(editor.editor);
    await Effect.runPromise(controller.start);
    await new Promise((resolve) => setImmediate(resolve));
    const watcher = await Effect.runPromise(
      controller
        .watch(() => {
          next = true;
          return loadScopedConfiguration(
            {
              projectConfig: { enabled: true, activation: "auto" },
              servers: { global: { env: ["G"] } },
            },
            { project: { directory: root } },
            {
              readFile: async () => source("subB"),
              realpath: async (path: string) => realpath(path),
            },
          );
        })
        .pipe(Effect.asVoid),
    );
    void watcher;
    for (
      let i = 0;
      i < 100 &&
      (editor.values.get("project")?.environment?.P !== subB ||
        editor.values.get("project")?.disabled === true);
      i++
    )
      await new Promise((resolve) => setTimeout(resolve, 2));
    expect(next).toBe(true);
    expect(started).toContain(subA);
    expect(started).toContain(subB);
    expect(disposed).toContain(subA);
    controller.apply(editor.editor);
    expect(editor.values.get("project")?.environment?.P).toBe(subB);
    expect(editor.values.get("project")?.environment?.P).not.toBe(subA);
    expect(editor.values.get("project")?.disabled).not.toBe(true);
    expect(editor.values.get("global")?.disabled).not.toBe(true);
    expect(started.filter((item) => item === started[0]).length).toBe(1);
  } finally {
    await Effect.runPromise(controller.dispose);
    await Scope.close(scope, { _tag: "Success", value: undefined } as never);
    await rm(root, { recursive: true, force: true });
  }
});
