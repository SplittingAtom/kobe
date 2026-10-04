import type { Context, Hono } from "hono";
import type { KobeDb } from "@kobe/db";
import { recordAuditAfter } from "../../audit/record.js";
import { forbidden, invalidRequest, notFound, publishError } from "../http.js";
import { versionParamSchema } from "../schemas.js";
import { getVersion } from "../versions.js";
import { guardUnreadable, type ResolvedAgent } from "../version-routes.js";
import { mapAgentVersionToOrbit, orbitExportToYaml, type OrbitExport } from "./orbit-export.js";
import { listOrbitModelOptions, resolveOrbitModel } from "./model.js";

export interface OrbitRouteOptions {
  readonly db: KobeDb;
  /** The agent named by `:id` if the caller may see it; null → 404 (as for version reads). */
  readonly resolve: (c: Context) => Promise<ResolvedAgent | null>;
  /** The active team: its enabled models resolve the agent's alias. */
  readonly teamId: (c: Context) => string;
}

const MCP_NOTE =
  "MCP tools are not included: connector tool snapshots are not wired into exports yet.";

/** The YAML with a leading comment block for what the export left out (Orbit ignores comments). */
function yamlWithNotes(result: OrbitExport): string {
  const notes = [MCP_NOTE, ...result.warnings].map((n) => `# Note: ${n}\n`).join("");
  return notes + orbitExportToYaml(result);
}

/**
 * `GET /:id/versions/:version/orbit` (KOBE-91): a published version as Orbit YAML. Same visibility
 * and rights as reading a version's definition; every export is audited.
 */
export function mountOrbitExport<E extends { Variables: object }>(
  app: Hono<E>,
  options: OrbitRouteOptions,
): void {
  const { db } = options;
  app.get("/:id/versions/:version/orbit", async (c) => {
    const found = await options.resolve(c);
    if (!found) return notFound(c);
    const version = versionParamSchema.safeParse(c.req.param("version"));
    if (!version.success) return invalidRequest(c, "The version must be a positive number.");
    if (!found.access.readDefinition) {
      return forbidden(c, "Your team role doesn't allow exporting team agents.");
    }
    return guardUnreadable(c, async () => {
      const record = await getVersion(db, found.location, found.agent.id, version.data);
      if (!record) return publishError(c, "version_not_found");
      const enabled = await listOrbitModelOptions(db, options.teamId(c));
      const model = resolveOrbitModel(record.definition.frontmatter.model, enabled);
      if (!model.ok) return c.json({ code: model.code, message: model.message }, 409);
      let result: OrbitExport;
      try {
        // TODO(KOBE-62): pass the pinned connector snapshots' MCP tool names (mcpTools).
        result = mapAgentVersionToOrbit({
          definition: {
            ...record.definition,
            frontmatter: { ...record.definition.frontmatter, model: model.model },
          },
          toolManifest: record.toolManifest,
          version: record.version,
        });
      } catch (err) {
        return c.json(
          {
            code: "orbit_export_invalid",
            message: err instanceof Error ? err.message : "This version can't be exported.",
          },
          422,
        );
      }
      await recordAuditAfter(db, {
        action: "agent.orbit_exported",
        teamId: found.location.scope === "team" ? found.location.teamId : null,
        target: {
          agentId: found.agent.id,
          scope: found.agent.scope,
          slug: found.agent.slug,
          version: record.version,
        },
      });
      return c.body(yamlWithNotes(result), 200, {
        "content-type": "application/yaml; charset=utf-8",
        "content-disposition": `attachment; filename="${found.agent.slug}-v${record.version}.orbit.yaml"`,
        "x-content-type-options": "nosniff",
        // A definition export is sensitive and tied to the caller: never cached.
        "cache-control": "no-store",
      });
    });
  });
}
