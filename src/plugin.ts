import { Mcp, Plugin } from "@opencode/plugin/effect";
import { Deferred, Effect, Types } from "effect";
import { brokerRegistry, type BrokerRegistry } from "./broker-registry.js";
import type {
  ProjectKeyFerryManagerFactory,
  ResolvedEnvironment,
  SafeStatus,
} from "./contracts.js";
import { parseOptions, type ServerProtection, type ValidatedOptions } from "./options.js";
import {
  makeRemoteRelayCoordinator,
  RELAY_AUTH_HEADER,
  safeForwardHeaders,
  isRemoteProtection,
  type RemoteRelayFactory,
  type RemoteRelayHandle,
} from "./remote.js";
import { KeyFerryRpc, publicMessage, rpcError, sanitizeStatus } from "./rpc.js";
import { loadScopedConfiguration } from "./scoped-config.js";
import { makeScopedController } from "./scoped-controller.js";

export interface McpEditor {
  list(): readonly [string, Types.DeepMutable<Mcp.ServerConfig>][];
  get(name: string): Types.DeepMutable<Mcp.ServerConfig> | undefined;
  update(name: string, update: (config: Types.DeepMutable<Mcp.ServerConfig>) => void): void;
}

export interface ProtectionState {
  readonly ready: boolean;
  readonly environment: ResolvedEnvironment;
  readonly remoteHandles?: ReadonlyMap<string, RemoteRelayHandle>;
  readonly explicitlyDisabled?: ReadonlySet<string>;
}

export interface ManagedEnvironmentState {
  readonly original: Readonly<Record<string, string | undefined>>;
  readonly injected: Readonly<Record<string, string>>;
}

function preserveDisabled(name: string, server: Mcp.ServerConfig, state: ProtectionState): boolean {
  return state.explicitlyDisabled?.has(name) ?? server.disabled === true;
}

function disableConfig(config: Types.DeepMutable<Mcp.ServerConfig>): void {
  config.disabled = true;
}

function remoteCanBeProtected(
  config: Types.DeepMutable<Mcp.ServerConfig>,
  state: ProtectionState,
  handle: RemoteRelayHandle | undefined,
): boolean {
  return config.type === "remote" && config.oauth === false && state.ready && handle !== undefined;
}

function updateRemoteConfig(
  config: Types.DeepMutable<Mcp.ServerConfig>,
  mapping: Extract<ServerProtection, { remote: unknown }>,
  state: ProtectionState,
  handle: RemoteRelayHandle,
  name: string,
  server: Types.DeepMutable<Mcp.ServerConfig>,
): void {
  if (!remoteCanBeProtected(config, state, handle)) {
    disableConfig(config);
    return;
  }
  const remote = config as Extract<Types.DeepMutable<Mcp.ServerConfig>, { type: "remote" }>;
  const headers = safeForwardHeaders(remote.headers, mapping);
  if (headers === undefined) {
    disableConfig(config);
    return;
  }
  remote.url = handle.localUrl;
  remote.headers = { ...headers, [RELAY_AUTH_HEADER]: handle.downstreamToken };
  if (!preserveDisabled(name, server, state)) config.disabled = false;
}

function applyRemoteProtection(
  editor: McpEditor,
  name: string,
  server: Types.DeepMutable<Mcp.ServerConfig>,
  mapping: Extract<ServerProtection, { remote: unknown }>,
  state: ProtectionState,
): void {
  const handle = state.remoteHandles?.get(name);
  editor.update(name, (config) =>
    handle === undefined
      ? disableConfig(config)
      : updateRemoteConfig(config, mapping, state, handle, name, server),
  );
}

function applyLocalProtection(
  editor: McpEditor,
  name: string,
  server: Types.DeepMutable<Mcp.ServerConfig>,
  mapping: Record<string, string>,
  state: ProtectionState,
): void {
  const resolved: Record<string, string> = Object.create(null) as Record<string, string>;
  let complete = state.ready;
  for (const [outputName, sourceName] of Object.entries(mapping)) {
    const value = state.environment[sourceName];
    if (value === undefined) complete = false;
    else resolved[outputName] = value;
  }
  editor.update(name, (config) => {
    if (config.type !== "local" || !complete) {
      disableConfig(config);
      return;
    }
    config.environment = { ...(config.environment ?? {}), ...resolved };
    if (!preserveDisabled(name, server, state)) config.disabled = false;
  });
}

/**
 * Apply only explicitly configured local protections. A selected remote
 * server, missing key, or unavailable manager is disabled rather than falling
 * back to direct transport.
 */
export function applyProtection(
  editor: McpEditor,
  options: ValidatedOptions["adapter"],
  state: ProtectionState,
): void {
  for (const [name, mapping] of Object.entries(options.servers)) {
    const server = editor.get(name);
    if (!server) continue;
    if (isRemoteProtection(mapping)) {
      applyRemoteProtection(editor, name, server, mapping, state);
      continue;
    }
    if (server.type !== "local") {
      editor.update(name, disableConfig);
      continue;
    }
    applyLocalProtection(editor, name, server, mapping, state);
  }
}

export type HealthPollDecision = "noop" | "clear" | "reconcile";

function unavailableHealthDecision(ready: boolean, remoteHandleCount: number): HealthPollDecision {
  if (ready) return "clear";
  if (remoteHandleCount > 0) return "clear";
  return "noop";
}

function readyHealthDecision(
  ready: boolean,
  relayHealthy: boolean,
  generation: number,
  observedGeneration: number,
): HealthPollDecision {
  if (!relayHealthy) return "clear";
  if (generation !== observedGeneration) return "reconcile";
  if (!ready) return "reconcile";
  return "noop";
}

/** Decide the side-effecting health action separately from its scheduler. */
export function healthPollDecision(
  phase: SafeStatus["phase"],
  ready: boolean,
  remoteHandleCount: number,
  relayHealthy: boolean,
  generation: number,
  observedGeneration: number,
): HealthPollDecision {
  if (phase !== "ready") return unavailableHealthDecision(ready, remoteHandleCount);
  return readyHealthDecision(ready, relayHealthy, generation, observedGeneration);
}

type PluginOptionsContext = {
  readonly options: unknown;
  readonly location: { readonly project: { readonly directory: string } };
};

function parsePluginOptions(ctx: PluginOptionsContext): ValidatedOptions {
  // Fully validate disabled options without touching the host location.
  // Relative project paths are deliberately left unresolved because they are
  // unused on this path and must not be resolved against process.cwd().
  const preflight = parseOptions(ctx.options, undefined, false);
  return preflight.enabled ? parseOptions(ctx.options, ctx.location.project.directory) : preflight;
}

/** Construct the native OpenCode V2 plugin. The real manager is injected later. */
export function makePlugin(
  factory: ProjectKeyFerryManagerFactory,
  relayFactory?: RemoteRelayFactory,
  registry: BrokerRegistry = brokerRegistry,
): Plugin.Plugin {
  return Plugin.define({
    id: "key-ferry",
    effect: (ctx) => {
      const parsed = parsePluginOptions(ctx);
      if (!parsed.enabled) return Effect.void;
      const program = Effect.gen(function* () {
        const pluginScope = yield* Effect.scope;
        const controllerReady = yield* Deferred.make<void>();
        const configuration = yield* Effect.promise(() =>
          loadScopedConfiguration(ctx.options, { project: ctx.location.project }),
        );
        let controller: ReturnType<typeof makeScopedController> | undefined;
        let callbackObserved = false;
        let rpcRegistered = false;
        let bootstrapping = true;
        const registerRpc = (activeController: ReturnType<typeof makeScopedController>) =>
          ctx.rpc.register(KeyFerryRpc, {
            status: (input) =>
              activeController.statusSelected(input).pipe(
                Effect.map((status) =>
                  bootstrapping && status.phase === "stopped"
                    ? { ...status, phase: "starting" as const }
                    : status,
                ),
                Effect.map(sanitizeStatus),
              ),
            refresh: (input, context) =>
              activeController.operation("refresh", input).pipe(
                Effect.map(sanitizeStatus),
                Effect.catch((error) =>
                  Effect.fail(context.error("unavailable", publicMessage(error), rpcError(error))),
                ),
              ),
            doctor: (input, context) =>
              activeController.operation("doctor", input).pipe(
                Effect.map(sanitizeStatus),
                Effect.catch((error) =>
                  Effect.fail(context.error("unavailable", publicMessage(error), rpcError(error))),
                ),
              ),
            activateProject: (_, context) =>
              activeController.activateProject.pipe(
                Effect.map(sanitizeStatus),
                Effect.catch((error) =>
                  Effect.fail(context.error("unavailable", publicMessage(error), rpcError(error))),
                ),
              ),
          });
        yield* ctx.mcp.transform((next) => {
          callbackObserved = true;
          if (controller) {
            controller.setEditor(next);
            controller.apply(next);
          } else {
            controller = makeScopedController({
              configuration,
              factory,
              relayFactory,
              registry,
              scope: pluginScope,
              reload: ctx.mcp.reload,
              editor: next,
              startEmptyGlobal: !parsed.projectConfig.enabled,
            });
            controller.capture(next);
            controller.apply(next);
            Deferred.doneUnsafe(controllerReady, Effect.succeed(undefined));
          }
        });
        yield* Effect.addFinalizer(() => (controller ? controller.dispose : Effect.void));
        if (callbackObserved && controller && !rpcRegistered) {
          yield* registerRpc(controller);
          rpcRegistered = true;
        }
        yield* Effect.forkIn(
          Effect.gen(function* () {
            yield* Deferred.await(controllerReady);
            const activeController = controller;
            if (!activeController) return;
            yield* activeController.start.pipe(Effect.catch(() => Effect.void));
            bootstrapping = false;
            if (parsed.projectConfig.enabled)
              yield* activeController.watch(() =>
                loadScopedConfiguration(ctx.options, { project: ctx.location.project }),
              );
            yield* ctx.mcp.reload();
            if (!rpcRegistered) {
              yield* registerRpc(activeController);
              rpcRegistered = true;
            }
          }).pipe(Effect.catch(() => Effect.void)),
          pluginScope,
        );
        // Native hosts defer RPC registration until the callback-owned child starts.
      });
      return program.pipe(Effect.catch(() => Effect.void));
    },
  });
}
