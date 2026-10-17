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
import { AUTH_LABELS } from "../../../lib/admin/api/site/connectors";
import {
  Badge,
  Button,
  Checkbox,
  ChoiceGroup,
  EmptyState,
  Notice,
  PageHeader,
  Radio,
  useConfirm,
  eventTrigger,
} from "../../ui/console";
import { useTeamAccess } from "../console-context";
import { MutationStatus } from "../error-notice";
import { ResourceView } from "../parts";
import { useMutation, useResource, type Mutation } from "../use-resource";

const HINT = "text-sm text-console-muted";

/**
 * Team console: connectors (spec D27; `/v1/team/connectors`, team.connectors.manage). Off by
 * default. A team admin enables a registered connector and chooses what it exposes: read-only
 * tools, all, or a chosen list. Drifted tools wait for a site admin and cannot be chosen.
 */
export function TeamConnectorsPage() {
  const teamId = useTeamAccess().team.id;
  const { state, reload } = useResource(() => listTeamConnectors(teamId));
  const mutation = useMutation();

  return (
    <>
      <PageHeader
        title="Connectors"
        description="Connectors are off until you enable them. Enabled connectors offer their tools to the team's agents; each member adds their own API key where one is needed."
      />
      <MutationStatus error={mutation.error} notice={mutation.notice} />
      <ResourceView state={state} label="connectors">
        {(connectors) =>
          connectors.length === 0 ? (
            <EmptyState title="No connectors are registered: ask a site admin to register one." />
          ) : (
            <div className="grid gap-4">
              {connectors.map((c) => (
                <ConnectorCard
                  key={c.id}
                  teamId={teamId}
                  connector={c}
                  mutation={mutation}
                  onChanged={reload}
                />
              ))}
            </div>
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
  const [confirm, confirmDialog] = useConfirm();

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const done = await mutation.run(
      () => setTeamConnector(teamId, c.id, exposure, ticked),
      () => (c.enabled ? `Saved exposure for ${c.name}.` : `Enabled ${c.name}.`),
    );
    if (done) onChanged();
  }

  async function disable(trigger: HTMLElement | null) {
    const yes = await confirm(
      {
        title: `Disable ${c.name} for the team?`,
        description: "Its tools stop being offered to agents.",
        confirmLabel: `Disable ${c.name}`,
      },
      trigger,
    );
    if (!yes) return;
    const done = await mutation.run(
      () => disableTeamConnector(teamId, c.id),
      () => `Disabled ${c.name}.`,
    );
    if (done) onChanged();
  }

  const toggleTick = (piName: string) =>
    setTicked((cur) => (cur.includes(piName) ? cur.filter((t) => t !== piName) : [...cur, piName]));

  return (
    <article
      aria-label={c.name}
      className="box-border rounded-lg border border-console-border bg-console-bg p-4"
    >
      <h2 className="m-0 flex items-center gap-2 text-lg font-semibold">
        {c.iconUrl ? (
          <img src={c.iconUrl} alt="" width={20} height={20} referrerPolicy="no-referrer" />
        ) : null}
        {c.name}
      </h2>
      <p className="m-0 mt-1 flex flex-wrap items-center gap-2">
        <Badge tone={c.enabled ? "running" : "neutral"}>
          {c.enabled ? `Enabled (${EXPOSURE_LABELS[c.exposure ?? "read_only"]})` : "Not enabled"}
        </Badge>
        <span className={HINT}>{AUTH_LABELS[c.authKind]}</span>
      </p>
      {c.status === "disabled" ? (
        <Notice tone="warn">
          <p>
            Disabled by a site admin: its tools are not offered
            {c.enabled ? "" : " and the team cannot enable it"}.
          </p>
        </Notice>
      ) : null}
      <form onSubmit={save} aria-label={`Exposure of ${c.name}`} className="mt-3">
        {blocked ? null : (
          <ChoiceGroup legend="What the team's agents may use">
            {(Object.keys(EXPOSURE_LABELS) as Exposure[]).map((x) => (
              <Radio
                key={x}
                name={`exposure-${c.id}`}
                label={EXPOSURE_LABELS[x]}
                checked={exposure === x}
                disabled={mutation.pending}
                onChange={() => setExposure(x)}
              />
            ))}
          </ChoiceGroup>
        )}
        <ToolList
          tools={c.tools}
          choosing={!blocked && exposure === "custom"}
          ticked={ticked}
          onToggle={toggleTick}
          disabled={mutation.pending}
        />
        <div className="mt-3 flex flex-wrap gap-2">
          {blocked ? null : (
            <Button type="submit" variant="primary" disabled={mutation.pending}>
              {c.enabled ? "Save exposure" : "Enable"}
              <span className="sr-only"> {c.name}</span>
            </Button>
          )}
          {c.enabled ? (
            <Button
              variant="danger"
              disabled={mutation.pending}
              onClick={(e) => void disable(eventTrigger(e))}
            >
              Disable<span className="sr-only"> {c.name}</span>
            </Button>
          ) : null}
        </div>
      </form>
      {confirmDialog}
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
  if (tools.length === 0) return <p className={`m-0 my-2 ${HINT}`}>No tools are approved yet.</p>;
  return (
    <>
      <p className={`m-0 my-2 ${HINT}`}>
        A tool that doesn&apos;t declare itself read-only is treated as able to change data, and one
        that doesn&apos;t say otherwise as able to reach outside systems. Read-only exposure offers
        only tools that declare themselves read-only.
      </p>
      <ul aria-label="Tools" className="m-0 my-2 grid list-none gap-1 p-0">
        {tools.map((t) => {
          const drifted = t.status === "drifted";
          return (
            <li
              key={t.piName}
              aria-label={`${t.name} tool`}
              className="flex flex-wrap items-center gap-x-2 gap-y-1"
            >
              {choosing ? (
                <Checkbox
                  label={t.name}
                  checked={!drifted && ticked.includes(t.piName)}
                  disabled={disabled || drifted}
                  onChange={() => onToggle(t.piName)}
                />
              ) : (
                <code>{t.name}</code>
              )}
              {drifted ? (
                <Badge tone="attention">
                  Unavailable: changed upstream, waiting for a site admin
                </Badge>
              ) : (
                <>
                  <span className={HINT}>{t.readOnly ? "Read-only" : "Write"}</span>
                  <span className={HINT}>{t.openWorld ? "Open-world" : "Closed-world"}</span>
                </>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}
