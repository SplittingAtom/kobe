"use client";

import type { ReactNode } from "react";
import {
  AUTH_LABELS,
  CREDENTIAL_LABELS,
  listConnectorTemplates,
  listConnectorTeams,
  listConnectorTools,
  type Connector,
  type ConnectorTeamUse,
  type TemplateReview,
} from "../../../lib/admin/api/site/connectors";
import { EXPOSURE_LABELS } from "../../../lib/admin/api/team/connectors";
import { Badge, Section, SidePanel } from "../../ui/console";
import { DateTime, ResourceView } from "../parts";
import { useResource } from "../use-resource";
import { ConnectorDetailTools } from "./connector-detail-tools";
import { RefreshSkipped } from "./connector-refresh-skipped";

/**
 * A connector's details in the Site connector registry (KOBE-641), opened from its name: what it
 * is, which teams enabled it and how, its MCP Apps templates and every pinned tool. Read-only:
 * actions (Review, Re-probe, Enable/Disable, Site key) stay in the registry row. Never shows a
 * credential: for a site-wide key only whether it is set, not even its hint.
 */
const PLACEMENT_LABELS: Readonly<Record<string, string>> = {
  chat: "Chat card",
  artifacts: "Artifact column",
  rail: "Rail",
};

function Row({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <>
      <dt className="text-console-muted">{label}</dt>
      <dd className="m-0 min-w-0 break-words">{children}</dd>
    </>
  );
}

function siteKeyState(c: Connector): string {
  if (c.siteKeyHint === null) return "not set";
  return c.siteKeyStale ? "re-enter it (the server URL changed)" : "set";
}

function About({ connector: c }: { readonly connector: Connector }) {
  return (
    <Section level={3} title={`About ${c.name}`} className="mt-3">
      <dl className="m-0 grid grid-cols-[minmax(7rem,auto)_1fr] gap-x-3 gap-y-1 text-sm">
        <Row label="Server URL">
          <code className="break-all">{c.url}</code>
        </Row>
        <Row label="Authentication">{AUTH_LABELS[c.authKind]}</Row>
        {c.authKind === "api_key" ? (
          <Row label="Whose key">
            {CREDENTIAL_LABELS[c.credentialSource]}
            {c.credentialSource === "site" ? ` (${siteKeyState(c)})` : null}
          </Row>
        ) : null}
        <Row label="Status">
          <Badge tone={c.status === "active" ? "running" : "neutral"}>
            {c.status === "active" ? "Active" : "Disabled"}
          </Badge>
        </Row>
        <Row label="Last checked">
          {c.refreshedAt ? <DateTime value={c.refreshedAt} /> : "Never"}
          <RefreshSkipped connector={c} />
        </Row>
        <Row label="Tools">
          {c.toolCount}
          {c.driftedCount > 0 ? `, ${c.driftedCount} awaiting approval` : ""}
        </Row>
        <Row label="App templates">
          {c.templatesCount ?? 0}
          {(c.templatesDriftedCount ?? 0) > 0
            ? `, ${c.templatesDriftedCount} awaiting approval`
            : ""}
        </Row>
      </dl>
    </Section>
  );
}

function exposureText(t: ConnectorTeamUse): string {
  const label = EXPOSURE_LABELS[t.exposure];
  return t.exposure === "custom" ? `${label} (${t.enabledTools})` : label;
}

function Teams({ teams }: { readonly teams: readonly ConnectorTeamUse[] }) {
  if (teams.length === 0) return <p className="m-0 text-sm">No team has enabled it.</p>;
  return (
    <ul className="m-0 grid list-none gap-1 p-0 text-sm">
      {teams.map((t) => (
        <li key={t.id} aria-label={t.name} className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{t.name}</span>
          <Badge>{exposureText(t)}</Badge>
        </li>
      ))}
    </ul>
  );
}

function Templates({ templates }: { readonly templates: readonly TemplateReview[] }) {
  if (templates.length === 0) return <p className="m-0 text-sm">This connector has no apps.</p>;
  return (
    <ul className="m-0 grid list-none gap-1 p-0 text-sm">
      {templates.map((t) => (
        <li key={t.uri} aria-label={t.uri} className="flex flex-wrap items-center gap-2">
          <code className="break-all">{t.uri}</code>
          {t.status === "pinned" ? (
            <>
              <Badge tone="done">Approved</Badge>
              <span className="text-console-muted">
                Opens in: {PLACEMENT_LABELS[t.placement ?? "chat"] ?? t.placement}
              </span>
            </>
          ) : (
            <Badge tone="attention">Awaiting review</Badge>
          )}
        </li>
      ))}
    </ul>
  );
}

export function ConnectorDetailPanel({
  connector: c,
  onClose,
  returnFocus,
}: {
  readonly connector: Connector;
  readonly onClose: () => void;
  readonly returnFocus: () => HTMLElement | null;
}) {
  const tools = useResource(() => listConnectorTools(c.id)).state;
  const templates = useResource(() => listConnectorTemplates(c.id)).state;
  const teams = useResource(() => listConnectorTeams(c.id)).state;
  const loadedTemplates = templates.status === "ready" ? templates.data : null;

  return (
    <SidePanel
      open
      onOpenChange={(open) => (open ? undefined : onClose())}
      title={`Connector ${c.name}`}
      returnFocus={returnFocus}
    >
      <About connector={c} />
      <Section level={3} title={`Teams using ${c.name}`} className="mt-4">
        <ResourceView state={teams} label="teams">
          {(list) => <Teams teams={list} />}
        </ResourceView>
      </Section>
      <Section level={3} title={`App templates of ${c.name}`} className="mt-4">
        <ResourceView state={templates} label="app templates">
          {(list) => <Templates templates={list} />}
        </ResourceView>
      </Section>
      <Section level={3} title={`Tools of ${c.name}`} className="mt-4">
        <ResourceView state={tools} label="tools">
          {(list) => (
            <ConnectorDetailTools connectorName={c.name} tools={list} templates={loadedTemplates} />
          )}
        </ResourceView>
      </Section>
    </SidePanel>
  );
}
