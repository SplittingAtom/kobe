import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ServerDeps } from "../deps.js";
import { approvalRoutes } from "../routes/approvals.js";
import { evalCaseRoutes, runEvalCaseRoutes } from "../eval-cases/routes.js";
import { runFeedbackRoutes, threadFeedbackRoutes } from "../routes/feedback.js";
import { runRoutes, threadRunRoutes } from "../routes/runs.js";
import { teamModelsRoutes } from "../routes/team-models.js";
import {
  myCheckoutRoutes,
  projectCommitRoutes,
  teamStorageRoutes,
} from "../routes/project-commits.js";
import { threadPendingRoutes } from "../routes/thread-pending.js";
import { threadMarkerRoutes } from "../routes/thread-markers.js";
import { threadBranchSummaryRoutes } from "../routes/thread-branch-summary.js";
import { threadCompactRoutes } from "../routes/thread-compact.js";
import { threadContextRoutes } from "../routes/thread-context.js";
import { threadRoutes } from "../routes/threads.js";
import { threadFolderRoutes } from "../routes/thread-folders.js";
import { threadFileLinkRoutes, workspaceFileThreadRoutes } from "../routes/thread-file-links.js";
import { threadUsageRoutes } from "../routes/usage.js";
import { memoryRoutes } from "../routes/memory.js";
import { Hono } from "hono";
import {
  mountAgentRosterRoutes,
  siteAgentRosterRoutes,
  teamAgentRosterRoutes,
} from "../routes/agent-roster.js";
import { mountAgentTransferRoutes } from "../routes/agent-transfer.js";
import type { TeamVariables } from "../authz/middleware.js";
import { openApiDocument } from "./document.js";
import { teamDefaultAgentRoutes } from "../routes/team-default-agent.js";
import { projectFromFolderRoutes } from "../routes/project-from-folder.js";
import { egressRequestRoutes } from "../routes/egress-requests.js";
import { siteEgressRoutes } from "../routes/site-egress.js";

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
        ...mountedOperations("/v1/threads", threadBranchSummaryRoutes(fakeDeps)),
        ...mountedOperations("/v1/threads", threadContextRoutes(fakeDeps)),
        ...mountedOperations("/v1/threads", threadUsageRoutes(fakeDeps)),
        ...mountedOperations("/v1/threads", threadFeedbackRoutes(fakeDeps)),
        ...mountedOperations("/v1/threads", threadFileLinkRoutes(fakeDeps)),
      ].sort(),
    );
  });

  it("describes exactly the workspace file-threads route (KOBE-611)", () => {
    expect(documented("/v1/workspace/file-threads")).toEqual(
      mountedOperations("/v1/workspace", workspaceFileThreadRoutes(fakeDeps)),
    );
  });

  it("describes exactly the thread folder routes the server mounts (KOBE-534)", () => {
    expect(documented("/v1/thread-folders")).toEqual(
      mountedOperations("/v1/thread-folders", threadFolderRoutes(fakeDeps)),
    );
  });

  it("describes exactly the agent roster, transfer and adopt routes the server mounts (KOBE-566, KOBE-568)", () => {
    const agents = new Hono<{ Variables: TeamVariables }>();
    mountAgentRosterRoutes(agents, fakeDeps);
    mountAgentTransferRoutes(agents, fakeDeps);
    const ours = (op: string) =>
      ["roster", "assignments", "transfer"].some((word) => op.includes(word));
    expect(documented("/v1/agents").filter(ours)).toEqual(mountedOperations("/v1/agents", agents));
    // The fork route lives with the agent routes (KOBE-568): documented once.
    expect(documented("/v1/agents").filter((op) => op.endsWith("/fork"))).toEqual([
      "post /v1/agents/{id}/fork",
    ]);
    expect(documented("/v1/team/agent-roster")).toEqual(
      mountedOperations("/v1/team/agent-roster", teamAgentRosterRoutes(fakeDeps)),
    );
    expect(documented("/v1/site/agent-roster")).toEqual(
      mountedOperations("/v1/site/agent-roster", siteAgentRosterRoutes(fakeDeps)),
    );
  });

  it("describes exactly the project commit, checkout and storage routes (KOBE-579)", () => {
    const wildcard = (op: string) => op.replace(/\/\*$/, "/{path}");
    const ours = (op: string) =>
      ["checkout", "commit", "/download"].some((word) => op.includes(word));
    expect(documented("/v1/projects").filter(ours)).toEqual(
      mountedOperations("/v1/projects", projectCommitRoutes(fakeDeps)).map(wildcard).sort(),
    );
    expect(documented("/v1/me/checkouts")).toEqual(
      mountedOperations("/v1/me/checkouts", myCheckoutRoutes(fakeDeps)),
    );
    expect(documented("/v1/team/storage")).toEqual(
      mountedOperations("/v1/team/storage", teamStorageRoutes(fakeDeps)),
    );
  });

  it("describes exactly the request-access routes and the site's request routes (KOBE-602)", () => {
    expect(documented("/v1/egress/requests")).toEqual(
      mountedOperations("/v1/egress/requests", egressRequestRoutes(fakeDeps)),
    );
    const site = mountedOperations("/v1/site/egress-ceiling", siteEgressRoutes(fakeDeps));
    expect(documented("/v1/site/egress-ceiling").every((op) => site.includes(op))).toBe(true);
    expect(site.filter((op) => op.includes("/requests"))).toEqual(
      documented("/v1/site/egress-ceiling/requests"),
    );
  });

  it("describes exactly the promote-folder route (KOBE-586)", () => {
    expect(documented("/v1/projects/from-folder")).toEqual(
      mountedOperations("/v1/projects", projectFromFolderRoutes(fakeDeps)),
    );
    const schemas = (doc.components as { schemas: Record<string, { properties: object }> }).schemas;
    expect(Object.keys(schemas.PromoteFolderBody?.properties ?? {})).toEqual(["path", "name"]);
  });

  it("documents the semantic memory item, import/export and steward contract (KOBE-377)", () => {
    // Contract first: the routes are mounted by KOBE-378 (items), KOBE-384/385 (import/export)
    // and KOBE-380 (stewards), which then add a "describes exactly" check here.
    expect(documented("/v1/memory/semantic/")).toEqual(
      [
        "get /v1/memory/semantic/export",
        "post /v1/memory/semantic/import/commit",
        "post /v1/memory/semantic/import/preview",
        "get /v1/memory/semantic/items",
        "post /v1/memory/semantic/items",
        "get /v1/memory/semantic/items/{scope}/{id}",
        "patch /v1/memory/semantic/items/{scope}/{id}",
        "post /v1/memory/semantic/items/{scope}/{id}/archive",
        "post /v1/memory/semantic/items/{scope}/{id}/pin",
        "post /v1/memory/semantic/items/{scope}/{id}/restore",
        "post /v1/memory/semantic/items/{scope}/{id}/revert",
      ].sort(),
    );
    expect(documented("/v1/memory").every((op) => op.includes("/v1/memory/semantic/"))).toBe(true);
    expect(documented("/v1/team/memory/stewards")).toEqual(
      [
        "get /v1/team/memory/stewards",
        "put /v1/team/memory/stewards/{userId}",
        "delete /v1/team/memory/stewards/{userId}",
      ].sort(),
    );
    expect(documented("/v1/site/memory/stewards")).toEqual(["get /v1/site/memory/stewards"]);
    const schemas = (doc.components as { schemas: Record<string, JsonSchemaNode> }).schemas;
    expect(schemas.SemanticMemoryItemDetail?.required).toContain("versions");
    expect(schemas.SemanticMemoryError?.properties?.code).toBeDefined();
  });

  it("no Notes route (/v1/memory) answers a semantic memory request (KOBE-377 review M1)", () => {
    const notes = memoryRoutes(fakeDeps);
    const semantic = documented("/v1/memory/semantic/");
    expect(semantic.length).toBeGreaterThan(0);
    for (const op of semantic) {
      const [method = "", path = ""] = op.split(" ");
      const concrete = path
        .replace("/v1/memory", "")
        .replace("{scope}", "team")
        .replace("{id}", "11111111-1111-4111-8111-111111111111");
      const hit = notes.routes.find(
        (r) =>
          HTTP_METHODS.has(r.method) &&
          r.method.toLowerCase() === method &&
          new RegExp(`^${r.path.replace(/:[A-Za-z]+/g, "[^/]+")}$`).test(concrete),
      );
      expect(hit, `${op} is answered by the Notes route ${hit?.path ?? ""}`).toBeUndefined();
    }
  });

  it("describes exactly the team default agent routes the server mounts (KOBE-571)", () => {
    expect(documented("/v1/team/default-agent")).toEqual(
      mountedOperations("/v1/team/default-agent", teamDefaultAgentRoutes(fakeDeps)),
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
      "references",
      "viewing",
      "viewing_from_entry",
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
