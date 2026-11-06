import { Effect } from "effect";
import { installHostShutdownHooks, removeHostShutdownHooks } from "../../src/broker-registry.js";

const mode = process.argv[2] ?? "normal-int";
const signal = mode.includes("term") ? "SIGTERM" : "SIGINT";

const cleanup =
  mode === "hang" || mode === "slow-second"
    ? Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            console.log("CLEANUP");
            if (mode === "slow-second") void resolve;
          }),
      )
    : Effect.sync(() => console.log("CLEANUP"));

if (mode === "foreign-int") {
  process.on("SIGINT", () => console.log("FOREIGN"));
}

// The module's production singleton installs its own hooks at import time.
// Replace those hooks so this fixture can exercise the exported installer directly.
removeHostShutdownHooks();
installHostShutdownHooks(cleanup, process, {
  cleanupTimeoutMs:
    mode === "normal-int" || mode === "normal-term" || mode === "foreign-int" ? 1_000 : 200,
});
console.log("READY");

// Keep the fixture alive in the foreign-listener case and while testing a slow cleanup.
setInterval(() => undefined, 1_000);

void signal;
