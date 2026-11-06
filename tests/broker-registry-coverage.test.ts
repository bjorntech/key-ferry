import { test } from "bun:test";
import assert from "node:assert/strict";
import { Effect } from "effect";
import {
  installHostShutdownHooks,
  removeHostShutdownHooks,
  type HostSignalProcess,
} from "../src/broker-registry.js";

function fakeProcess(): {
  process: HostSignalProcess;
  handlers: Map<string, Array<(...args: any[]) => void>>;
  kills: string[];
} {
  const handlers = new Map<string, Array<(...args: any[]) => void>>();
  const kills: string[] = [];
  const process: HostSignalProcess = {
    pid: 123,
    on: (event, listener) => {
      const current = handlers.get(event) ?? [];
      current.push(listener);
      handlers.set(event, current);
    },
    removeListener: (event, listener) => {
      handlers.set(
        event,
        (handlers.get(event) ?? []).filter((candidate) => candidate !== listener),
      );
    },
    listeners: (event) => handlers.get(event) ?? [],
    kill: (_pid, signal) => {
      kills.push(signal);
    },
  };
  return { process, handlers, kills };
}

test("host shutdown hooks re-raise after cleanup and preserve foreign listeners", async () => {
  removeHostShutdownHooks();
  const first = fakeProcess();
  const foreign = () => undefined;
  first.process.on("SIGINT", foreign);
  installHostShutdownHooks(
    Effect.sync(() => undefined),
    first.process,
    { cleanupTimeoutMs: 20 },
  );
  first.handlers.get("SIGINT")?.at(-1)?.();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(first.kills, []);
  removeHostShutdownHooks();

  const second = fakeProcess();
  installHostShutdownHooks(Effect.never, second.process, { cleanupTimeoutMs: 1 });
  const handler = second.handlers.get("SIGINT")?.at(-1);
  assert.ok(handler);
  handler();
  handler();
  assert.deepEqual(second.kills, ["SIGINT"]);
  removeHostShutdownHooks();
});
