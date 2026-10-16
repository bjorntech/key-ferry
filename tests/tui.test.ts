import { describe, expect, test } from "bun:test";
import tuiPlugin, { createCommands, formatStatus } from "../src/tui.js";

const status = { phase: "ready", generation: 2 } as const;

describe("Key Ferry TUI commands", () => {
  test("registers safe palette and slash commands", () => {
    const shown: string[] = [];
    const commands = createCommands({
      status: async () => status,
      refresh: async () => status,
      doctor: async () => status,
      show: (_title, message) => shown.push(message),
    });

    expect(commands.map((command) => command.id)).toEqual([
      "key-ferry.status",
      "key-ferry.refresh",
      "key-ferry.doctor",
    ]);
    expect(commands.every((command) => command.palette)).toBe(true);
    expect(commands.map((command) => command.slash.name)).toEqual([
      "key-ferry-status",
      "key-ferry-refresh",
      "key-ferry-doctor",
    ]);
    expect(formatStatus(status)).toContain("Generation: 2");
  });

  test("reports progress and safe RPC failures without exposing raw errors", async () => {
    const shown: string[] = [];
    const secret = "secret-token";
    const commands = createCommands({
      status: async () => {
        throw { code: "refresh_failed", message: secret };
      },
      refresh: async () => status,
      doctor: async () => status,
      show: (_title, message) => shown.push(message),
    });

    await commands[0].run();
    expect(shown[0]).toBe("Working…");
    expect(shown.at(-1)).toBe("Varlock refresh failed");
    expect(shown.join(" ")).not.toContain(secret);
  });

  test("refresh calls its operation and displays completion", async () => {
    let called = false;
    const shown: string[] = [];
    const commands = createCommands({
      status: async () => status,
      refresh: async () => {
        called = true;
        return status;
      },
      doctor: async () => status,
      show: (_title, message) => shown.push(message),
    });

    await commands[1].run();
    expect(called).toBe(true);
    expect(shown.at(-1)).toContain("Refresh completed");
  });

  test("formats error status and diagnostics without losing safe context", () => {
    const formatted = formatStatus({
      phase: "failed",
      generation: 4,
      error: { code: "timeout", message: "Varlock operation timed out", retryable: true },
      diagnostics: [
        {
          server: "remote-tools",
          code: "remote_missing_placeholder",
          message: "mapping is incomplete",
        },
      ],
    });
    expect(formatted).toContain("Varlock operation timed out (timeout)");
    expect(formatted).toContain("remote-tools: mapping is incomplete (remote_missing_placeholder)");
  });

  test("uses safe fallback text for every RPC failure shape", async () => {
    const codes = [
      "invalid_config",
      "start_failed",
      "refresh_failed",
      "timeout",
      "not_ready",
      "protocol_error",
      "disposed",
      "unknown",
    ];
    for (const code of codes) {
      const shown: string[] = [];
      const commands = createCommands({
        status: async () => {
          throw { code, message: "raw credential" };
        },
        refresh: async () => status,
        doctor: async () => status,
        show: (_title, message) => shown.push(message),
      });
      await commands[0].run();
      expect(shown.at(-1)).not.toContain("raw credential");
      expect(shown.at(-1)).toBe(
        code === "invalid_config"
          ? "Varlock configuration is invalid"
          : code === "start_failed"
            ? "Varlock could not start"
            : code === "refresh_failed"
              ? "Varlock refresh failed"
              : code === "timeout"
                ? "Varlock operation timed out"
                : code === "not_ready"
                  ? "Varlock is not ready"
                  : code === "protocol_error"
                    ? "Varlock returned an invalid response"
                    : "Varlock is unavailable",
      );
    }
  });

  test("uses the host-owned keymap layer lifecycle and calls the existing RPC", async () => {
    const layers: Array<() => { commands?: readonly unknown[] }> = [];
    const calls: string[] = [];
    const context = {
      client: {
        rpc: () => ({
          status: async () => {
            calls.push("status");
            return status;
          },
          refresh: async () => {
            calls.push("refresh");
            return status;
          },
          doctor: async () => {
            calls.push("doctor");
            return status;
          },
        }),
      },
      keymap: { layer: (factory: () => { commands?: readonly unknown[] }) => layers.push(factory) },
      ui: { toast: { show: () => undefined } },
    };

    const cleanup = await tuiPlugin.setup(context as never);
    expect(cleanup).toBeUndefined();
    expect(layers).toHaveLength(1);
    expect(layers[0]().commands).toHaveLength(3);
    expect(calls).toEqual([]);
  });

  test("passes the host toast through to command actions", async () => {
    const toasts: unknown[] = [];
    const context = {
      client: {
        rpc: () => ({
          status: async () => status,
          refresh: async () => status,
          doctor: async () => status,
        }),
      },
      keymap: {
        layer: (factory: () => { commands?: readonly any[] }) => {
          const commands = factory().commands ?? [];
          void commands[2]?.run();
        },
      },
      ui: { toast: { show: (toast: unknown) => toasts.push(toast) } },
    };
    await tuiPlugin.setup(context as never);
    await new Promise((resolve) => queueMicrotask(resolve));
    expect(toasts).toHaveLength(2);
    expect(toasts[0]).toMatchObject({ title: "Varlock doctor", variant: "info" });
    expect(toasts[1]).toMatchObject({ title: "Varlock doctor", variant: "success" });
  });
});
