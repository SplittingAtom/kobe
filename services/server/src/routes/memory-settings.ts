import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { memorySettingsSchema, type MemorySettings } from "@kobe/protocol";
import { withTeam } from "@kobe/db";
import { recordAudit } from "../audit/record.js";
import {
  requireInstallPermission,
  requireTeam,
  requireTeamPermission,
  type TeamVariables,
} from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import {
  readInstallSwitches,
  readSwitches,
  readTeamSwitches,
  writeInstallSwitches,
  writeTeamSwitches,
  type SwitchPair,
} from "../memory/switches.js";
import { invalidRequest, parseBody } from "../teams/http.js";

/** Runs the middlewares in order, then `next` (a response from one of them ends the chain). */
const chain =
  (...steps: MiddlewareHandler[]): MiddlewareHandler =>
  (c, next) => {
    const at = async (i: number): Promise<Response | void> => {
      if (i === steps.length) {
        await next();
        return undefined;
      }
      return steps[i]!(c, async () => {
        const inner = await at(i + 1);
        if (inner instanceof Response) c.res = inner;
      });
    };
    return at(0);
  };

const LEVELS = ["team", "install", "effective"] as const;
type Level = (typeof LEVELS)[number];

const wire = (p: SwitchPair): MemorySettings => ({
  memory_enabled: p.memoryEnabled,
  project_memory_enabled: p.projectMemoryEnabled,
});

const changeOf = (body: MemorySettings): Partial<SwitchPair> => ({
  ...(body.memory_enabled !== undefined ? { memoryEnabled: body.memory_enabled } : {}),
  ...(body.project_memory_enabled !== undefined
    ? { projectMemoryEnabled: body.project_memory_enabled }
    : {}),
});

/**
 * `GET/PUT /v1/memory/settings?level=team|install` (KOBE-155, D24): the two AND-ed switch levels,
 * plus `GET ?level=effective` (any member) for what applies to the active team now.
 * Team level: read by members, changed by team admins. Install level: install admins only.
 * Changes are audited (switch values only).
 */
export function memorySettingsRoutes(deps: ServerDeps): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  const db = deps.database.db;
  const installGuard = requireInstallPermission("install.settings.manage") as MiddlewareHandler;
  const teamRead = chain(requireTeam(deps), requireTeamPermission("team.read"));
  const teamWrite = chain(requireTeam(deps), requireTeamPermission("team.memory.manage"));

  const levelOf = (raw: string | undefined): Level | undefined => LEVELS.find((l) => l === raw);

  app.use("*", async (c, next) => {
    const level = levelOf(c.req.query("level"));
    if (!level || (c.req.method !== "GET" && level === "effective")) {
      return invalidRequest(c, "Send level=team or level=install (effective is read-only).");
    }
    if (level === "install") return installGuard(c, next);
    return (c.req.method === "GET" ? teamRead : teamWrite)(c, next);
  });

  app.get("/", async (c) => {
    const level = levelOf(c.req.query("level"));
    if (level === "install") {
      return c.json(wire(await db.transaction((tx) => readInstallSwitches(tx))));
    }
    const teamId = c.get("team").id;
    if (level === "team")
      return c.json(wire(await withTeam(db, teamId, (tx) => readTeamSwitches(tx, teamId))));
    const s = await withTeam(db, teamId, (tx) => readSwitches(tx, teamId));
    return c.json({
      memory_enabled: s.effective.user,
      project_memory_enabled: s.effective.project,
    });
  });

  app.put("/", async (c) => {
    const body = await parseBody(c, memorySettingsSchema);
    if (!body || (body.memory_enabled === undefined && body.project_memory_enabled === undefined)) {
      return invalidRequest(c, "Send memory_enabled and/or project_memory_enabled.");
    }
    if (levelOf(c.req.query("level")) === "install") {
      const next = await db.transaction(async (tx) => {
        const saved = await writeInstallSwitches(tx, changeOf(body));
        await recordAudit(tx, {
          action: "memory.install_settings_changed",
          target: {
            memoryEnabled: saved.memoryEnabled,
            projectMemoryEnabled: saved.projectMemoryEnabled,
          },
        });
        return saved;
      });
      return c.json(wire(next));
    }
    const teamId = c.get("team").id;
    const next = await withTeam(db, teamId, async (tx) => {
      const saved = await writeTeamSwitches(tx, teamId, c.get("user").id, changeOf(body));
      await recordAudit(tx, {
        action: "memory.settings_changed",
        teamId,
        target: {
          memoryEnabled: saved.memoryEnabled,
          projectMemoryEnabled: saved.projectMemoryEnabled,
        },
      });
      return saved;
    });
    return c.json(wire(next));
  });

  return app;
}
