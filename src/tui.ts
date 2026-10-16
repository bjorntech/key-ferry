import type { Rpc } from "@opencode/plugin/effect";
import { Plugin } from "@opencode/plugin/tui";
import { KeyFerryRpc } from "./rpc.js";

export interface SafeStatusView {
  readonly phase: string;
  readonly generation: number;
  readonly diagnostics?: readonly {
    readonly server: string;
    readonly code: string;
    readonly message: string;
  }[];
  readonly error?: { readonly code: string; readonly message: string; readonly retryable: boolean };
}

export interface TuiActions {
  readonly status: () => Promise<SafeStatusView>;
  readonly refresh: () => Promise<SafeStatusView>;
  readonly doctor: () => Promise<SafeStatusView>;
  readonly show: (
    title: string,
    message: string,
    variant: "info" | "success" | "warning" | "error",
  ) => void;
}

const errorMessage = (error: unknown) => {
  if (typeof error !== "object" || error === null) return "Varlock is unavailable";
  const code = "code" in error && typeof error.code === "string" ? error.code : "unavailable";
  switch (code) {
    case "invalid_config":
      return "Varlock configuration is invalid";
    case "start_failed":
      return "Varlock could not start";
    case "refresh_failed":
      return "Varlock refresh failed";
    case "timeout":
      return "Varlock operation timed out";
    case "not_ready":
      return "Varlock is not ready";
    case "protocol_error":
      return "Varlock returned an invalid response";
    default:
      return "Varlock is unavailable";
  }
};

export function formatStatus(status: SafeStatusView): string {
  const lines = status.error
    ? [`${status.error.message} (${status.error.code})`]
    : [`State: ${status.phase}`, `Generation: ${status.generation}`];
  for (const item of status.diagnostics ?? [])
    lines.push(`${item.server}: ${item.message} (${item.code})`);
  return lines.join("\n");
}

export function createCommands(actions: TuiActions) {
  const run =
    (title: string, operation: () => Promise<SafeStatusView>, success: string) => async () => {
      actions.show(title, "Working…", "info");
      try {
        const status = await operation();
        actions.show(
          title,
          `${success}\n\n${formatStatus(status)}`,
          status.error ? "warning" : "success",
        );
      } catch (error) {
        actions.show(title, errorMessage(error), "error");
      }
    };

  return [
    {
      id: "key-ferry.status",
      title: "Key Ferry: Status",
      description: "Show safe Key Ferry sidecar state",
      group: "Varlock",
      palette: true as const,
      slash: { name: "key-ferry-status", aliases: ["vstatus"] as string[] },
      run: run("Varlock status", actions.status, "Status loaded"),
    },
    {
      id: "key-ferry.refresh",
      title: "Key Ferry: Refresh",
      description: "Refresh the protected project environment",
      group: "Varlock",
      palette: true as const,
      slash: { name: "key-ferry-refresh", aliases: ["vrefresh"] as string[] },
      run: run("Varlock refresh", actions.refresh, "Refresh completed"),
    },
    {
      id: "key-ferry.doctor",
      title: "Key Ferry: Doctor",
      description: "Check Varlock readiness and protected connections",
      group: "Varlock",
      palette: true as const,
      slash: { name: "key-ferry-doctor", aliases: ["vdoctor"] as string[] },
      run: run("Varlock doctor", actions.doctor, "Check completed"),
    },
  ] as const;
}

export default Plugin.define({
  id: "key-ferry.tui",
  setup(context) {
    // The server RPC uses Effect Schema. The generated Promise client exposes
    // the same validated wire contract, but its declaration only admits
    // PortableDefinition, so this boundary is typed at the safe response.
    const rpc = context.client.rpc(KeyFerryRpc as unknown as Rpc.PortableDefinition);
    const show = (
      title: string,
      message: string,
      variant: "info" | "success" | "warning" | "error",
    ) => context.ui.toast.show({ title, message, variant });

    context.keymap.layer(() => ({
      mode: "global",
      priority: 20,
      commands: createCommands({
        status: () => rpc.status({}) as Promise<SafeStatusView>,
        refresh: () => rpc.refresh({}) as Promise<SafeStatusView>,
        doctor: () => rpc.doctor({}) as Promise<SafeStatusView>,
        show,
      }),
    }));
  },
});
