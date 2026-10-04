"use client";

import {
  decideEgressRequest,
  listEgressRequests,
  type TeamEgressRequest,
} from "../../../lib/admin/api/team/egress";
import { useTeamAccess } from "../console-context";
import { MutationStatus } from "../error-notice";
import { DateTime, ResourceView } from "../parts";
import { useMutation, useResource } from "../use-resource";
import styles from "../admin.module.css";

/**
 * Pending access requests (KOBE-39, D28): a member's sandbox was blocked from a host and they asked
 * for it. Approve enables the ceiling pattern shown (and settles everyone's requests for it);
 * deny tells the requesters. Only domain and thread metadata are shown.
 */
export function EgressRequests({ onDecided }: { readonly onDecided: () => void }) {
  const teamId = useTeamAccess().team.id;
  const { state, reload } = useResource(() => listEgressRequests(teamId));
  const mutation = useMutation();

  async function decide(r: TeamEgressRequest, decision: "approve" | "deny") {
    const done = await mutation.run(
      () => decideEgressRequest(teamId, r.id, decision),
      () =>
        decision === "approve"
          ? `Approved: ${r.pattern} is enabled for the team's sandboxes. ${r.requestedBy.name} was told.`
          : `Denied ${r.pattern}. ${r.requestedBy.name} was told.`,
    );
    if (done) {
      reload();
      onDecided();
    }
  }

  return (
    <section aria-labelledby="egress-requests">
      <h2 id="egress-requests">Access requests</h2>
      <MutationStatus error={mutation.error} notice={mutation.notice} />
      <ResourceView state={state} label="access requests">
        {(requests) =>
          requests.length === 0 ? (
            <p>No pending requests.</p>
          ) : (
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <caption>Pending requests ({requests.length})</caption>
                <thead>
                  <tr>
                    <th scope="col">Blocked host</th>
                    <th scope="col">Enables</th>
                    <th scope="col">Requested by</th>
                    <th scope="col">When</th>
                    <th scope="col">Decision</th>
                  </tr>
                </thead>
                <tbody>
                  {requests.map((r) => (
                    <tr key={r.id}>
                      <th scope="row">
                        <code>{r.domain}</code>
                      </th>
                      <td>
                        <code>{r.pattern}</code>
                      </td>
                      <td>
                        {r.requestedBy.name}
                        {r.threadId ? (
                          <span className={styles.hint}> (thread {r.threadId.slice(0, 8)})</span>
                        ) : null}
                      </td>
                      <td>
                        <DateTime value={r.createdAt} />
                      </td>
                      <td className={styles.actions}>
                        <button
                          type="button"
                          disabled={mutation.pending}
                          onClick={() => void decide(r, "approve")}
                        >
                          Approve<span className={styles.visuallyHidden}> {r.domain}</span>
                        </button>
                        <button
                          type="button"
                          disabled={mutation.pending}
                          onClick={() => void decide(r, "deny")}
                        >
                          Deny<span className={styles.visuallyHidden}> {r.domain}</span>
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
      </ResourceView>
    </section>
  );
}
