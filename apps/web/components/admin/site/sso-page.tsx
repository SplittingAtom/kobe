"use client";

import { useState } from "react";
import {
  deleteSsoProvider,
  listSsoProviders,
  testSsoProvider,
  updateSsoProvider,
  type DiscoveryReport,
  type SsoProvider,
} from "../../../lib/admin/api/site/sso";
import {
  Badge,
  Button,
  EmptyState,
  PageHeader,
  Section,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableRowHeader,
  eventTrigger,
  useConfirm,
} from "../../ui/console";
import { MutationStatus } from "../error-notice";
import { ResourceView } from "../parts";
import { useMutation, useResource } from "../use-resource";
import { DiscoveryResult } from "./sso-discovery";
import { ScimPanel } from "./sso-scim";
import { SsoProviderForm } from "./sso-provider-form";

const HEADING = "sso-providers";

function callbackBase(): string {
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  return `${origin}/api/auth/sso/callback/`;
}

type Editing = { readonly mode: "add" } | { readonly mode: "edit"; readonly provider: SsoProvider };

/**
 * Single sign-on providers (`/v1/site/sso/providers`, spec sso-oidc-scim §4, KOBE-626): list,
 * add, edit, turn on or off, test discovery and delete. Providers from the chart's values are
 * read-only here. The page exists only while `auth.sso.enabled` is on (the nav hides it otherwise).
 */
export function SiteSsoPage() {
  const { state, reload } = useResource(listSsoProviders);
  const mutation = useMutation();
  const [confirm, confirmDialog] = useConfirm();
  const [editing, setEditing] = useState<Editing | null>(null);
  const [tested, setTested] = useState<{ id: string; report: DiscoveryReport } | null>(null);
  const [scimFor, setScimFor] = useState<SsoProvider | null>(null);

  async function toggle(p: SsoProvider, trigger: HTMLElement | null) {
    if (p.enabled) {
      const yes = await confirm(
        {
          title: `Turn off ${p.displayName}?`,
          description: "People can no longer sign in with it, and its sign-in sessions end now.",
          confirmLabel: "Turn off",
        },
        trigger,
      );
      if (!yes) return;
    }
    const done = await mutation.run(
      () => updateSsoProvider(p.id, { enabled: !p.enabled }),
      () => `${p.displayName} is ${p.enabled ? "off" : "on"}.`,
    );
    if (done) reload();
  }

  async function test(p: SsoProvider) {
    setTested(null);
    await mutation.run(
      () => testSsoProvider(p.id),
      (report) => {
        setTested({ id: p.id, report });
        return null;
      },
    );
  }

  async function remove(p: SsoProvider, trigger: HTMLElement | null) {
    const yes = await confirm(
      {
        title: `Delete ${p.displayName}?`,
        description: "Only possible while nobody has signed in with it; otherwise turn it off.",
        confirmLabel: "Delete",
      },
      trigger,
    );
    if (!yes) return;
    if (
      await mutation.run(
        () => deleteSsoProvider(p.id),
        () => `Deleted ${p.displayName}.`,
      )
    ) {
      reload();
    }
  }

  return (
    <>
      <PageHeader
        title="Single sign-on"
        description="People sign in with your organization's identity provider. Local sign-in keeps working beside it."
      />
      <MutationStatus error={mutation.error} notice={mutation.notice} />
      {editing ? (
        <SsoProviderForm
          key={editing.mode === "edit" ? editing.provider.id : "new"}
          {...(editing.mode === "edit" ? { provider: editing.provider } : {})}
          callbackBase={callbackBase()}
          mutation={mutation}
          onSaved={() => {
            setEditing(null);
            reload();
          }}
          onCancel={() => setEditing(null)}
        />
      ) : null}
      <Section
        id={HEADING}
        title="Providers"
        actions={
          editing ? null : (
            <Button variant="primary" onClick={() => setEditing({ mode: "add" })}>
              Add provider
            </Button>
          )
        }
      >
        <ResourceView state={state} label="providers">
          {(providers) =>
            providers.length === 0 ? (
              <EmptyState title="No identity provider yet." />
            ) : (
              <Table caption="Single sign-on providers" hideCaption>
                <TableHead>
                  <TableRow>
                    <TableHeader>Provider</TableHeader>
                    <TableHeader>Issuer</TableHeader>
                    <TableHeader>Redirect URI</TableHeader>
                    <TableHeader>Client secret</TableHeader>
                    <TableHeader>Status</TableHeader>
                    <TableHeader>
                      <span className="sr-only">Actions</span>
                    </TableHeader>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {providers.map((p) => (
                    <ProviderRow
                      key={p.id}
                      provider={p}
                      pending={mutation.pending}
                      report={tested?.id === p.id ? tested.report : null}
                      onEdit={() => setEditing({ mode: "edit", provider: p })}
                      onToggle={(t) => void toggle(p, t)}
                      onTest={() => void test(p)}
                      onScim={() => setScimFor(p)}
                      onDelete={(t) => void remove(p, t)}
                    />
                  ))}
                </TableBody>
              </Table>
            )
          }
        </ResourceView>
      </Section>
      {scimFor ? (
        <ScimPanel key={scimFor.id} provider={scimFor} onClose={() => setScimFor(null)} />
      ) : null}
      {confirmDialog}
    </>
  );
}

function ProviderRow({
  provider: p,
  pending,
  report,
  onEdit,
  onToggle,
  onTest,
  onScim,
  onDelete,
}: {
  readonly provider: SsoProvider;
  readonly pending: boolean;
  readonly report: DiscoveryReport | null;
  readonly onEdit: () => void;
  readonly onToggle: (trigger: HTMLElement | null) => void;
  readonly onTest: () => void;
  readonly onScim: () => void;
  readonly onDelete: (trigger: HTMLElement | null) => void;
}) {
  const helm = p.managedBy === "helm";
  return (
    <TableRow>
      <TableRowHeader>
        {p.displayName}
        <div className="text-sm text-console-muted">
          {p.kind === "entra" ? "Microsoft Entra ID" : "OpenID Connect"} · {p.slug}
          {helm ? (
            <>
              {" "}
              <Badge>Set in Helm values</Badge>
            </>
          ) : null}
        </div>
        {report ? <DiscoveryResult report={report} /> : null}
      </TableRowHeader>
      <TableCell>
        <code className="break-all text-sm">{p.issuer}</code>
      </TableCell>
      <TableCell>
        <code className="break-all text-sm">{p.redirectUri}</code>
      </TableCell>
      <TableCell>
        {p.clientSecret === "set" ? <Badge>Set</Badge> : <Badge tone="attention">Missing</Badge>}
      </TableCell>
      <TableCell>{p.enabled ? <Badge tone="done">On</Badge> : <Badge>Off</Badge>}</TableCell>
      <TableCell>
        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" disabled={pending} onClick={onTest}>
            Test<span className="sr-only"> {p.displayName}</span>
          </Button>
          <Button size="sm" disabled={pending} onClick={onScim}>
            SCIM<span className="sr-only"> provisioning for {p.displayName}</span>
          </Button>
          {helm ? null : (
            <>
              <Button size="sm" disabled={pending} onClick={onEdit}>
                Edit<span className="sr-only"> {p.displayName}</span>
              </Button>
              <Button size="sm" disabled={pending} onClick={(e) => onToggle(eventTrigger(e))}>
                {p.enabled ? "Turn off" : "Turn on"}
                <span className="sr-only"> {p.displayName}</span>
              </Button>
              <Button
                size="sm"
                variant="danger"
                disabled={pending}
                onClick={(e) => onDelete(eventTrigger(e))}
              >
                Delete<span className="sr-only"> {p.displayName}</span>
              </Button>
            </>
          )}
        </div>
      </TableCell>
    </TableRow>
  );
}
