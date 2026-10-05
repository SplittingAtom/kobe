import { AGENT_SLUG_MAX } from "@kobe/agent-file";
import {
  and,
  eq,
  inArray,
  installAgents,
  installAgentVersions,
  or,
  teamAgents,
  teamAgentSuspensions,
  teamAgentVersions,
  withTeam,
  type AgentScope,
  type KobeDb,
} from "@kobe/db";
import { z } from "zod";
import { canPinAgent, installVisibleTo } from "./versions.js";
import { INSTALL, TEAM, toRecord, type AgentRecord } from "./store.js";

/**
 * Agents the caller can start a chat with from the active team (KOBE-122): the same set a new
 * thread can pin (`findPinnableAgent` + `unavailable` in `versions.ts`): the team's agents, the
 * caller's own personal agents and the gallery, that are active (not suspended, install-wide or
 * for this team), not archived and published. Read-only, paginated by (slug, id), `team_id`
 * explicit on top of `withTeam()`. The model is the one the *current version* pins, since that is
 * what a new thread gets.
 */

export const RUNNABLE_PAGE_DEFAULT = 50;
export const RUNNABLE_PAGE_MAX = 200;

const CURSOR = new RegExp(
  `^([a-z0-9-]{1,${AGENT_SLUG_MAX}}):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$`,
);

export const runnableQuerySchema = z
  .object({
    cursor: z.string().regex(CURSOR).optional(),
    limit: z
      .string()
      .regex(/^[1-9][0-9]{0,2}$/)
      .transform(Number)
      .pipe(z.number().int().min(1).max(RUNNABLE_PAGE_MAX))
      .optional(),
  })
  .strict();

export interface RunnableAgent {
  readonly id: string;
  readonly scope: AgentScope;
  readonly slug: string;
  readonly name: string;
  readonly description?: string;
  readonly icon?: string;
  /** Model the current version pins (alias or id); null → the user's model choice applies. */
  readonly model: string | null;
  readonly currentVersion: number;
}

export interface RunnablePage {
  readonly agents: readonly RunnableAgent[];
  readonly nextCursor: string | null;
}

/** A published agent: `version` is its current version. */
interface Published {
  readonly agent: AgentRecord;
  readonly version: number;
}

const afterCursor = ({ agent }: Published, cursor: string | undefined): boolean => {
  const m = cursor ? CURSOR.exec(cursor) : null;
  const [, slug = "", id = ""] = m ?? [];
  if (!m) return true;
  return agent.slug > slug || (agent.slug === slug && agent.id > id);
};

/** Agents a new thread may pin (the shared rule in `versions.ts`), with their version. */
const published = (agent: AgentRecord): Published[] =>
  canPinAgent(agent) && agent.currentVersion !== null
    ? [{ agent, version: agent.currentVersion }]
    : [];

export async function listRunnableAgents(
  db: KobeDb,
  viewer: { teamId: string; userId: string },
  query: z.infer<typeof runnableQuerySchema>,
): Promise<RunnablePage> {
  const limit = query.limit ?? RUNNABLE_PAGE_DEFAULT;
  return withTeam(db, viewer.teamId, async (tx) => {
    const team = await tx.select(TEAM).from(teamAgents).where(eq(teamAgents.teamId, viewer.teamId));
    const install = await tx
      .select({ ...INSTALL, scope: installAgents.scope })
      .from(installAgents)
      .where(installVisibleTo(viewer.userId));
    const suspended = new Set(
      (
        await tx
          .select({ id: teamAgentSuspensions.agentId })
          .from(teamAgentSuspensions)
          .where(eq(teamAgentSuspensions.teamId, viewer.teamId))
      ).map((r) => r.id),
    );
    // The team's suspension is part of the effective status, as in `findPinnableAgent`.
    const effective = (a: AgentRecord): AgentRecord =>
      suspended.has(a.id) ? { ...a, status: "suspended" } : a;
    const records = [
      ...team.flatMap((r) => published(effective(toRecord("team", r)))),
      ...install.flatMap(({ scope, ...r }) => published(effective(toRecord(scope, r)))),
    ]
      .filter((p) => afterCursor(p, query.cursor))
      .sort((a, b) =>
        a.agent.slug !== b.agent.slug
          ? a.agent.slug < b.agent.slug
            ? -1
            : 1
          : a.agent.id < b.agent.id
            ? -1
            : 1,
      );
    const page = records.slice(0, limit);
    const last = page.at(-1);
    const models = await pinnedModels(tx, page);
    return {
      agents: page.map((p) => toRunnable(p, models.get(p.agent.id) ?? null)),
      nextCursor: records.length > limit && last ? `${last.agent.slug}:${last.agent.id}` : null,
    };
  });
}

type Tx = Parameters<Parameters<typeof withTeam>[2]>[0];

/** The `model` of each agent's current version (one query per table). */
async function pinnedModels(tx: Tx, page: readonly Published[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const [t, inTable] of [
    [teamAgentVersions, page.filter((p) => p.agent.scope === "team")],
    [installAgentVersions, page.filter((p) => p.agent.scope !== "team")],
  ] as const) {
    if (inTable.length === 0) continue;
    const rows = await tx
      .select({ agentId: t.agentId, frontmatter: t.frontmatter })
      .from(t)
      .where(
        and(
          inArray(
            t.agentId,
            inTable.map((p) => p.agent.id),
          ),
          or(...inTable.map((p) => and(eq(t.agentId, p.agent.id), eq(t.version, p.version)))),
        ),
      );
    for (const r of rows) {
      const model = (r.frontmatter as { model?: unknown }).model;
      if (typeof model === "string") out.set(r.agentId, model);
    }
  }
  return out;
}

const toRunnable = ({ agent: a, version }: Published, model: string | null): RunnableAgent => ({
  id: a.id,
  scope: a.scope,
  slug: a.slug,
  name: a.frontmatter.name,
  ...(a.frontmatter.description !== undefined ? { description: a.frontmatter.description } : {}),
  ...(a.frontmatter.icon !== undefined ? { icon: a.frontmatter.icon } : {}),
  model,
  currentVersion: version,
});
