import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ServerDeps } from "../deps.js";
import { runRoutes, threadRunRoutes } from "../routes/runs.js";
import { threadRoutes } from "../routes/threads.js";
import { openApiDocument } from "./document.js";

// Regenerate after changing routes or schemas:
//   UPDATE_OPENAPI=1 pnpm --filter @kobe/server exec vitest run src/openapi && pnpm format
const FILE = fileURLToPath(new URL("../../openapi.json", import.meta.url));

const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

/** Mounted routes of a router as OpenAPI (method, path) pairs; middleware entries are skipped. */
function mountedOperations(prefix: string, router: { routes: { method: string; path: string }[] }) {
  return router.routes
    .filter((r) => HTTP_METHODS.has(r.method))
    .map((r) => {
      const path = `${prefix}${r.path === "/" ? "" : r.path}`.replace(/:([A-Za-z]+)/g, "{$1}");
      return `${r.method.toLowerCase()} ${path}`;
    })
    .sort();
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
      ].sort(),
    );
  });

  it("describes exactly the run routes the orchestrator mounts (KOBE-30)", () => {
    expect(documented("/v1/runs")).toEqual(mountedOperations("/v1/runs", runRoutes(fakeDeps)));
  });

  it("matches §6.1: messages take content (+ parent_entry_id, file_ids) and answer run_id, queued", () => {
    const schemas = (doc.components as { schemas: Record<string, { properties: object }> }).schemas;
    const props = (name: string) => Object.keys(schemas[name]?.properties ?? {});
    expect(props("SubmitMessageBody")).toEqual(["parent_entry_id", "content", "file_ids"]);
    expect(props("SubmitMessageResult")).toEqual(["run_id", "queued"]);
    expect(props("SteerBody")).toEqual(["content"]);
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
