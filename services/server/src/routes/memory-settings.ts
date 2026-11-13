import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import { withTeam } from "@kobe/db";
import { recordAudit } from "../audit/record.js";
import {
  requireSitePermission,
  requireTeam,
  requireTeamPermission,
  type TeamVariables,
} from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import { learnAvailability } from "../memory/learning-model.js";
import {
  readMemorySiteSettings,
  removedModelSettings,
  writeMemorySiteSettings,
  type MemorySiteSettings,
} from "../memory/site-settings.js";
import {
  fromWorkspaceWire,
  sitePutSchema,
  siteSwitchChangeOf,
  toSiteSwitchesWire,
  toWorkspaceWire,
  workspaceChangeOf,
  workspacePutSchema,
} from "../memory/settings-wire.js";
import {
  lockSiteMemorySettings,
  readSiteSwitches,
  readSwitches,
  readTeamSwitches,
  writeSiteSwitches,
  writeTeamSwitches,
  type SiteMemorySwitches,
  type WorkspaceMemorySwitches,
} from "../memory/switches.js";
import { isModelEnabled } from "../models/team-store.js";
import { invalidRequest, parseBody } from "../teams/http.js";

/** Runs the middlewares in order, then `next` (a response from one of them ends the chain). */
const chain =
  (...steps: MiddlewareHandler[]): MiddlewareHandler =>
  (c, next) => {
    const at = async (i: number): Promise<Response | undefined> => {
      if (i === steps.length) {
        await next();
        return undefined;
      }
      const step = steps[i];
      if (!step) return undefined;
      const out = await step(c, async () => {
        const inner = await at(i + 1);
        if (inner instanceof Response) c.res = inner;
      });
      return out instanceof Response ? out : undefined;
    };
    return at(0);
  };

const LEVELS = ["team", "site", "effective"] as const;
type Level = (typeof LEVELS)[number];

const empty = (o: object) => Object.values(o).every((v) => v === undefined);

/**
 * `GET/PUT /v1/memory/settings?level=team|site` (KOBE-155, D24; widened by KOBE-381, SM27): the
 * AND-ed switch levels, plus `GET ?level=effective` (any member) for what applies to the active
 * Workspace now (Notes, Memories per scope, Policy, Learn with its model or the reason it is
 * unavailable, Site proposals). Team level: read by members, changed by team admins (with the
 * learning model override, which must be enabled in the Workspace). Site level: site admins only,
 * with the Site memory settings. Changes are audited (values only; Site settings by name).
 * Turning anything off deletes nothing.
 */
export function memorySettingsRoutes(deps: ServerDeps): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  const db = deps.database.db;
  const siteGuard = requireSitePermission("site.settings.manage") as MiddlewareHandler;
  const teamRead = chain(requireTeam(deps), requireTeamPermission("team.read"));
  const teamWrite = chain(requireTeam(deps), requireTeamPermission("team.memory.manage"));

  const levelOf = (raw: string | undefined): Level | undefined => LEVELS.find((l) => l === raw);

  app.use("*", async (c, next) => {
    const level = levelOf(c.req.query("level"));
    if (!level || (c.req.method !== "GET" && level === "effective")) {
      return invalidRequest(c, "Send level=team or level=site (effective is read-only).");
    }
    if (level === "site") return siteGuard(c, next);
    return (c.req.method === "GET" ? teamRead : teamWrite)(c, next);
  });

  app.get("/", async (c) => {
    const level = levelOf(c.req.query("level"));
    if (level === "site") {
      return c.json(
        await db.transaction(async (tx) => {
          const settings = await readMemorySiteSettings(tx);
          return siteWire(
            await readSiteSwitches(tx),
            settings,
            await removedModelSettings(tx, settings),
          );
        }),
      );
    }
    const teamId = c.get("team").id;
    if (level === "team")
      return c.json(
        toWorkspaceWire(await withTeam(db, teamId, (tx) => readTeamSwitches(tx, teamId))),
      );
    const out = await withTeam(db, teamId, async (tx) => {
      const switches = await readSwitches(tx, teamId);
      const { memory } = switches;
      const learn = await learnAvailability(tx, teamId, switches);
      return {
        memory_enabled: memory.notes.user,
        project_memory_enabled: memory.notes.project,
        memories_enabled: memory.memories,
        scopes: memory.scopes,
        policy: memory.policy,
        site_proposals_enabled: memory.siteProposals,
        learn: learn.ok
          ? { available: true, alias: learn.alias, source: learn.source }
          : { available: false, reason: learn.reason, message: learn.message },
      };
    });
    return c.json(out);
  });

  app.put("/", async (c) => {
    if (levelOf(c.req.query("level")) === "site") return putSite(c);
    return putTeam(c);
  });

  async function putSite(c: Context<{ Variables: TeamVariables }>) {
    const body = await parseBody(c, sitePutSchema);
    const { settings, ...switches } = body ?? {};
    if (!body || (empty(switches) && (settings === undefined || empty(settings)))) {
      return invalidRequest(c, "Send at least one switch or setting (expected is for level=team).");
    }
    const out = await db.transaction(async (tx) => {
      await lockSiteMemorySettings(tx);
      // Settings first: a new unknown model alias refuses before anything is written.
      const written = await writeMemorySiteSettings(tx, settings ?? {});
      if (!written.ok) return written;
      const { before, after } = await writeSiteSwitches(tx, siteSwitchChangeOf(switches));
      const switchChanged = (Object.keys(after) as (keyof SiteMemorySwitches)[]).some(
        (k) => before[k] !== after[k],
      );
      if (switchChanged || written.changed.length > 0) {
        await recordAudit(tx, {
          action: "memory.site_settings_changed",
          target: { ...after, ...settingsAudit(written.before, written.settings, written.changed) },
        });
      }
      return siteWire(after, written.settings, await removedModelSettings(tx, written.settings));
    });
    if ("ok" in out) return c.json({ code: out.code, message: out.message }, 400);
    return c.json(out);
  }

  async function putTeam(c: Context<{ Variables: TeamVariables }>) {
    const body = await parseBody(c, workspacePutSchema);
    const { expected, ...rest } = body ?? {};
    if (!body || empty(rest)) {
      return invalidRequest(c, "Send at least one switch or learning_model_alias.");
    }
    const teamId = c.get("team").id;
    const change = workspaceChangeOf(rest);
    const next = await withTeam(db, teamId, async (tx) => {
      const alias = change.learningModelAlias;
      if (alias && !(await isModelEnabled(tx, teamId, alias))) return "model_not_enabled" as const;
      const saved = await writeTeamSwitches(
        tx,
        teamId,
        c.get("user").id,
        change,
        expected === undefined ? undefined : fromWorkspaceWire(expected),
      );
      if (saved === "changed_since_approval") return saved;
      const { before, after } = saved;
      const keys = Object.keys(after) as (keyof WorkspaceMemorySwitches)[];
      if (keys.some((k) => before[k] !== after[k])) {
        await recordAudit(tx, {
          action: "memory.settings_changed",
          teamId,
          target: {
            ...after,
            ...(before.learningModelAlias !== after.learningModelAlias
              ? { previousLearningModelAlias: before.learningModelAlias }
              : {}),
          },
        });
      }
      return after;
    });
    if (next === "model_not_enabled") {
      return c.json(
        {
          code: "model_not_enabled",
          message: "Enable that model in Workspace settings › Models first; nothing was changed.",
        },
        400,
      );
    }
    if (next === "changed_since_approval") {
      return c.json(
        {
          code: next,
          message: "The workspace's memory settings changed meanwhile; nothing was changed.",
        },
        409,
      );
    }
    return c.json(toWorkspaceWire(next));
  }

  return app;
}

/** The Site level's answer: switches, settings, and model settings whose alias was removed. */
function siteWire(
  switches: SiteMemorySwitches,
  settings: MemorySiteSettings,
  removed: readonly string[],
) {
  return { ...toSiteSwitchesWire(switches), settings, removed_models: [...removed] };
}

/** Changed setting names, plus the model values before and after (review L3). */
function settingsAudit(
  before: MemorySiteSettings,
  after: MemorySiteSettings,
  changed: readonly string[],
) {
  if (changed.length === 0) return {};
  const model = (k: "learning_model_alias" | "embedding_model_alias") =>
    changed.includes(k) ? { from: before[k], to: after[k] } : undefined;
  const learning = model("learning_model_alias");
  const embedding = model("embedding_model_alias");
  return {
    settings: [...changed],
    ...(learning ? { learningModel: learning } : {}),
    ...(embedding ? { embeddingModel: embedding } : {}),
  };
}
