import type { Scope } from "effect";
import type { BrokerLease } from "../broker-registry.js";
import type { ScopeId, SafeStatus } from "../contracts.js";
import type { ServerProtection } from "../options.js";
import type { ProtectionState } from "../plugin.js";
import type { RemoteRelayCoordinator } from "../remote.js";
import type { ScopedGroup } from "../scoped-config.js";

export type Runtime = {
  readonly id: ScopeId;
  readonly group: ScopedGroup;
  lease?: BrokerLease;
  readonly remote: RemoteRelayCoordinator;
  mappings: Readonly<Record<string, ServerProtection>>;
  state: ProtectionState;
  status?: SafeStatus;
  observedGeneration: number;
  active: boolean;
  readonly scope: Scope.Closeable;
  epoch: number;
  transitioning: boolean;
};
