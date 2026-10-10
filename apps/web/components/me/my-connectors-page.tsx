"use client";

import { useState, type FormEvent } from "react";
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
import { DateTime, ResourceView, confirmed } from "../admin/parts";
import { useMutation, useResource, type Mutation } from "../admin/use-resource";
import styles from "../admin/admin.module.css";

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
      <h1>My connector keys</h1>
      <p className={styles.hint}>
        Some connectors need your own API key. It is stored encrypted, used only for your runs, and
        never shown again after you save it.
      </p>
      <MutationStatus error={mutation.error} notice={mutation.notice} />
      <ResourceView state={state} label="connectors">
        {(data: Loaded) => {
          const needKey = data.connectors.filter(
            (c) => c.enabled && c.status === "active" && c.authKind === "api_key",
          );
          if (needKey.length === 0) {
            return <p>No connector in this team needs your own key.</p>;
          }
          return needKey.map((c) => (
            <KeyCard
              key={c.id}
              teamId={teamId}
              connector={c}
              grant={data.grants.find((g) => g.connectorId === c.id) ?? null}
              mutation={mutation}
              onChanged={reload}
            />
          ));
        }}
      </ResourceView>
    </>
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

  async function remove() {
    if (!confirmed(`Remove your key for ${c.name}? Your runs can't use it until you add one.`)) {
      return;
    }
    const done = await mutation.run(
      () => removeGrant(teamId, c.id),
      () => "Key removed.",
    );
    if (done) onChanged();
  }

  return (
    <article aria-label={c.name} className={styles.form}>
      <h2>{c.name}</h2>
      <p>
        {grant ? (
          <>
            Key ending {grant.hint} (updated <DateTime value={grant.updatedAt} />)
          </>
        ) : (
          "No key added"
        )}
      </p>
      <form onSubmit={save} aria-label={`Key for ${c.name}`}>
        <label>
          API key
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            maxLength={2048}
            value={key}
            onChange={(e) => setKey(e.target.value)}
          />
        </label>
        {problem ? <p role="alert">{problem}</p> : null}
        <button type="submit" disabled={mutation.pending}>
          {grant ? "Replace key" : "Add key"}
        </button>{" "}
        {grant ? (
          <button type="button" disabled={mutation.pending} onClick={() => void remove()}>
            Remove key
          </button>
        ) : null}
      </form>
    </article>
  );
}
