import {
  createTopicTagSchema,
  moveDefaultMajorSchema,
  putSkillTagsSchema,
  updateTopicTagSchema,
} from "@kobe/protocol";
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AuthVariables } from "../auth/session.js";
import { requireSitePermission } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import { listDefaultSyncs, listSiteCatalog } from "../skills/catalog-admin.js";
import {
  createTopicTag,
  listTags,
  moveDefaultMajor,
  setSkillTags,
  updateTopicTag,
  type Tag,
} from "../skills/tags.js";
import { invalidRequest, parseBody } from "../teams/http.js";

const idSchema = z.uuid();

const tagJson = (t: Tag) => ({ id: t.id, name: t.name, kind: t.kind, status: t.status });

const tagConflict = (c: Context, code: "exists" | "not_found") =>
  code === "exists"
    ? c.json({ code: "tag_exists", message: "A tag with that name already exists." }, 409)
    : c.json({ code: "not_found", message: "No topic tag with that id." }, 404);

/**
 * Catalog tags and the Default tag (`/v1/site/skills`, KOBE-314, SK5–SK8): the topic vocabulary,
 * each catalog skill's tags (applying or removing Default queues a Default sync), the move of
 * Default installs to a new major, and the sync jobs' progress. Site Owner/Admins; every change is
 * audited.
 */
export function siteSkillTagRoutes(deps: ServerDeps): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();
  const db = deps.database.db;
  // Per path, not for the whole `/v1/site/skills` prefix: the Registry queue mounts beside it with
  // its own permission (skill reviewers, Phase C).
  const manage = requireSitePermission("site.skills.catalog.manage");
  for (const path of ["/tags", "/tags/*", "/catalog", "/catalog/*", "/default-syncs"])
    app.use(path, manage);

  app.get("/tags", async (c) => c.json({ tags: (await listTags(db)).map(tagJson) }));

  app.post("/tags", async (c) => {
    const body = await parseBody(c, createTopicTagSchema);
    if (!body) return invalidRequest(c, "Send a name: lowercase letters, digits and hyphens.");
    const r = await createTopicTag(db, body.name);
    return r.ok ? c.json({ tag: tagJson(r.tag) }, 201) : tagConflict(c, r.code);
  });

  app.patch("/tags/:id", async (c) => {
    const id = idSchema.safeParse(c.req.param("id"));
    const body = await parseBody(c, updateTopicTagSchema);
    if (!id.success || !body) return invalidRequest(c, "Send a new name, a status or both.");
    const r = await updateTopicTag(db, id.data, body);
    return r.ok ? c.json({ tag: tagJson(r.tag) }) : tagConflict(c, r.code);
  });

  app.get("/catalog", async (c) => c.json({ skills: await listSiteCatalog(db) }));

  app.put("/catalog/:skillId/tags", async (c) => {
    const id = idSchema.safeParse(c.req.param("skillId"));
    const body = await parseBody(c, putSkillTagsSchema);
    if (!id.success || !body) return invalidRequest(c, "Send system and topic tag lists.");
    const r = await setSkillTags(db, id.data, body, c.get("user").id);
    if (r.ok) return c.json({ system: r.system, topic: r.topic, syncId: r.syncId });
    if (r.code === "not_found")
      return c.json({ code: "not_found", message: "No catalog skill with that id." }, 404);
    if (r.code === "no_version")
      return c.json(
        { code: "no_version", message: "Default needs an approved version of the skill." },
        409,
      );
    return c.json(
      {
        code: "unknown_tags",
        message: "Use active tags from the vocabulary.",
        tags: r.tags ?? [],
      },
      400,
    );
  });

  app.post("/catalog/:skillId/default/move-major", async (c) => {
    const id = idSchema.safeParse(c.req.param("skillId"));
    const body = await parseBody(c, moveDefaultMajorSchema);
    if (!id.success || !body) return invalidRequest(c, "Send the major version to move to.");
    const r = await moveDefaultMajor(db, id.data, body.to, c.get("user").id);
    if (r.ok) return c.json({ syncId: r.syncId, semver: r.semver }, 202);
    const errors = {
      not_found: [404, "No catalog skill with that id."],
      not_default: [409, "The skill is not a Site default."],
      not_newer: [409, `Default installs already follow major ${r.major ?? 0} or later.`],
      no_version: [409, "That major has no approved version."],
    } as const;
    const [status, message] = errors[r.code];
    return c.json({ code: r.code, message }, status);
  });

  app.get("/default-syncs", async (c) => c.json({ syncs: await listDefaultSyncs(db) }));

  return app;
}
