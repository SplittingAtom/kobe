import { approvalsOpenApiPaths, approvalsOpenApiSchemas } from "./approvals.js";
import { pendingOpenApiPaths, pendingOpenApiSchemas } from "./pending.js";
import { runsOpenApiPaths, runsOpenApiSchemas } from "./runs.js";
import { threadsOpenApiPaths, threadsOpenApiSchemas } from "./threads.js";

/**
 * The server's OpenAPI 3.1 document, committed as `services/server/openapi.json` and checked for
 * drift by `document.test.ts`. Areas add their paths and schemas here (one line each).
 */
export function openApiDocument(): Record<string, unknown> {
  return {
    openapi: "3.1.0",
    info: {
      title: "Kobe API",
      version: "0.0.0",
      description:
        "Team-scoped routes act on the session's active team (spec D9); send X-Kobe-Team on " +
        "changes. Errors are `{code, message}`. Authentication is the Better Auth session cookie.",
    },
    paths: {
      ...threadsOpenApiPaths(),
      ...runsOpenApiPaths(),
      ...pendingOpenApiPaths(),
      ...approvalsOpenApiPaths(),
    },
    components: {
      schemas: {
        ...threadsOpenApiSchemas(),
        ...runsOpenApiSchemas(),
        ...pendingOpenApiSchemas(),
        ...approvalsOpenApiSchemas(),
      },
      securitySchemes: {
        session: { type: "apiKey", in: "cookie", name: "better-auth.session_token" },
      },
    },
    security: [{ session: [] }],
  };
}
