"use client";

import Link from "next/link";
import { useState } from "react";
import type { ApiResult } from "../../../lib/api/client";
import { AUDIT_PII_RETENTION_HOURS, getSiteSettings } from "../../../lib/admin/api/site/settings";
import { listSiteTeams } from "../../../lib/admin/api/site/teams";
import { listUsers } from "../../../lib/admin/api/site/users";
import { consoleHref } from "../../../lib/admin/nav/registry";
import { Notice, PageHeader, Section } from "../../ui/console";
import { ErrorNotice } from "../error-notice";
import { useResource } from "../use-resource";
import { AuditEventsTable, eventCount } from "./audit-events";
import { AuditFilterForm, type FilterOption } from "./audit-filters";
import { AuditIntegritySection } from "./audit-integrity";
import { useAuditView, type AuditView } from "./use-audit-view";

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

const EVENTS_HEADING = "audit-events-heading";

/** What the live region says when a view has loaded. */
function viewMessage(view: AuditView): string {
  if (view.status === "loading") return "Loading audit events…";
  if (view.status === "error") return "The audit events could not be loaded.";
  const n = view.page.events.length;
  if (n === 0) return "No events match these filters.";
  return `Showing ${eventCount(n)}${view.page.nextCursor === null ? "." : "; more can be loaded."}`;
}

/** A filter the server refused: an unknown action name is the likely cause, so say that. */
function ViewError({ view }: { readonly view: Extract<AuditView, { status: "error" }> }) {
  if (view.error.status === 400 && view.filters.action) {
    return (
      <Notice tone="error">
        <p>
          No action is called <code>{view.filters.action}</code>, or another filter is out of range.
          Check the name: the actions are listed in docs/audit-log.md.
        </p>
      </Notice>
    );
  }
  return <ErrorNotice error={view.error} />;
}

/**
 * The site-wide audit log (spec D6, D8; `GET /v1/site/audit`, site Owner and Admins): read-only,
 * newest first, filtered by the server and paged with "Load more" (a polite live region says what
 * each load brought), with the hash chain's verification on request. Event fields are shown as plain text, and the IP address and user agent
 * only until the site's erasure period has passed (KOBE-17).
 */
export function SiteAuditPage() {
  const context = useResource(loadContext);
  const { view, load } = useAuditView();
  const [paged, setPaged] = useState<{ readonly view: number; readonly message: string } | null>(
    null,
  );
  // The live region speaks for the latest view, or for its latest "Load more".
  const message = paged !== null && paged.view === view.id ? paged.message : viewMessage(view);

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
      <Section id={EVENTS_HEADING} title="Events">
        <AuditFilterForm
          users={ctx?.users ?? []}
          teams={ctx?.teams ?? []}
          busy={view.status === "loading"}
          onApply={load}
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
                {ctx.piiHours === 1 ? "hour" : "hours"} after each event and hidden here after that
                (<Link href={settingsHref}>Settings</Link>).
              </>
            )}
          </p>
        )}
        <div role="status" aria-live="polite" className="sr-only">
          {message}
        </div>
        {view.status === "loading" && <p aria-hidden="true">Loading audit events…</p>}
        {view.status === "error" && <ViewError view={view} />}
        {view.status === "ready" && (
          <AuditEventsTable
            key={view.id}
            first={view.page}
            filters={view.filters}
            teamNames={teamNames}
            piiHours={ctx ? ctx.piiHours : null}
            headingId={EVENTS_HEADING}
            announce={(text) => setPaged({ view: view.id, message: text })}
          />
        )}
      </Section>
    </>
  );
}
