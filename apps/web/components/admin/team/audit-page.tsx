"use client";

import { useState } from "react";
import type { ApiError, ApiResult } from "../../../lib/api/client";
import { listTeamAudit, type TeamAuditEvent } from "../../../lib/admin/api/team/audit";
import { listTeamGrants, type TeamGrants } from "../../../lib/admin/api/team/break-glass";
import { useTeamAccess } from "../console-context";
import { ErrorNotice } from "../error-notice";
import { DateTime, ResourceView } from "../parts";
import { useResource } from "../use-resource";
import { BreakGlassBanners } from "./break-glass-page";
import styles from "../admin.module.css";

interface AuditData {
  readonly grants: TeamGrants;
  readonly events: readonly TeamAuditEvent[];
  readonly nextCursor: string | null;
}

async function loadAudit(teamId: string): Promise<ApiResult<AuditData>> {
  const [grants, page] = await Promise.all([listTeamGrants(teamId), listTeamAudit(teamId)]);
  if (!grants.ok) return grants;
  if (!page.ok) return page;
  return {
    ok: true,
    status: 200,
    data: { grants: grants.data, events: page.data.events, nextCursor: page.data.nextCursor },
  };
}

function actorName(e: TeamAuditEvent): string {
  if (e.actor.kind === "system") return "Kobe (system)";
  return e.actor.name ?? e.actor.id ?? "Unknown";
}

/**
 * The team's audit view (spec D6; `/v1/team/audit`): every event recorded for this team, newest
 * first, with a banner for each active break-glass grant (D10). Break-glass reads appear as
 * `governance.break_glass.read`, one per page an install admin opened.
 */
export function TeamAuditPage() {
  const teamId = useTeamAccess().team.id;
  const { state } = useResource(() => loadAudit(teamId));
  const [more, setMore] = useState<readonly TeamAuditEvent[]>([]);
  const [cursor, setCursor] = useState<string | null | undefined>(undefined);
  const [error, setError] = useState<ApiError | null>(null);

  return (
    <>
      <h1>Audit view</h1>
      <ResourceView state={state} label="audit events">
        {(data) => {
          const next = cursor === undefined ? data.nextCursor : cursor;
          const events = [...data.events, ...more];
          async function loadMore() {
            const res = await listTeamAudit(teamId, next);
            if (!res.ok) return setError(res.error);
            setError(null);
            setMore((prev) => [...prev, ...res.data.events]);
            setCursor(res.data.nextCursor);
          }
          return (
            <>
              <BreakGlassBanners grants={data.grants.active} />
              <div className={styles.tableWrap}>
                <table className={styles.table}>
                  <caption>Events, newest first</caption>
                  <thead>
                    <tr>
                      <th scope="col">When</th>
                      <th scope="col">Who</th>
                      <th scope="col">What</th>
                      <th scope="col">Details</th>
                    </tr>
                  </thead>
                  <tbody>
                    {events.map((e) => (
                      <tr key={e.id}>
                        <td>
                          <DateTime value={e.at} />
                        </td>
                        <td>{actorName(e)}</td>
                        <td>
                          <code>{e.action}</code>
                        </td>
                        <td>
                          <code>{JSON.stringify(e.target)}</code>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {events.length === 0 && <p>No events yet.</p>}
              {error && <ErrorNotice error={error} />}
              {next && (
                <button type="button" onClick={() => void loadMore()}>
                  Load more
                </button>
              )}
            </>
          );
        }}
      </ResourceView>
    </>
  );
}
