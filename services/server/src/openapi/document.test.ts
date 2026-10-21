import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ServerDeps } from "../deps.js";
import { approvalRoutes } from "../routes/approvals.js";
import { evalCaseRoutes, runEvalCaseRoutes } from "../eval-cases/routes.js";
import { runFeedbackRoutes, threadFeedbackRoutes } from "../routes/feedback.js";
import { runRoutes, threadRunRoutes } from "../routes/runs.js";
import { teamModelsRoutes } from "../routes/team-models.js";
import { threadPendingRoutes } from "../routes/thread-pending.js";
import { threadMarkerRoutes } from "../routes/thread-markers.js";
import { threadCompactRoutes } from "../routes/thread-compact.js";
import { threadRoutes } from "../routes/threads.js";
import { threadUsageRoutes } from "../routes/usage.js";
import { openApiDocument } from "./document.js";

// Regenerate after changing routes or schemas:
//   UPDATE_OPENAPI=1 pnpm --filter @kobe/server exec vitest run src/openapi && pnpm format
const FILE = fileURLToPath(new URL("../../openapi.json", import.meta.url));

interface JsonSchemaNode {
  readonly required?: readonly string[];
  readonly anyOf?: readonly unknown[];
  readonly items?: JsonSchemaNode;
  readonly properties?: Record<string, JsonSchemaNode>;
}

const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

/**
 * Mounted routes of a router as OpenAPI (method, path) pairs; middleware entries are skipped, and
 * a route with per-route middleware (one entry per handler) counts once.
 */
function mountedOperations(prefix: string, router: { routes: { method: string; path: string }[] }) {
  const operations = router.routes
    .filter((r) => HTTP_METHODS.has(r.method))
    .map((r) => {
      const path = `${prefix}${r.path === "/" ? "" : r.path}`.replace(/:([A-Za-z]+)/g, "{$1}");
      return `${r.method.toLowerCase()} ${path}`;
    });
  return [...new Set(operations)].sort();
}

describe("OpenAPI document (KOBE-34 ac-1)", () => {
  const doc = openApiDocument();

  it("matches the committed openapi.json", () => {
    if (process.env.UPDATE_OPENAPI) writeFileSync(FILE, `${JSON.stringify(doc, null, 2)}\n`);
    expect(JSON.parse(readFileSync(FILE, "utf8"))).toEqual(doc);
  });

  // The middleware isn't run here; only the route tables are read.
  const fakeDeps = { database: { db: {} } } as unknown as ServerDeps;
  const documented = (prefix: string) =>
    Object.entries(doc.paths as Record<string, object>)
      .filter(([path]) => path.startsWith(prefix))
      .flatMap(([path, ops]) => Object.keys(ops).map((m) => `${m} ${path}`))
      .sort();

  it("describes exactly the thread routes the server mounts", () => {
    expect(documented("/v1/threads")).toEqual(
      [
        ...mountedOperations("/v1/threads", threadRoutes(fakeDeps)),
        ...mountedOperations("/v1/threads", threadRunRoutes(fakeDeps)),
        ...mountedOperations("/v1/threads", threadPendingRoutes(fakeDeps)),
        ...mountedOperations("/v1/threads", threadMarkerRoutes(fakeDeps)),
        ...mountedOperations("/v1/threads", threadCompactRoutes(fakeDeps)),
        ...mountedOperations("/v1/threads", threadUsageRoutes(fakeDeps)),
        ...mountedOperations("/v1/threads", threadFeedbackRoutes(fakeDeps)),
      ].sort(),
    );
  });

  it("describes exactly the team model routes the server mounts (KOBE-210)", () => {
    expect(documented("/v1/team/models")).toEqual(
      mountedOperations("/v1/team/models", teamModelsRoutes(fakeDeps)),
    );
  });

  it("documents the context window the chat's gauge reads (KOBE-210/211)", () => {
    const schemas = (doc.components as { schemas: Record<string, JsonSchemaNode> }).schemas;
    const teamModel = schemas.TeamModels?.properties?.models?.items;
    expect(teamModel?.required).toContain("context_window");
    expect(teamModel?.properties?.context_window?.anyOf).toEqual(
      expect.arrayContaining([{ type: "null" }]),
    );
    expect(schemas.ThreadUsage?.required).toContain("latest_call");
  });

  it("describes exactly the run routes the orchestrator mounts (KOBE-30), answer feedback (KOBE-275) and eval case sharing (KOBE-276)", () => {
    expect(documented("/v1/runs")).toEqual(
      [
        ...mountedOperations("/v1/runs", runRoutes(fakeDeps)),
        ...mountedOperations("/v1/runs", runFeedbackRoutes(fakeDeps)),
        ...mountedOperations("/v1/runs", runEvalCaseRoutes(fakeDeps)),
      ].sort(),
    );
  });

  it("describes exactly the member's eval case routes (KOBE-276)", () => {
    expect(documented("/v1/eval-cases")).toEqual(
      mountedOperations("/v1/eval-cases", evalCaseRoutes(fakeDeps)),
    );
  });

  it("describes exactly the approval routes the server mounts (KOBE-37)", () => {
    expect(documented("/v1/approvals")).toEqual(
      mountedOperations("/v1/approvals", approvalRoutes(fakeDeps)),
    );
  });

  it("matches §6.1: POST /v1/approvals/{id} takes decision and remember", () => {
    const schemas = (doc.components as { schemas: Record<string, { properties: object }> }).schemas;
    expect(Object.keys(schemas.ApprovalDecisionBody?.properties ?? {})).toEqual([
      "decision",
      "remember",
    ]);
  });

  it("matches §6.1: messages take content (+ parent_entry_id, file_ids) and answer run_id, queued", () => {
    const schemas = (doc.components as { schemas: Record<string, { properties: object }> }).schemas;
    const props = (name: string) => Object.keys(schemas[name]?.properties ?? {});
    expect(props("SubmitMessageBody")).toEqual([
      "parent_entry_id",
      "content",
      "file_ids",
      "mentions",
      "app_context",
      "skill",
      "viewing",
    ]);
    expect(props("SubmitMessageResult")).toEqual(["run_id", "queued"]);
    expect(props("SteerBody")).toEqual(["content", "mentions"]);
    for (const op of ["steer", "cancel", "retry"]) {
      expect(
        Object.keys((doc.paths as Record<string, object>)[`/v1/runs/{id}/${op}`] ?? {}),
      ).toEqual(["post"]);
    }
  });

  it("matches §6.1: create takes agent_id and project_id; read returns entries, leaf, pin, status", () => {
    const schemas = (doc.components as { schemas: Record<string, { properties: object }> }).schemas;
    const props = (name: string) => Object.keys(schemas[name]?.properties ?? {});
    expect(props("CreateThreadBody")).toEqual(expect.arrayContaining(["agent_id", "project_id"]));
    expect(props("ThreadDetail")).toEqual(
      expect.arrayContaining(["thread_id", "entries", "leaf_entry_id", "agent_version", "status"]),
    );
    expect(props("CreatedThread")).toContain("thread_id");
  });
});
