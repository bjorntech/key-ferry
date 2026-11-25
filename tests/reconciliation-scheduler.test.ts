import { expect, test } from "bun:test";
import { createReconciliationScheduler } from "../src/varlock/manager.js";

test("reconciliation scheduler coalesces runs and stops after disposal", async () => {
  let runs = 0;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const scheduler = createReconciliationScheduler(async () => {
    runs++;
    await pending;
  }, 5);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(runs).toBe(1);
  release();
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(runs).toBeGreaterThanOrEqual(2);
  scheduler.stop();
  const stoppedAt = runs;
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(runs).toBe(stoppedAt);
  scheduler.stop();
});
