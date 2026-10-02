"use client";

import {
  disableTeamDomain,
  enableTeamDomain,
  listTeamEgress,
  type TeamEgressDomain,
} from "../../../lib/admin/api/team/egress";
import { useTeamAccess } from "../console-context";
import { MutationStatus } from "../error-notice";
import { DateTime, ResourceView } from "../parts";
import { useMutation, useResource } from "../use-resource";
import styles from "../admin.module.css";

/** Team egress enablement (spec D6/D28; `/v1/team/egress`, KOBE-38). */
export function TeamEgressPage() {
  const teamId = useTeamAccess().team.id;
  const { state, reload } = useResource(() => listTeamEgress(teamId));
  const mutation = useMutation();

  async function toggle(d: TeamEgressDomain) {
    const done = await mutation.run(
      () => (d.enabled ? disableTeamDomain(teamId, d.domain) : enableTeamDomain(teamId, d.domain)),
      () =>
        d.enabled
          ? `Disabled ${d.domain}: the team's sandboxes can no longer reach it.`
          : `Enabled ${d.domain} for the team's sandboxes.`,
    );
    if (done) reload();
  }

  return (
    <>
      <h1>Egress</h1>
      <p className={styles.hint}>
        Your team&apos;s sandboxes reach nothing on the internet until you enable a domain here, and
        only domains in the install&apos;s egress ceiling can be enabled. Connections are HTTPS only
        and logged to the audit view. Members can&apos;t enable domains themselves; access requests
        from threads arrive with KOBE-39.
      </p>
      <MutationStatus error={mutation.error} notice={mutation.notice} />
      <ResourceView state={state} label="egress domains">
        {(domains) =>
          domains.length === 0 ? (
            <p>The install ceiling is empty: ask an install admin to add domains.</p>
          ) : (
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <caption>Domains ({domains.length})</caption>
                <thead>
                  <tr>
                    <th scope="col">Domain</th>
                    <th scope="col">Status</th>
                    <th scope="col">Enabled</th>
                    <th scope="col">Since</th>
                  </tr>
                </thead>
                <tbody>
                  {domains.map((d) => (
                    <tr key={d.domain}>
                      <th scope="row">
                        <code>{d.domain}</code>
                      </th>
                      <td>
                        {!d.inCeiling
                          ? "Suspended (not in the install ceiling)"
                          : d.enabled
                            ? "Enabled"
                            : "Off"}
                      </td>
                      <td>
                        {d.inCeiling ? (
                          <label>
                            <input
                              type="checkbox"
                              checked={d.enabled}
                              disabled={mutation.pending}
                              onChange={() => void toggle(d)}
                            />
                            <span className={styles.visuallyHidden}> {d.domain} enabled</span>
                          </label>
                        ) : (
                          <button
                            type="button"
                            disabled={mutation.pending}
                            onClick={() => void toggle(d)}
                          >
                            Disable<span className={styles.visuallyHidden}> {d.domain}</span>
                          </button>
                        )}
                      </td>
                      <td>
                        <DateTime value={d.enabledAt} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
      </ResourceView>
    </>
  );
}
