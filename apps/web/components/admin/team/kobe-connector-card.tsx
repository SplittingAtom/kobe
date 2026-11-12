"use client";

import { useState, type FormEvent } from "react";
import {
  KOBE_LEVEL_LABELS,
  getTeamKobe,
  setTeamKobeLevel,
  type KobeLevel,
  type KobeTeamConnector,
} from "../../../lib/admin/api/team/connectors";
import { Badge, Button, ChoiceGroup, Notice, Radio } from "../../ui/console";
import { useTeamAccess } from "../console-context";
import { MutationStatus } from "../error-notice";
import { ResourceView } from "../parts";
import { useMutation, useResource, type Mutation } from "../use-resource";

const HINT = "text-sm text-console-muted";

const LEVEL_HINTS: Readonly<Record<KobeLevel, string>> = {
  docs: "Agents can read the Kobe user guide. No admin tools.",
  read: "Agents can also read this team's settings as the person in the conversation, within that person's own permissions.",
  read_write:
    "Agents can also change this team's settings as the person. Every change shows an Admin change card and runs only after that person approves it.",
};

/**
 * The built-in Kobe connector in Team console › Connectors (KOBE-623, spec kobe-admin-mcp §6, KA5):
 * its docs tools are on for every agent; the team's level adds Kobe's admin tools (`read`, or
 * `read and write`), gated by `team.connectors.manage` and only while the site switch allows
 * admin tools. The server decides and audits the change.
 */
export function KobeConnectorCard() {
  const access = useTeamAccess();
  const { state, reload } = useResource(() => getTeamKobe(access.team.id));
  // Kept here: the card below is re-created when the saved level comes back, the notice stays.
  const mutation = useMutation();
  // A server without the built-in connector (before KOBE-623) answers 404: nothing to show.
  if (state.status === "error" && state.error.status === 404) return null;
  return (
    <ResourceView state={state} label="Kobe connector">
      {(kobe) =>
        kobe.mode === "off" || kobe.name === null ? null : (
          <KobeCard
            key={kobe.level}
            kobe={kobe}
            canManage={access.permissions.includes("team.connectors.manage")}
            mutation={mutation}
            onSaved={reload}
          />
        )
      }
    </ResourceView>
  );
}

function KobeCard({
  kobe,
  canManage,
  mutation,
  onSaved,
}: {
  readonly kobe: KobeTeamConnector;
  readonly canManage: boolean;
  readonly mutation: Mutation;
  readonly onSaved: () => void;
}) {
  const teamId = useTeamAccess().team.id;
  const [level, setLevel] = useState<KobeLevel>(kobe.level);
  const siteAllows = kobe.mode === "admin";

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const done = await mutation.run(
      () => setTeamKobeLevel(teamId, level, kobe.level),
      (saved) => `Kobe connector: ${KOBE_LEVEL_LABELS[saved.level]}.`,
    );
    if (done) onSaved();
  }

  return (
    <article
      aria-label="Kobe"
      data-kobe-builtin-connector=""
      className="box-border rounded-lg border border-console-border bg-console-bg p-4"
    >
      <h2 className="m-0 text-lg font-semibold">Kobe</h2>
      <p className="m-0 mt-1 flex flex-wrap items-center gap-2">
        <Badge tone="running">Built in</Badge>
        <span className={HINT}>
          {KOBE_LEVEL_LABELS[kobe.level]}. The docs tools are on for every agent; admin tools act as
          the person in the conversation, never with more than their permissions.
        </span>
      </p>
      {!siteAllows && (
        <Notice tone="warn">
          <p>
            A site admin has limited Kobe to its docs tools, so admin tools stay off whatever the
            team chooses.
          </p>
        </Notice>
      )}
      <form onSubmit={save} aria-label="Kobe connector level" className="mt-3">
        <ChoiceGroup legend="Admin tools for the team's agents" stacked>
          {(Object.keys(KOBE_LEVEL_LABELS) as KobeLevel[]).map((x) => (
            <Radio
              key={x}
              name="kobe-level"
              label={KOBE_LEVEL_LABELS[x]}
              hint={LEVEL_HINTS[x]}
              checked={level === x}
              disabled={!canManage || mutation.pending}
              onChange={() => setLevel(x)}
            />
          ))}
        </ChoiceGroup>
        {canManage && (
          <Button
            type="submit"
            variant="primary"
            className="mt-3"
            disabled={mutation.pending || level === kobe.level}
          >
            Save level<span className="sr-only"> for Kobe</span>
          </Button>
        )}
        <MutationStatus error={mutation.error} notice={mutation.notice} />
      </form>
    </article>
  );
}
