import type { Rpc } from "@opencode/plugin/effect";
import { Plugin } from "@opencode/plugin/tui";
import { KeyFerryRpc } from "./rpc.js";

export interface SafeStatusView {
  readonly phase: string;
  readonly generation: number;
  readonly activation?: "auto" | "manual" | "awaiting_activation";
  readonly scopes?: readonly {
    readonly scope: "global" | "project";
    readonly phase: string;
    readonly generation: number;
    readonly activation?: "auto" | "manual" | "awaiting_activation";
    readonly diagnostics?: readonly {
      readonly server: string;
      readonly code: string;
      readonly message: string;
    }[];
    readonly error?: {
      readonly code: string;
      readonly message: string;
      readonly retryable: boolean;
    };
  }[];
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
  readonly activateProject?: () => Promise<SafeStatusView>;
  readonly refreshProject?: () => Promise<SafeStatusView>;
  readonly doctorProject?: () => Promise<SafeStatusView>;
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
  const lines = formatOverview(status);
  appendDiagnostics(lines, status.diagnostics);
  for (const scope of status.scopes ?? []) lines.push(...formatScope(scope));
  return lines.join("\n");
}

function formatOverview(status: SafeStatusView): string[] {
  return status.error
    ? [`${status.error.message} (${status.error.code})`]
    : [`State: ${status.phase}`, `Generation: ${status.generation}`];
}

function appendDiagnostics(
  lines: string[],
  diagnostics: SafeStatusView["diagnostics"],
  prefix?: string,
) {
  for (const item of diagnostics ?? [])
    lines.push(`${prefix ? `${prefix}/` : ""}${item.server}: ${item.message} (${item.code})`);
}

function formatScope(scope: NonNullable<SafeStatusView["scopes"]>[number]): string[] {
  const lines = [formatScopeHeader(scope)];
  appendScopeError(lines, scope);
  appendDiagnostics(lines, scope.diagnostics, scope.scope);
  return lines;
}

function formatScopeHeader(scope: NonNullable<SafeStatusView["scopes"]>[number]): string {
  const activation = scope.activation ? `, ${scope.activation}` : "";
  return `${scope.scope}: ${scope.phase} (generation ${scope.generation}${activation})`;
}

function appendScopeError(
  lines: string[],
  scope: NonNullable<SafeStatusView["scopes"]>[number],
): void {
  if (scope.error) lines.push(`${scope.scope}: ${scope.error.message} (${scope.error.code})`);
}

type CommandOperation =
  | "status"
  | "refresh"
  | "doctor"
  | "activateProject"
  | "refreshProject"
  | "doctorProject";

type CommandSpec = {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly slashName: string;
  readonly alias: string;
  readonly toastTitle: string;
  readonly success: string;
  readonly operation: CommandOperation;
};

const commandSpecs: readonly CommandSpec[] = [
  {
    id: "key-ferry.status",
    title: "Key Ferry: Status",
    description: "Show safe Key Ferry sidecar state",
    slashName: "key-ferry-status",
    alias: "vstatus",
    toastTitle: "Varlock status",
    success: "Status loaded",
    operation: "status",
  },
  {
    id: "key-ferry.refresh",
    title: "Key Ferry: Refresh",
    description: "Refresh the protected project environment",
    slashName: "key-ferry-refresh",
    alias: "vrefresh",
    toastTitle: "Varlock refresh",
    success: "Refresh completed",
    operation: "refresh",
  },
  {
    id: "key-ferry.doctor",
    title: "Key Ferry: Doctor",
    description: "Check Varlock readiness and protected connections",
    slashName: "key-ferry-doctor",
    alias: "vdoctor",
    toastTitle: "Varlock doctor",
    success: "Check completed",
    operation: "doctor",
  },
  {
    id: "key-ferry.project.activate",
    title: "Key Ferry: Activate Project",
    description: "Activate the protected project environment",
    slashName: "key-ferry-project-activate",
    alias: "vproject-activate",
    toastTitle: "Varlock project activation",
    success: "Project activation completed",
    operation: "activateProject",
  },
  {
    id: "key-ferry.project.refresh",
    title: "Key Ferry: Refresh Project",
    description: "Refresh the protected project environment",
    slashName: "key-ferry-project-refresh",
    alias: "vproject-refresh",
    toastTitle: "Varlock project refresh",
    success: "Project refresh completed",
    operation: "refreshProject",
  },
  {
    id: "key-ferry.project.doctor",
    title: "Key Ferry: Doctor Project",
    description: "Check project Varlock readiness",
    slashName: "key-ferry-project-doctor",
    alias: "vproject-doctor",
    toastTitle: "Varlock project doctor",
    success: "Project check completed",
    operation: "doctorProject",
  },
];

const unavailable = async (): Promise<SafeStatusView> => {
  throw { code: "unavailable" };
};

function runCommand(
  actions: TuiActions,
  title: string,
  operation: () => Promise<SafeStatusView>,
  success: string,
) {
  return async () => {
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
}

function createCommand(spec: (typeof commandSpecs)[number], actions: TuiActions) {
  const operation = actions[spec.operation] ?? unavailable;
  return {
    id: spec.id,
    title: spec.title,
    description: spec.description,
    group: "Varlock",
    palette: true as const,
    slash: { name: spec.slashName, aliases: [spec.alias] as string[] },
    run: runCommand(actions, spec.toastTitle, operation, spec.success),
  };
}

export function createCommands(actions: TuiActions) {
  return commandSpecs.map((spec) => createCommand(spec, actions));
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
        activateProject: () => rpc.activateProject({}) as Promise<SafeStatusView>,
        refreshProject: () => rpc.refresh({ scope: "project" }) as Promise<SafeStatusView>,
        doctorProject: () => rpc.doctor({ scope: "project" }) as Promise<SafeStatusView>,
        show,
      }),
    }));
  },
});
