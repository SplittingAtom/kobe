import { sql, withTeam, type KobeDb } from "@kobe/db";

/**
 * `eval-cases.json` in a member's export (KOBE-276): the eval cases they shared in the team, with
 * the copy they consented to and its review status (not the owner's expected behaviour: that is
 * the owner's text). Their rows only, page by page in short transactions.
 */

const PAGE = 100;

type Row = {
  readonly id: string;
  readonly agent_scope: string;
  readonly agent_id: string;
  readonly agent_version: number | null;
  readonly status: string;
  readonly content: unknown;
  readonly created_at: Date | string;
};

export interface ExportedEvalCase {
  readonly id: string;
  readonly agent: { readonly scope: string; readonly id: string; readonly version: number | null };
  readonly status: string;
  readonly content: unknown;
  readonly shared_at: string;
}

const iso = (t: Date | string) => (t instanceof Date ? t : new Date(t)).toISOString();

/** The viewer's own cases in the team, oldest id first, a page at a time. */
export async function* evalCasesForExport(
  db: KobeDb,
  viewer: { readonly teamId: string; readonly userId: string },
): AsyncGenerator<ExportedEvalCase[]> {
  let after: string | null = null;
  for (;;) {
    const cursor: string | null = after;
    const rows: Row[] = await withTeam(db, viewer.teamId, async (tx): Promise<Row[]> => {
      const res = await tx.execute<Row>(sql`
        SELECT c.id, c.agent_scope, c.agent_id, c.agent_version, c.status, c.content, c.created_at
          FROM agent_eval_cases c
         WHERE c.team_id = ${viewer.teamId} AND c.user_id = ${viewer.userId}
           ${cursor === null ? sql.raw("") : sql`AND c.id > ${cursor}::uuid`}
         ORDER BY c.id LIMIT ${PAGE}`);
      return res.rows;
    });
    yield rows.map((r) => ({
      id: r.id,
      agent: { scope: r.agent_scope, id: r.agent_id, version: r.agent_version },
      status: r.status,
      content: r.content,
      shared_at: iso(r.created_at),
    }));
    after = rows.at(-1)?.id ?? null;
    if (rows.length < PAGE || after === null) return;
  }
}
