import { Hono } from "hono";
import type { AuthVariables } from "../auth/session.js";
import { requireInstallPermission } from "../authz/middleware.js";
import type { IsolationGate, IsolationStatus } from "../isolation/gate.js";

const DOCS = "docs/install.md#isolation";

function toBody(status: IsolationStatus) {
  switch (status.state) {
    case "checking":
      return {
        state: status.state,
        agentsEnabled: false,
        runtimeClassName: status.runtimeClassName,
      };
    case "verified":
      return {
        state: status.state,
        agentsEnabled: true,
        runtimeClassName: status.runtimeClassName,
        handler: status.handler,
        checkedAt: status.checkedAt.toISOString(),
      };
    case "missing":
      return {
        state: status.state,
        agentsEnabled: false,
        ...(status.runtimeClassName === undefined
          ? {}
          : { runtimeClassName: status.runtimeClassName }),
        message: status.message,
        checkedAt: status.checkedAt.toISOString(),
        docs: DOCS,
      };
  }
}

/**
 * Isolation status for the install admin console (spec D4: "the admin console shows the fix").
 * Install Owner/Admin only: the message names cluster details. POST /check re-verifies now.
 */
export function installIsolationRoutes(
  isolation: IsolationGate,
): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();

  app.use(requireInstallPermission("install.settings.manage"));

  app.get("/", (c) => c.json(toBody(isolation.status())));
  app.post("/check", async (c) => c.json(toBody(await isolation.check())));

  return app;
}
