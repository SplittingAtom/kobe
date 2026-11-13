"use client";

import { useState } from "react";
import {
  createScimToken,
  getScimSetup,
  revokeScimToken,
  rotateScimToken,
  type IssuedScimToken,
  type ScimToken,
  type SsoProvider,
} from "../../../lib/admin/api/site/sso";
import {
  Badge,
  Button,
  EmptyState,
  Notice,
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
import { DateTime, ResourceView } from "../parts";
import { useMutation, useResource } from "../use-resource";

/** At most two live tokens per provider: the current one and its replacement. */
const MAX_LIVE = 2;

/**
 * SCIM provisioning for one provider (KOBE-631, spec sso-oidc-scim §10): the Tenant URL and the
 * provider's tokens. A new token is shown once, here, and never again; rotating adds a second token
 * while the first keeps working until it is revoked. Revoking is final.
 */
export function ScimPanel({
  provider,
  onClose,
}: {
  readonly provider: SsoProvider;
  readonly onClose: () => void;
}) {
  const { state, reload } = useResource(() => getScimSetup(provider.id));
  const mutation = useMutation();
  const [confirm, confirmDialog] = useConfirm();
  const [issued, setIssued] = useState<IssuedScimToken | null>(null);

  async function issue(rotating: ScimToken | null) {
    setIssued(null);
    const done = await mutation.run(
      () => (rotating ? rotateScimToken(provider.id, rotating.id) : createScimToken(provider.id)),
      (data) => {
        setIssued(data);
        return null;
      },
    );
    if (done) reload();
  }

  async function revoke(t: ScimToken, trigger: HTMLElement | null) {
    const yes = await confirm(
      {
        title: `Revoke the token ${t.prefix}…?`,
        description:
          "Provisioning with this token stops at once and it can't be turned back on. Put a newer token in the identity provider first.",
        confirmLabel: "Revoke",
      },
      trigger,
    );
    if (!yes) return;
    if (
      await mutation.run(
        () => revokeScimToken(provider.id, t.id),
        () => "Token revoked.",
      )
    ) {
      if (issued?.credential.id === t.id) setIssued(null);
      reload();
    }
  }

  return (
    <Section
      title={`SCIM provisioning: ${provider.displayName}`}
      description="Your identity provider creates, updates and deactivates Kobe accounts. Kobe never deactivates the Owner or a site Admin this way."
      actions={<Button onClick={onClose}>Close</Button>}
    >
      <MutationStatus error={mutation.error} notice={mutation.notice} />
      {provider.enabled ? null : (
        <Notice tone="warn">Provisioning works only while this provider is turned on.</Notice>
      )}
      <ResourceView state={state} label="SCIM tokens">
        {(setup) => {
          const live = setup.tokens.filter((t) => t.revokedAt === null);
          return (
            <>
              <p className="mt-2 text-sm">
                Tenant URL: <code className="break-all">{setup.baseUrl}</code>
              </p>
              {issued ? <IssuedToken issued={issued} onHide={() => setIssued(null)} /> : null}
              <div className="mt-3">
                {live.length === 0 ? (
                  <Button
                    variant="primary"
                    disabled={mutation.pending}
                    onClick={() => void issue(null)}
                  >
                    Create token
                  </Button>
                ) : null}
              </div>
              {setup.tokens.length === 0 ? (
                <EmptyState title="No SCIM token yet." />
              ) : (
                <Table caption={`SCIM tokens of ${provider.displayName}`} hideCaption>
                  <TableHead>
                    <TableRow>
                      <TableHeader>Token</TableHeader>
                      <TableHeader>Created</TableHeader>
                      <TableHeader>Last used</TableHeader>
                      <TableHeader>Status</TableHeader>
                      <TableHeader>
                        <span className="sr-only">Actions</span>
                      </TableHeader>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {setup.tokens.map((t) => (
                      <TableRow key={t.id}>
                        <TableRowHeader>
                          <code>{t.prefix}…</code>
                        </TableRowHeader>
                        <TableCell>
                          <DateTime value={t.createdAt} compact />
                        </TableCell>
                        <TableCell>
                          {t.lastUsedAt ? <DateTime value={t.lastUsedAt} compact /> : "Never"}
                        </TableCell>
                        <TableCell>
                          {t.revokedAt ? <Badge>Revoked</Badge> : <Badge tone="done">Live</Badge>}
                        </TableCell>
                        <TableCell>
                          {t.revokedAt ? null : (
                            <div className="flex flex-wrap gap-1.5">
                              {live.length < MAX_LIVE ? (
                                <Button
                                  size="sm"
                                  disabled={mutation.pending}
                                  onClick={() => void issue(t)}
                                >
                                  Rotate<span className="sr-only"> {t.prefix}</span>
                                </Button>
                              ) : null}
                              <Button
                                size="sm"
                                variant="danger"
                                disabled={mutation.pending}
                                onClick={(e) => void revoke(t, eventTrigger(e))}
                              >
                                Revoke<span className="sr-only"> {t.prefix}</span>
                              </Button>
                            </div>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </>
          );
        }}
      </ResourceView>
      {confirmDialog}
    </Section>
  );
}

function IssuedToken({
  issued,
  onHide,
}: {
  readonly issued: IssuedScimToken;
  readonly onHide: () => void;
}) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(issued.token);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }
  return (
    <Notice
      tone="success"
      role="status"
      title="Copy the token now: Kobe shows it only once."
      actions={
        <>
          <Button size="sm" onClick={() => void copy()}>
            {copied ? "Copied" : "Copy token"}
          </Button>
          <Button size="sm" onClick={onHide}>
            Hide
          </Button>
        </>
      }
    >
      <p>
        Paste it as the Secret Token in the identity provider.
        {issued.replaces
          ? " The old token keeps working until you revoke it: revoke it once provisioning uses the new one."
          : ""}
      </p>
      <code className="mt-1 block break-all" data-testid="scim-token">
        {issued.token}
      </code>
    </Notice>
  );
}
