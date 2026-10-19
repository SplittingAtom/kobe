import { Hono } from "hono";
import { honoTracing } from "@kobe/telemetry";
import { mcpRoutes, type McpRouteDeps } from "./mcp.js";
import { appCallRoutes, type AppCallDeps } from "./app-calls.js";
import { probeRoutes, type ProbeDeps } from "./probe.js";

const SERVICE = "mcp-proxy";

/** Health endpoints always; the sandbox-facing MCP endpoint when dependencies are provided. */
export function createApp(deps?: McpRouteDeps, probe?: ProbeDeps, appCalls?: AppCallDeps): Hono {
  const app = new Hono();
  app.use("*", honoTracing({ joinCallerTrace: false }));
  app.get("/healthz", (c) => c.json({ status: "ok", service: SERVICE }));
  app.get("/readyz", (c) => c.json({ status: "ready", service: SERVICE }));
  if (deps) app.route("/v1/mcp", mcpRoutes(deps));
  if (probe) app.route("/internal/v1/probe", probeRoutes(probe));
  if (appCalls) app.route("/internal/v1/app-calls", appCallRoutes(appCalls));
  app.onError((err, c) => {
    deps?.log.error({ err }, "unhandled error");
    return c.json(
      { jsonrpc: "2.0", id: null, error: { code: -32603, message: "Internal error." } },
      500,
    );
  });
  return app;
}
