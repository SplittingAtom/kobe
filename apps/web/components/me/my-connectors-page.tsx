"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  KEY_HINT,
  KEY_PATTERN,
  listGrants,
  removeGrant,
  saveGrant,
  type ConnectorGrant,
} from "../../lib/admin/api/team/connector-grants";
import { listTeamConnectors, type TeamConnector } from "../../lib/admin/api/team/connectors";
import { useTeamAccess } from "../admin/console-context";
import { MutationStatus } from "../admin/error-notice";
import { DateTime, ResourceView } from "../admin/parts";
import { useMutation, useResource, type Mutation } from "../admin/use-resource";
import {
  Button,
  Card,
  EmptyState,
  Field,
  FormRow,
  PageHeader,
  TextInput,
  eventTrigger,
  useConfirm,
} from "../ui/console";

interface Loaded {
  readonly connectors: readonly TeamConnector[];
  readonly grants: readonly ConnectorGrant[];
}

/**
 * A member's own API keys for the team's enabled connectors (spec D27: no shared team
 * credentials; `/v1/connector-grants`, KOBE-108). The key is sent once and never shown again:
 * only a masked hint comes back.
 */
export function MyConnectorsPage() {
  const teamId = useTeamAccess().team.id;
  const { state, reload } = useResource(async () => {
    const [connectors, grants] = await Promise.all([
      listTeamConnectors(teamId),
      listGrants(teamId),
    ]);
    if (!connectors.ok) return connectors;
    if (!grants.ok) return grants;
    return { ...connectors, data: { connectors: connectors.data, grants: grants.data } };
  });
  const mutation = useMutation();

  return (
    <>
      <PageHeader
        title="My connector keys"
        description="Some connectors need your own API key. It is stored encrypted, used only for your runs, and never shown again after you save it."
      />
      <MutationStatus error={mutation.error} notice={mutation.notice} />
      <ResourceView state={state} label="connectors">
        {(data: Loaded) => {
          const needKey = data.connectors.filter(
            (c) => c.enabled && c.status === "active" && c.authKind === "api_key",
          );
          if (needKey.length === 0) {
            return <EmptyState title="No connector in this team needs your own key." />;
          }
          return (
            <div className="flex flex-col gap-3">
              {needKey.map((c) =>
                c.credentialSource === "site" ? (
                  <ProvidedCard key={c.id} connector={c} />
                ) : (
                  <KeyCard
                    key={c.id}
                    teamId={teamId}
                    connector={c}
                    grant={data.grants.find((g) => g.connectorId === c.id) ?? null}
                    mutation={mutation}
                    onChanged={reload}
                  />
                ),
              )}
            </div>
          );
        }}
      </ResourceView>
    </>
  );
}

/** A connector whose key the site admins set for everyone (KOBE-303): nothing to do here. */
function ProvidedCard({ connector: c }: { readonly connector: TeamConnector }) {
  return (
    <Card role="article" aria-label={c.name} title={c.name} level={2}>
      <p className="m-0 text-sm text-console-muted">
        {c.siteKeyReady
          ? "Provided by your organization: you need no key of your own."
          : "Your organization provides the key but has not set it yet: ask a site admin. You need no key of your own."}
      </p>
    </Card>
  );
}

function KeyCard({
  teamId,
  connector: c,
  grant,
  mutation,
  onChanged,
}: {
  readonly teamId: string;
  readonly connector: TeamConnector;
  readonly grant: ConnectorGrant | null;
  readonly mutation: Mutation;
  readonly onChanged: () => void;
}) {
  const [key, setKey] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [confirm, confirmDialog] = useConfirm();
  const input = useRef<HTMLInputElement>(null);
  // The Remove button goes with the key: once the list shows it gone, focus moves to the field.
  const removed = useRef(false);
  useEffect(() => {
    if (removed.current && grant === null) {
      removed.current = false;
      input.current?.focus();
    }
  }, [grant]);

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!KEY_PATTERN.test(key)) {
      setProblem(KEY_HINT);
      return;
    }
    setProblem(null);
    const done = await mutation.run(
      () => saveGrant(teamId, c.id, key),
      () => (grant ? "Key replaced." : "Key added."),
    );
    // The field is emptied whatever the outcome: the key is never kept on the page.
    setKey("");
    if (done) onChanged();
  }

  async function remove(trigger: HTMLElement | null) {
    const yes = await confirm(
      {
        title: `Remove your key for ${c.name}?`,
        description: "Your runs can't use it until you add one.",
        confirmLabel: "Remove key",
      },
      trigger,
    );
    if (!yes) return;
    const done = await mutation.run(
      () => removeGrant(teamId, c.id),
      () => "Key removed.",
    );
    if (done) {
      removed.current = true;
      onChanged();
    }
  }

  return (
    <Card role="article" aria-label={c.name} title={c.name} level={2}>
      <p className="m-0 text-sm text-console-muted">
        {grant ? (
          <>
            Key ending {grant.hint} (updated <DateTime value={grant.updatedAt} />)
          </>
        ) : (
          "No key added"
        )}
      </p>
      <form onSubmit={save} aria-label={`Key for ${c.name}`}>
        <FormRow className="mb-0">
          <Field label="API key" error={problem}>
            <TextInput
              ref={input}
              type="password"
              autoComplete="off"
              spellCheck={false}
              maxLength={2048}
              value={key}
              onChange={(e) => setKey(e.target.value)}
            />
          </Field>
          <Button type="submit" variant="primary" disabled={mutation.pending}>
            {grant ? "Replace key" : "Add key"}
          </Button>
          {grant ? (
            <Button
              variant="danger"
              disabled={mutation.pending}
              onClick={(e) => void remove(eventTrigger(e))}
            >
              Remove key
            </Button>
          ) : null}
        </FormRow>
      </form>
      {confirmDialog}
    </Card>
  );
}
