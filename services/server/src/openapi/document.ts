import { approvalsOpenApiPaths, approvalsOpenApiSchemas } from "./approvals.js";
import { compactOpenApiPaths, compactOpenApiSchemas } from "./compact.js";
import { feedbackOpenApiPaths, feedbackOpenApiSchemas } from "./feedback.js";
import { markersOpenApiPaths, markersOpenApiSchemas } from "./markers.js";
import { modelsOpenApiPaths, modelsOpenApiSchemas } from "./models.js";
import { pendingOpenApiPaths, pendingOpenApiSchemas } from "./pending.js";
import { runsOpenApiPaths, runsOpenApiSchemas } from "./runs.js";
import { threadsOpenApiPaths, threadsOpenApiSchemas } from "./threads.js";
import { usageOpenApiPaths, usageOpenApiSchemas } from "./usage.js";

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
      ...markersOpenApiPaths(),
      ...compactOpenApiPaths(),
      ...approvalsOpenApiPaths(),
      ...usageOpenApiPaths(),
      ...modelsOpenApiPaths(),
      ...feedbackOpenApiPaths(),
    },
    components: {
      schemas: {
        ...threadsOpenApiSchemas(),
        ...runsOpenApiSchemas(),
        ...pendingOpenApiSchemas(),
        ...markersOpenApiSchemas(),
        ...compactOpenApiSchemas(),
        ...approvalsOpenApiSchemas(),
        ...usageOpenApiSchemas(),
        ...modelsOpenApiSchemas(),
        ...feedbackOpenApiSchemas(),
      },
      securitySchemes: {
        session: { type: "apiKey", in: "cookie", name: "better-auth.session_token" },
      },
    },
    security: [{ session: [] }],
  };
}
