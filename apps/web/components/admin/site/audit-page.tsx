"use client";

import Link from "next/link";
import { useState } from "react";
import type { ApiResult } from "../../../lib/api/client";
import {
  listSiteAudit,
  type AuditFilters,
  type SiteAuditPage,
} from "../../../lib/admin/api/site/audit";
import { AUDIT_PII_RETENTION_HOURS, getSiteSettings } from "../../../lib/admin/api/site/settings";
import { listSiteTeams } from "../../../lib/admin/api/site/teams";
import { listUsers } from "../../../lib/admin/api/site/users";
import { consoleHref } from "../../../lib/admin/nav/registry";
import { Notice, PageHeader, Section } from "../../ui/console";
import { ResourceView } from "../parts";
import { useResource } from "../use-resource";
import { AuditEventsTable } from "./audit-events";
import { AuditFilterForm, type FilterOption } from "./audit-filters";
import { AuditIntegritySection } from "./audit-integrity";

/** What the filters and the table need besides the events; each part may be missing. */
interface AuditContext {
  readonly users: readonly FilterOption[] | null;
  readonly teams: readonly FilterOption[] | null;
  /** Hours the IP and user agent are kept; null when the setting could not be read. */
  readonly piiHours: number | null;
}

async function loadContext(): Promise<ApiResult<AuditContext>> {
  const [users, teams, settings] = await Promise.all([
    listUsers(),
    listSiteTeams(),
    getSiteSettings(),
  ]);
  const byLabel = (a: FilterOption, b: FilterOption) => a.label.localeCompare(b.label);
  return {
    ok: true,
    status: 200,
    data: {
      users: users.ok
        ? users.data.map((u) => ({ id: u.id, label: `${u.name} (${u.email})` })).sort(byLabel)
        : null,
      teams: teams.ok ? teams.data.map((t) => ({ id: t.id, label: t.name })).sort(byLabel) : null,
      piiHours: settings.ok
        ? (settings.data.auditPiiRetentionHours ?? AUDIT_PII_RETENTION_HOURS.default)
        : null,
    },
  };
}

async function loadEvents(
  filters: AuditFilters,
): Promise<ApiResult<{ page: SiteAuditPage; filters: AuditFilters }>> {
  const res = await listSiteAudit(filters);
  return res.ok ? { ...res, data: { page: res.data, filters } } : res;
}

/**
 * The site-wide audit log (spec D6, D8; `GET /v1/site/audit`, site Owner and Admins): read-only,
 * newest first, filtered by the server and paged with "Load more", with the hash chain's
 * verification status. Event fields are shown as plain text, and the IP address and user agent
 * only until the site's erasure period has passed (KOBE-17).
 */
export function SiteAuditPage() {
  const context = useResource(loadContext);
  const [filters, setFilters] = useState<AuditFilters>({});
  // Each result carries the filters it was read with, so "Load more" pages the same view.
  const events = useResource(() => loadEvents(filters));

  function apply(next: AuditFilters) {
    setFilters(next);
    events.reload();
  }

  const ctx = context.state.status === "ready" ? context.state.data : null;
  const teamNames = new Map((ctx?.teams ?? []).map((t) => [t.id, t.label]));
  const settingsHref = `${consoleHref("site")}/settings`;

  return (
    <>
      <PageHeader
        title="Audit log"
        description="Every recorded event on the site, newest first. The log is append-only: nothing here can change it."
      />
      <AuditIntegritySection />
      <Section id="audit-events-heading" title="Events">
        <AuditFilterForm
          users={ctx?.users ?? []}
          teams={ctx?.teams ?? []}
          busy={events.state.status === "loading"}
          onApply={apply}
        />
        {ctx && (ctx.users === null || ctx.teams === null) && (
          <Notice tone="warn" role="status">
            <p>The list of users or teams could not be loaded, so those filters are empty.</p>
          </Notice>
        )}
        {ctx && (
          <p className="text-sm text-console-muted">
            {ctx.piiHours === null ? (
              "IP addresses and user agents are hidden: the erasure period could not be read."
            ) : (
              <>
                IP addresses and user agents are shown for {ctx.piiHours}{" "}
                {ctx.piiHours === 1 ? "hour" : "hours"} after each event, then erased (
                <Link href={settingsHref}>Settings</Link>).
              </>
            )}
          </p>
        )}
        <ResourceView state={events.state} label="audit events">
          {(first) => (
            <AuditEventsTable
              first={first.page}
              filters={first.filters}
              teamNames={teamNames}
              piiHours={ctx ? ctx.piiHours : null}
            />
          )}
        </ResourceView>
      </Section>
    </>
  );
}
