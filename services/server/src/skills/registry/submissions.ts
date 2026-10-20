import { sql, type KobeDb } from "@kobe/db";

/**
 * The author's side of the review (KOBE-334, SK23): their submissions to the Site Registry, with
 * each state and what reviewers sent back with a decision (Request changes, Reject, Approve), for
 * the Workbench. Only the caller's own submissions; reviewers' comments among themselves stay in
 * the Registry, and the submitting team's ids are not repeated (the author knows where they were).
 */

export interface SubmissionNote {
  readonly action: string;
  readonly note: string;
  readonly at: string;
}

export interface Submission {
  readonly id: string;
  readonly name: string;
  readonly semver: string;
  readonly state: string;
  readonly submittedAt: string;
  readonly updatedAt: string;
  /** Approved by its submitter or confirming Team admin on a single-admin Site (SK22). */
  readonly selfApproved: boolean;
  readonly notes: readonly SubmissionNote[];
}

const DECISIONS = ["changes_requested", "rejected", "rejected_and_blocked", "approved"] as const;
const LIMIT = 100;

export async function mySubmissions(db: KobeDb, userId: string): Promise<Submission[]> {
  const res = await db.execute<{
    id: string;
    name: string;
    semver: string;
    state: string;
    submitted_at: Date;
    updated_at: Date;
    self_approved: boolean;
    notes: { action: string; note: string; at: string }[] | null;
  }>(sql`
    SELECT v.id, s.name, v.semver, v.state, v.submitted_at, v.updated_at, v.self_approved,
      (SELECT jsonb_agg(jsonb_build_object('action', e.action, 'note', e.note, 'at', e.at)
                        ORDER BY e.at, e.id)
         FROM registry_review_events e
        WHERE e.version_id = v.id AND e.note IS NOT NULL
          AND e.action::text IN (${sql.join(
            DECISIONS.map((d) => sql`${d}`),
            sql`, `,
          )})) AS notes
      FROM registry_versions v JOIN registry_skills s ON s.id = v.skill_id
     WHERE v.submitted_by = ${userId}
     ORDER BY v.submitted_at DESC, v.id LIMIT ${LIMIT}`);
  return res.rows.map((r) => ({
    id: r.id,
    name: r.name,
    semver: r.semver,
    state: r.state,
    submittedAt: new Date(r.submitted_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
    selfApproved: r.self_approved,
    notes: (r.notes ?? []).map((n) => ({
      action: n.action,
      note: n.note,
      at: new Date(n.at).toISOString(),
    })),
  }));
}
