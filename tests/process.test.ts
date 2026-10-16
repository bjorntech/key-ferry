import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Exit, Fiber } from "effect";
import { Process, ProcessLive } from "../src/services/process";

const run = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runPromise(effect.pipe(Effect.provide(ProcessLive)));
const node = process.execPath;

const waitForPidExit = async (pid: number, timeoutMs = 2000): Promise<boolean> => {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await Bun.sleep(10);
  }
  return false;
};

describe("Process", () => {
  it("executes without a shell and preserves cwd and argv", async () => {
    const result = await run(
      Effect.gen(function* () {
        const service = yield* Process;
        return yield* service.run({
          executable: node,
          args: [
            "-e",
            "process.stdout.write(JSON.stringify({cwd:process.cwd(), args:process.argv.slice(1)}))",
            "marker",
            "two words",
          ],
          cwd: process.cwd(),
        });
      }),
    );
    const parsed = JSON.parse(result.stdout) as { cwd: string; args: string[] };
    expect(parsed.cwd).toBe(process.cwd());
    expect(parsed.args).toEqual(["marker", "two words"]);
  });

  it("does not inherit the parent environment when env is omitted", async () => {
    const key = "OPENCODE_VARLOCK_PROCESS_TEST_PARENT_SECRET";
    const previous = process.env[key];
    process.env[key] = "parent-secret-canary";
    try {
      const result = await run(
        Effect.gen(function* () {
          const service = yield* Process;
          return yield* service.run({
            executable: node,
            args: ["-e", `process.stdout.write(process.env[${JSON.stringify(key)}] ?? "missing")`],
            cwd: process.cwd(),
          });
        }),
      );
      expect(result.stdout).toBe("missing");
    } finally {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  });

  it("uses an explicitly supplied environment exactly", async () => {
    const result = await run(
      Effect.gen(function* () {
        const service = yield* Process;
        return yield* service.run({
          executable: node,
          args: [
            "-e",
            "process.stdout.write(process.env.OPENCODE_VARLOCK_PROCESS_TEST_EXPLICIT ?? 'missing')",
          ],
          cwd: process.cwd(),
          env: { OPENCODE_VARLOCK_PROCESS_TEST_EXPLICIT: "explicit-canary" },
        });
      }),
    );
    expect(result.stdout).toBe("explicit-canary");
  });

  it("sanitizes non-zero and spawn errors", async () => {
    const failed = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const service = yield* Process;
        return yield* service.run({
          executable: node,
          args: ["-e", "process.stderr.write('secret'); process.exit(7)"],
          cwd: process.cwd(),
        });
      }).pipe(Effect.provide(ProcessLive)),
    );
    expect(Exit.isFailure(failed)).toBe(true);
    if (Exit.isFailure(failed)) {
      const cause = failed.cause;
      expect(String(cause)).not.toContain("secret");
      expect(String(cause)).not.toContain(node);
    }

    const spawnFailed = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const service = yield* Process;
        return yield* service.run({
          executable: "/definitely/missing/key-ferry-test",
          args: [],
          cwd: process.cwd(),
        });
      }).pipe(Effect.provide(ProcessLive)),
    );
    expect(Exit.isFailure(spawnFailed)).toBe(true);
    expect(String(spawnFailed)).not.toContain("definitely");
  });

  it("exposes health before and after managed-process completion", async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* Process;
          const child = yield* service.spawn({
            executable: node,
            args: ["-e", "setTimeout(() => {}, 40)"],
            cwd: process.cwd(),
          });
          const before = yield* child.health;
          const completion = yield* child.completion;
          const after = yield* child.health;
          return { before, completion, after };
        }).pipe(Effect.provide(ProcessLive)),
      ),
    );
    expect(result.before.running).toBe(true);
    expect(result.before.exit).toBeUndefined();
    expect(result.completion).toEqual({ code: 0, signal: null });
    expect(result.after.running).toBe(false);
    expect(result.after.exit).toEqual({ code: 0, signal: null });
  });

  it("uses SIGKILL after a managed child ignores SIGTERM", async () => {
    let pid: number | undefined;
    const started = performance.now();
    const result = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* Process;
          const child = yield* service.spawn({
            executable: node,
            args: ["-e", "process.on('SIGTERM', () => {}); process.kill(process.pid, 'SIGSTOP')"],
            cwd: process.cwd(),
            terminateGraceMs: 100,
          });
          pid = child.pid;
          yield* child.stop;
        }).pipe(Effect.provide(ProcessLive)),
      ),
    );
    expect(Exit.isSuccess(result)).toBe(true);
    expect(performance.now() - started).toBeLessThan(2000);
    if (pid !== undefined) {
      expect(await waitForPidExit(pid)).toBe(true);
    }
  });

  it("waits for an already-exited child before completing stop", async () => {
    const result = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* Process;
          const child = yield* service.spawn({
            executable: node,
            args: ["-e", "process.exit(0)"],
            cwd: process.cwd(),
          });
          yield* Effect.sleep("50 millis");
          yield* child.stop;
        }).pipe(Effect.provide(ProcessLive)),
      ),
    );
    expect(Exit.isSuccess(result)).toBe(true);
  });

  it("bounds capture for stdout and stderr", async () => {
    const result = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const service = yield* Process;
        return yield* service.run({
          executable: node,
          args: [
            "-e",
            "process.stdout.write('x'.repeat(10000)); process.stderr.write('y'.repeat(10000))",
          ],
          cwd: process.cwd(),
          maxBytes: 128,
        });
      }).pipe(Effect.provide(ProcessLive)),
    );
    expect(Exit.isFailure(result)).toBe(true);
    expect(String(result)).not.toContain("x".repeat(100));
  });

  it("forces SIGKILL when a capture-limited child ignores SIGTERM", async () => {
    const started = performance.now();
    const result = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const service = yield* Process;
        return yield* service.run({
          executable: node,
          args: [
            "-e",
            "process.on('SIGTERM', () => {}); process.stdout.write('x'.repeat(10000), () => process.kill(process.pid, 'SIGSTOP'))",
          ],
          cwd: process.cwd(),
          maxBytes: 128,
        });
      }).pipe(Effect.provide(ProcessLive)),
    );
    expect(Exit.isFailure(result)).toBe(true);
    expect(String(result)).not.toContain("x".repeat(100));
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it("terminates an interrupted run instead of orphaning its child", async () => {
    const directory = mkdtempSync(join(tmpdir(), "key-ferry-process-"));
    const pidFile = join(directory, "pid");
    try {
      const result = await Effect.runPromiseExit(
        Effect.scoped(
          Effect.gen(function* () {
            const service = yield* Process;
            const running = yield* Effect.forkScoped(
              service.run({
                executable: node,
                args: [
                  "-e",
                  `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.on('SIGTERM', () => {}); process.kill(process.pid, 'SIGSTOP')`,
                ],
                cwd: process.cwd(),
              }),
            );
            while (true) {
              try {
                readFileSync(pidFile);
                break;
              } catch {
                yield* Effect.sleep("10 millis");
              }
            }
            yield* Fiber.interrupt(running);
          }).pipe(Effect.provide(ProcessLive)),
        ),
      );
      expect(Exit.isSuccess(result)).toBe(true);
      const pid = Number(readFileSync(pidFile, "utf8"));
      expect(await waitForPidExit(pid)).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("times out and terminates the child", async () => {
    const started = performance.now();
    const result = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const service = yield* Process;
        return yield* service.run({
          executable: node,
          args: ["-e", "setInterval(() => {}, 1000)"],
          cwd: process.cwd(),
          timeoutMs: 80,
        });
      }).pipe(Effect.provide(ProcessLive)),
    );
    expect(Exit.isFailure(result)).toBe(true);
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it("does not orphan a SIGTERM-ignoring child when stop is interrupted", async () => {
    let pid: number | undefined;
    const result = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* Process;
          const child = yield* service.spawn({
            executable: node,
            args: ["-e", "process.on('SIGTERM', () => {}); process.kill(process.pid, 'SIGSTOP')"],
            cwd: process.cwd(),
            terminateGraceMs: 100,
          });
          pid = child.pid;
          // Request interruption while the bounded stop is in its grace period.
          // The request must not cancel the SIGKILL fallback.
          const stopping = yield* Effect.forkScoped(child.stop);
          yield* Effect.sleep("10 millis");
          yield* Fiber.interrupt(stopping);
        }).pipe(Effect.provide(ProcessLive)),
      ),
    );
    expect(Exit.isSuccess(result)).toBe(true);
    if (pid !== undefined) {
      expect(await waitForPidExit(pid)).toBe(true);
    }
  });

  it("stops a scoped process when its scope closes", async () => {
    const result = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* Process;
          const child = yield* service.spawn({
            executable: node,
            args: ["-e", "setInterval(() => {}, 1000)"],
            cwd: process.cwd(),
            terminateGraceMs: 50,
          });
          return child.pid;
        }).pipe(Effect.provide(ProcessLive)),
      ),
    );
    expect(Exit.isSuccess(result)).toBe(true);
    if (Exit.isSuccess(result)) {
      expect(await waitForPidExit(result.value)).toBe(true);
    }
  });
});
