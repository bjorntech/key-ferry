import { test } from "bun:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const fixture = fileURLToPath(new URL("./fixtures/signal-reraise-fixture.ts", import.meta.url));
const bun = process.execPath;

type Child = ReturnType<typeof spawn>;

function start(mode: string): { child: Child; output: () => string } {
  const child = spawn(bun, ["run", fixture, mode], { stdio: ["ignore", "pipe", "pipe"] });
  let text = "";
  child.stdout.on("data", (chunk) => (text += String(chunk)));
  child.stderr.on("data", (chunk) => (text += String(chunk)));
  return { child, output: () => text };
}

async function waitFor(
  child: Child,
  output: () => string,
  marker: string,
  timeoutMs = 2_000,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let poll: ReturnType<typeof setInterval> | undefined;
    const finish = (callback: () => void) => {
      clearTimeout(deadline);
      if (poll) clearInterval(poll);
      child.removeListener("exit", onExit);
      callback();
    };
    const onExit = () =>
      finish(() =>
        reject(new Error(`child exited while waiting for ${marker}; output: ${output()}`)),
      );
    const deadline = setTimeout(() => {
      finish(() => reject(new Error(`timed out waiting for ${marker}; output: ${output()}`)));
    }, timeoutMs);
    poll = setInterval(() => {
      if (output().includes(marker)) {
        finish(resolve);
      }
    }, 10);
    child.once("exit", onExit);
  });
}

function exited(child: Child): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
}

async function reap(child: Child): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGKILL");
  await Promise.race([exited(child), new Promise<void>((resolve) => setTimeout(resolve, 2_000))]);
}

async function signalAndExit(mode: string, signal: NodeJS.Signals, code: number) {
  const { child, output } = start(mode);
  try {
    await waitFor(child, output, "READY", 10_000);
    child.kill(signal);
    const result = await exited(child);
    await waitFor(child, output, "CLEANUP", 10_000);
    assert.ok(
      result.signal === signal || result.code === code,
      `${mode}: ${JSON.stringify(result)}\n${output()}`,
    );
  } finally {
    await reap(child);
  }
}

test("SIGINT cleanup is re-raised", async () => signalAndExit("normal-int", "SIGINT", 130));
test("SIGTERM cleanup is re-raised", async () => signalAndExit("normal-term", "SIGTERM", 143));

test("foreign SIGINT listener is preserved and not re-raised", async () => {
  const { child, output } = start("foreign-int");
  try {
    await waitFor(child, output, "READY", 10_000);
    child.kill("SIGINT");
    await waitFor(child, output, "CLEANUP", 10_000);
    await waitFor(child, output, "FOREIGN", 10_000);
    assert.equal(child.exitCode, null, output());
    child.kill("SIGKILL");
    const result = await exited(child);
    assert.equal(result.signal, "SIGKILL");
  } finally {
    await reap(child);
  }
});

test("a hanging cleanup is bounded before SIGINT is re-raised", async () => {
  await signalAndExit("hang", "SIGINT", 130);
});

test("a second SIGINT re-raises promptly during cleanup", async () => {
  const { child, output } = start("slow-second");
  try {
    await waitFor(child, output, "READY", 10_000);
    const started = Date.now();
    child.kill("SIGINT");
    await waitFor(child, output, "CLEANUP", 10_000);
    child.kill("SIGINT");
    const result = await exited(child);
    assert.ok(Date.now() - started < 2_000, `${JSON.stringify(result)}\n${output()}`);
    assert.ok(result.signal === "SIGINT" || result.code === 130);
  } finally {
    await reap(child);
  }
});
