import { KOBE_ADMIN_SUMMARY_MAX, parseMcpToolName, type KobeAdminApproval } from "@kobe/protocol";
import { sql, type KobeTx } from "@kobe/db";
import { isWriteTool } from "./catalog.js";
import { kobeToolByName } from "./tools/index.js";

/**
 * The "Admin change" approval card's scope and summary (KOBE-623, spec kobe-admin-mcp §6): built
 * by the server from the approved input with the tool's own `summary`, never from model text, with
 * the ids it names replaced by names the approver recognises ("Ana Lee", "Team Research"). The
 * card still shows the exact input below the summary, so a name never hides what runs.
 *
 * Names are read in the approval's own team transaction (RLS applies to the team tables), one
 * primary-key lookup per id, shown quoted with a short id; an id that does not resolve stays as
 * the id itself.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Reader = Pick<KobeTx, "execute">;

/** Where the ids of an input are looked up: the tool's scope and the approval's team. */
export interface NameScope {
  readonly scope: "team" | "site";
  readonly teamId: string;
}

type Namer = (db: Reader, id: string, where: NameScope) => Promise<string | undefined>;

/**
 * Input keys whose id names something with a name, and how to read it. A person is named only as
 * a member of the approval's team for a team tool (a site tool may name any user); a team only for
 * a site tool (a team tool acts on its own team).
 */
const NAMERS: Readonly<Record<string, Namer>> = {
  user_id: (db, id, where) =>
    where.scope === "team"
      ? one(
          db,
          sql`SELECT u.name FROM public.team_members m JOIN public.users u ON u.id = m.user_id
               WHERE m.team_id = ${where.teamId} AND m.user_id = ${id}`,
        )
      : one(db, sql`SELECT name FROM public.users WHERE id = ${id}`),
  connector_id: (db, id) => one(db, sql`SELECT name FROM public.connectors WHERE id = ${id}`),
  team_id: (db, id, where) =>
    where.scope === "site"
      ? one(db, sql`SELECT name FROM public.teams WHERE id = ${id}`)
      : Promise.resolve(undefined),
  invitation_id: (db, id, where) =>
    one(
      db,
      sql`SELECT email AS name FROM public.team_invitations
           WHERE team_id = ${where.teamId} AND id = ${id}`,
    ),
  request_id: (db, id, where) =>
    one(
      db,
      sql`SELECT domain AS name FROM public.egress_requests
           WHERE team_id = ${where.teamId} AND id = ${id}`,
    ),
};

async function one(db: Reader, query: ReturnType<typeof sql>): Promise<string | undefined> {
  const res = await db.execute<{ name: string | null }>(query);
  const name = res.rows[0]?.name;
  return typeof name === "string" && name.trim() !== "" ? name.trim().slice(0, 120) : undefined;
}

/**
 * How a resolved id is shown: the name quoted (inner quotes and line breaks neutralised) with the
 * id's first 8 characters, so a crafted display name can't pass for something else:
 * `"Ana Lee" (11111111…)`.
 */
export function labelled(name: string, id: string): string {
  const clean = name.replace(/["\u201c\u201d]/g, "'").replace(/\s+/g, " ");
  return `"${clean}" (${id.slice(0, 8)}…)`;
}

/** The input's named ids (`user_id` → label), resolved; unknown or unreadable ids are left out. */
export async function resolveNames(
  db: Reader,
  input: Readonly<Record<string, unknown>>,
  where: NameScope,
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  for (const [key, value] of Object.entries(input)) {
    const namer = NAMERS[key];
    if (namer === undefined || typeof value !== "string" || !UUID.test(value)) continue;
    const name = await namer(db, value, where);
    if (name !== undefined) names.set(value, labelled(name, value));
  }
  return names;
}

/** `summary` with each resolved id replaced by its label (bounded, single line). */
export function withNames(summary: string, names: ReadonlyMap<string, string>): string {
  let out = summary;
  for (const [id, label] of names) out = out.split(id).join(label);
  return out.replace(/\s+/g, " ").trim().slice(0, KOBE_ADMIN_SUMMARY_MAX);
}

/** The team's name for the scope label. */
async function teamName(db: Reader, teamId: string): Promise<string | undefined> {
  return one(db, sql`SELECT name FROM public.teams WHERE id = ${teamId}`);
}

/**
 * The card for a Kobe admin write (`piName` = `mcp__<kobe>__<tool>`), or undefined for anything
 * else (a read, a docs tool, an unknown tool). An input the tool's schema refuses still gets a card
 * (the call is refused after the approval anyway): its summary names the tool only.
 */
export async function kobeAdminApprovalCard(
  db: Reader,
  teamId: string,
  piName: string,
  input: Readonly<Record<string, unknown>>,
): Promise<KobeAdminApproval | undefined> {
  const name = parseMcpToolName(piName)?.tool_segment;
  const tool = name === undefined ? undefined : kobeToolByName(name);
  if (tool === undefined || !isWriteTool(tool)) return undefined;
  const parsed = tool.input.safeParse(input);
  const raw = parsed.success ? tool.summary(parsed.data) : `${tool.title} (input not valid)`;
  const where: NameScope = { scope: tool.scope, teamId };
  const summary = withNames(raw, await resolveNames(db, input, where)) || tool.title;
  if (tool.scope === "site") return { scope: "site", scope_label: "Whole site", summary };
  const team = await teamName(db, teamId);
  return {
    scope: "team",
    scope_label: (team === undefined ? "This team" : `Team ${team}`).slice(0, 200),
    summary,
  };
}
