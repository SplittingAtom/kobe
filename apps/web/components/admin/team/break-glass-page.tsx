"use client";

import { listTeamGrants, type TeamGrant } from "../../../lib/admin/api/team/break-glass";
import { useTeamAccess } from "../console-context";
import { DateTime, ResourceView } from "../parts";
import { useResource } from "../use-resource";
import styles from "../admin.module.css";

function scopeText(g: TeamGrant): string {
  switch (g.scope) {
    case "restricted":
      return "Restricted (legal hold)";
    case "user":
      return `Threads of ${g.subject?.name ?? "one member"}`;
    case "thread":
      return `Thread ${g.threadId ?? ""}`;
    default:
      return "All of the team's threads";
  }
}

function approval(g: TeamGrant): string {
  if (!g.approvedBy) return "";
  return g.selfApproved
    ? `Self-approved by ${g.approvedBy.name}: single-admin install (flagged).`
    : `Approved by ${g.approvedBy.name}.`;
}

/** One banner per active grant: who can read what, until when, and why (unless a legal hold). */
export function BreakGlassBanners({ grants }: { readonly grants: readonly TeamGrant[] }) {
  return (
    <>
      {grants.map((g) => (
        <div
          key={g.id}
          className={styles.banner}
          role="note"
          aria-label="Active break-glass access"
        >
          <strong>{g.requestedBy.name}</strong> (install admin) has read-only break-glass access to
          this team until <DateTime value={g.expiresAt} />. Scope: {scopeText(g)}. {approval(g)}
          {g.reason && <> Reason: {g.reason}</>}
        </div>
      ))}
    </>
  );
}

/**
 * Break-glass on this team (spec D10; `/v1/team/break-glass`, team admins): banners for active
 * access and the history of grants. Each read under a grant is in the team's audit log as
 * `governance.break_glass.read`.
 */
export function TeamBreakGlassPage() {
  const teamId = useTeamAccess().team.id;
  const { state } = useResource(() => listTeamGrants(teamId));

  return (
    <>
      <h1>Break-glass access</h1>
      <p className={styles.hint}>
        Install admins can read this team&apos;s content only through break-glass: read-only,
        time-boxed, approved by a second install admin, and recorded read by read in the team&apos;s
        audit log.
      </p>
      <ResourceView state={state} label="break-glass access">
        {({ active, recent }) => (
          <>
            {active.length === 0 ? (
              <p role="status">No install admin has break-glass access to this team now.</p>
            ) : (
              <BreakGlassBanners grants={active} />
            )}
            <h2>History</h2>
            {recent.length === 0 ? (
              <p>No earlier break-glass access.</p>
            ) : (
              <div className={styles.tableWrap}>
                <table className={styles.table}>
                  <caption>Earlier grants</caption>
                  <thead>
                    <tr>
                      <th scope="col">Install admin</th>
                      <th scope="col">Scope</th>
                      <th scope="col">Reason</th>
                      <th scope="col">From</th>
                      <th scope="col">Until</th>
                      <th scope="col">Ended</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recent.map((g) => (
                      <tr key={g.id}>
                        <td>
                          {g.requestedBy.name}
                          <br />
                          {approval(g)}
                        </td>
                        <td>{scopeText(g)}</td>
                        <td>{g.reason ?? "Not shown (legal hold)"}</td>
                        <td>
                          <DateTime value={g.startsAt} />
                        </td>
                        <td>
                          <DateTime value={g.expiresAt} />
                        </td>
                        <td>{g.status === "revoked" ? "Revoked" : "Expired"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </ResourceView>
    </>
  );
}
