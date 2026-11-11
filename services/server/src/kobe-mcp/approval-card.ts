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
 * primary-key lookup per id; an id that does not resolve stays as it is.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Reader = Pick<KobeTx, "execute">;

/** Input keys whose id names something with a name, and how to read it. */
const NAMERS: Readonly<Record<string, (db: Reader, id: string) => Promise<string | undefined>>> = {
  user_id: (db, id) => one(db, sql`SELECT name FROM public.users WHERE id = ${id}`),
  connector_id: (db, id) => one(db, sql`SELECT name FROM public.connectors WHERE id = ${id}`),
  team_id: (db, id) => one(db, sql`SELECT name FROM public.teams WHERE id = ${id}`),
  invitation_id: (db, id) =>
    one(db, sql`SELECT email AS name FROM public.team_invitations WHERE id = ${id}`),
  request_id: (db, id) =>
    one(db, sql`SELECT domain AS name FROM public.egress_requests WHERE id = ${id}`),
};

async function one(db: Reader, query: ReturnType<typeof sql>): Promise<string | undefined> {
  const res = await db.execute<{ name: string | null }>(query);
  const name = res.rows[0]?.name;
  return typeof name === "string" && name.trim() !== "" ? name.trim().slice(0, 200) : undefined;
}

/** The input's named ids (`user_id` → name), resolved; unknown or unreadable ids are left out. */
export async function resolveNames(
  db: Reader,
  input: Readonly<Record<string, unknown>>,
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  for (const [key, value] of Object.entries(input)) {
    const namer = NAMERS[key];
    if (namer === undefined || typeof value !== "string" || !UUID.test(value)) continue;
    const name = await namer(db, value);
    if (name !== undefined) names.set(value, name);
  }
  return names;
}

/** `summary` with each resolved id replaced by its name (bounded, single line). */
export function withNames(summary: string, names: ReadonlyMap<string, string>): string {
  let out = summary;
  for (const [id, name] of names) out = out.split(id).join(name);
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
  const summary = withNames(raw, await resolveNames(db, input)) || tool.title;
  if (tool.scope === "site") return { scope: "site", scope_label: "Whole site", summary };
  const team = await teamName(db, teamId);
  return {
    scope: "team",
    scope_label: (team === undefined ? "This team" : `Team ${team}`).slice(0, 200),
    summary,
  };
}
