import { makePlugin } from "./plugin.js";
import { startRelay } from "./relay/index.js";
import { projectKeyFerryManagerFactory } from "./varlock/manager.js";

/** The native OpenCode V2 server plugin entrypoint. */
// The production entrypoint supplies the real CONNECT relay. Keeping the
// factory injectable in makePlugin is useful for tests, but omitting it here
// would silently disable every selected remote MCP server.
const plugin = makePlugin(projectKeyFerryManagerFactory, startRelay);

export default plugin;

export { makePlugin } from "./plugin.js";
export { startRelay, RELAY_AUTH_HEADER, RelayError } from "./relay/index.js";
export type { RelayConfig, RelayHandle, RelayHealth, RelayErrorCode } from "./relay/index.js";
