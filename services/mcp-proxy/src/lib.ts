// Library entry (`@kobe/mcp-proxy`): the proxy's building blocks, for the server's cross-process
// integration tests (KOBE-58 Gate 2). The process entry point is `index.ts` (Dockerfile CMD).
export { createApp } from "./app.js";
export {
  DEFAULT_LIMITS,
  loadConfig,
  type Config,
  type Limits,
  type UpstreamPolicy,
} from "./config.js";
export { NO_GRANTS, createServerCredentials, type CredentialResolver } from "./credentials.js";
export { createLimiter } from "./limits.js";
export { THREAD_HEADER, TOOL_CALL_ID_META_KEY, type McpRouteDeps } from "./mcp.js";
export { createPolicyServer, type PolicyServer } from "./server-client.js";
export { FakeUpstream, type FakeUpstreamOptions } from "./testing/fake-upstream.js";
export { createUpstreamClient, type UpstreamClient } from "./upstream.js";
