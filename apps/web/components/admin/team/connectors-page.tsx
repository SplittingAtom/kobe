"use client";

import { useState, type FormEvent } from "react";
import {
  EXPOSURE_LABELS,
  disableTeamConnector,
  listTeamConnectors,
  setTeamConnector,
  type Exposure,
  type TeamConnector,
  type TeamConnectorTool,
} from "../../../lib/admin/api/team/connectors";
import { AUTH_LABELS } from "../../../lib/admin/api/install/connectors";
import { useTeamAccess } from "../console-context";
import { MutationStatus } from "../error-notice";
import { ResourceView, confirmed } from "../parts";
import { useMutation, useResource, type Mutation } from "../use-resource";
import styles from "../admin.module.css";

/**
 * Team console: connectors (spec D27; `/v1/team/connectors`, team.connectors.manage). Off by
 * default. A team admin enables a registered connector and chooses what it exposes: read-only
 * tools, all, or a chosen list. Drifted tools wait for an install admin and cannot be chosen.
 */
export function TeamConnectorsPage() {
  const teamId = useTeamAccess().team.id;
  const { state, reload } = useResource(() => listTeamConnectors(teamId));
  const mutation = useMutation();

  return (
    <>
      <h1>Connectors</h1>
      <p className={styles.hint}>
        Connectors are off until you enable them. Enabled connectors offer their tools to the
        team&apos;s agents; each member adds their own API key where one is needed.
      </p>
      <MutationStatus error={mutation.error} notice={mutation.notice} />
      <ResourceView state={state} label="connectors">
        {(connectors) =>
          connectors.length === 0 ? (
            <p>No connectors are registered: ask an install admin to register one.</p>
          ) : (
            connectors.map((c) => (
              <ConnectorCard
                key={c.id}
                teamId={teamId}
                connector={c}
                mutation={mutation}
                onChanged={reload}
              />
            ))
          )
        }
      </ResourceView>
    </>
  );
}

/** Ticks that still name a pinned tool; a tool that drifted since is dropped, not sent. */
function pinnedTicks(c: TeamConnector): string[] {
  const pinned = new Set(c.tools.filter((t) => t.status === "pinned").map((t) => t.piName));
  return c.enabledTools.filter((t) => pinned.has(t));
}

function ConnectorCard({
  teamId,
  connector: c,
  mutation,
  onChanged,
}: {
  readonly teamId: string;
  readonly connector: TeamConnector;
  readonly mutation: Mutation;
  readonly onChanged: () => void;
}) {
  const [exposure, setExposure] = useState<Exposure>(c.exposure ?? "read_only");
  const [ticked, setTicked] = useState<readonly string[]>(pinnedTicks(c));
  const blocked = c.status === "disabled" && !c.enabled;

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const done = await mutation.run(
      () => setTeamConnector(teamId, c.id, exposure, ticked),
      () => (c.enabled ? `Saved exposure for ${c.name}.` : `Enabled ${c.name}.`),
    );
    if (done) onChanged();
  }

  async function disable() {
    if (!confirmed(`Disable ${c.name} for the team? Its tools stop being offered to agents.`)) {
      return;
    }
    const done = await mutation.run(
      () => disableTeamConnector(teamId, c.id),
      () => `Disabled ${c.name}.`,
    );
    if (done) onChanged();
  }

  const toggleTick = (piName: string) =>
    setTicked((cur) => (cur.includes(piName) ? cur.filter((t) => t !== piName) : [...cur, piName]));

  return (
    <article aria-label={c.name} className={styles.form}>
      <h2>
        {c.iconUrl ? (
          <img src={c.iconUrl} alt="" width={20} height={20} referrerPolicy="no-referrer" />
        ) : null}{" "}
        {c.name}
      </h2>
      <p>
        <strong>
          {c.enabled ? `Enabled (${EXPOSURE_LABELS[c.exposure ?? "read_only"]})` : "Not enabled"}
        </strong>{" "}
        <span className={styles.hint}>{AUTH_LABELS[c.authKind]}</span>
      </p>
      {c.status === "disabled" ? (
        <p className={styles.banner}>
          Disabled by an install admin: its tools are not offered
          {c.enabled ? "" : " and the team cannot enable it"}.
        </p>
      ) : null}
      <form onSubmit={save} aria-label={`Exposure of ${c.name}`}>
        {blocked ? null : (
          <fieldset disabled={mutation.pending}>
            <legend>What the team&apos;s agents may use</legend>
            {(Object.keys(EXPOSURE_LABELS) as Exposure[]).map((x) => (
              <label key={x}>
                <input
                  type="radio"
                  name={`exposure-${c.id}`}
                  checked={exposure === x}
                  onChange={() => setExposure(x)}
                />{" "}
                {EXPOSURE_LABELS[x]}
              </label>
            ))}
          </fieldset>
        )}
        <ToolList
          tools={c.tools}
          choosing={!blocked && exposure === "custom"}
          ticked={ticked}
          onToggle={toggleTick}
          disabled={mutation.pending}
        />
        {blocked ? null : (
          <button type="submit" disabled={mutation.pending}>
            {c.enabled ? "Save exposure" : "Enable"}
            <span className={styles.visuallyHidden}> {c.name}</span>
          </button>
        )}{" "}
        {c.enabled ? (
          <button type="button" disabled={mutation.pending} onClick={() => void disable()}>
            Disable<span className={styles.visuallyHidden}> {c.name}</span>
          </button>
        ) : null}
      </form>
    </article>
  );
}

function ToolList({
  tools,
  choosing,
  ticked,
  onToggle,
  disabled,
}: {
  readonly tools: readonly TeamConnectorTool[];
  readonly choosing: boolean;
  readonly ticked: readonly string[];
  readonly onToggle: (piName: string) => void;
  readonly disabled: boolean;
}) {
  if (tools.length === 0) return <p className={styles.hint}>No tools are approved yet.</p>;
  return (
    <>
      <p className={styles.hint}>Unannotated tools count as write and open-world.</p>
      <ul aria-label="Tools">
        {tools.map((t) => {
          const drifted = t.status === "drifted";
          return (
            <li key={t.piName} aria-label={`${t.name} tool`}>
              {choosing ? (
                <label>
                  <input
                    type="checkbox"
                    checked={!drifted && ticked.includes(t.piName)}
                    disabled={disabled || drifted}
                    onChange={() => onToggle(t.piName)}
                  />{" "}
                  {t.name}
                </label>
              ) : (
                <code>{t.name}</code>
              )}{" "}
              {drifted ? (
                <span>Unavailable: changed upstream, waiting for an install admin</span>
              ) : (
                <>
                  <span className={styles.hint}>{t.readOnly ? "Read-only" : "Write"}</span>{" "}
                  <span className={styles.hint}>{t.openWorld ? "Open-world" : "Closed-world"}</span>
                </>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}
