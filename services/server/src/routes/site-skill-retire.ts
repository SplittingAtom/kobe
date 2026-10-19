import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AuthVariables } from "../auth/session.js";
import type { ServerDeps } from "../deps.js";
import {
  deprecateSkill,
  retireVersion,
  type RetireResult,
  type Retired,
  type VersionAct,
} from "../skills/registry/retire.js";
import { emailRetirement, notifyRetirement } from "../skills/registry/retire-notify.js";
import { semverSchema } from "../skills/semver.js";
import { invalidRequest, parseBody } from "../teams/http.js";
import { logger } from "../logger.js";

const idSchema = z.uuid();
const actSchema = z.enum(["deprecate", "withdraw", "revoke", "unrevoke"]);
const noteSchema = z.strictObject({ note: z.string().trim().min(1).max(2000).optional() });
const skillSchema = z.strictObject({ replacementId: z.uuid().optional() });

type Ctx = Context<{ Variables: AuthVariables }>;

const ERRORS = {
  not_found: [404, "No published version (or catalog skill) with that id."],
  forbidden: [
    403,
    "Maintainers and Site admins deprecate; only Site admins withdraw, revoke and unrevoke.",
  ],
  wrong_state: [409, "The version (or skill) isn't in a state this act applies to."],
  bad_replacement: [422, "The replacement must be another live catalog skill."],
} as const;

/**
 * Deprecate, Withdraw, Revoke and Unrevoke (KOBE-340, SK31; spec §8
 * `POST /v1/site/skills/catalog/{skillId}/versions/{v}/{deprecate|withdraw|revoke|unrevoke}`),
 * and a whole skill's deprecation (`POST .../catalog/{skillId}/deprecate`). Who may act is
 * decided per act (`retire.ts`): maintainers and Site admins deprecate, Site admins do the rest.
 * The act commits, then the in-app notices are written (one transaction per team, under its
 * RLS) and the emails go out in the background.
 */
export function siteSkillRetireRoutes(deps: ServerDeps): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();
  const db = deps.database.db;
  const actor = (c: Ctx) => ({ userId: c.get("user").id, siteRole: c.get("siteRole") });

  async function answer(c: Ctx, r: RetireResult) {
    if (!r.ok) {
      const [status, message] = ERRORS[r.code];
      return c.json({ code: r.code, message }, status);
    }
    const notified = await notifyRetirement(db, r.retired).catch((err: unknown) => {
      logger.error({ err, skillId: r.retired.skillId }, "skills: retirement notices failed");
      return null;
    });
    if (notified && notified.emails.length > 0) {
      const retired: Retired = r.retired;
      deps.background.run("skill retirement email failed", () =>
        emailRetirement(
          { db, mailer: deps.mailer, publicUrl: new URL(deps.publicUrl).origin },
          retired,
          notified.emails,
        ),
      );
    }
    return c.json({
      state: r.retired.state,
      notified: notified ? { teams: notified.teams, members: notified.members } : null,
    });
  }

  app.post("/catalog/:skillId/versions/:semver/:act", async (c) => {
    const id = idSchema.safeParse(c.req.param("skillId"));
    const semver = semverSchema.safeParse(c.req.param("semver"));
    const act = actSchema.safeParse(c.req.param("act"));
    if (!id.success || !semver.success || !act.success)
      return c.json({ code: "not_found", message: ERRORS.not_found[1] }, 404);
    const body = await parseBody(c, noteSchema);
    if (!body) return invalidRequest(c, "Send an optional note (up to 2000 characters).");
    const r = await retireVersion(db, {
      skillId: id.data,
      semver: semver.data,
      act: act.data as VersionAct,
      actor: actor(c),
      note: body.note,
    });
    return answer(c, r);
  });

  app.post("/catalog/:skillId/deprecate", async (c) => {
    const id = idSchema.safeParse(c.req.param("skillId"));
    if (!id.success) return c.json({ code: "not_found", message: ERRORS.not_found[1] }, 404);
    const body = await parseBody(c, skillSchema);
    if (!body) return invalidRequest(c, "Send an optional replacementId.");
    return answer(
      c,
      await deprecateSkill(db, {
        skillId: id.data,
        actor: actor(c),
        replacementId: body.replacementId,
      }),
    );
  });

  return app;
}
