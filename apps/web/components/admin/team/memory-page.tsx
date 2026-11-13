"use client";

import { useState, type FormEvent } from "react";
import { Button, Field, PageHeader, Select } from "../../ui/console";
import { useTeamAccess } from "../console-context";
import {
  getEffectiveMemory,
  getTeamMemory,
  putTeamMemory,
  type EffectiveMemory,
  type WorkspaceMemorySettings,
} from "../../../lib/admin/api/team/memory";
import { listTeamModels, modelName, type TeamModels } from "../../../lib/admin/api/team/models";
import { MutationStatus } from "../error-notice";
import { ResourceView } from "../parts";
import { useMutation, useResource } from "../use-resource";
import { MemorySwitchesForm, memoryNotice, type SwitchSpec } from "./memory-switches-form";

type WorkspaceSwitch = Exclude<keyof WorkspaceMemorySettings, "learningModelAlias">;

/** The Workspace's switches, each AND-ed with the Site's (KOBE-381, SM27). */
export const WORKSPACE_SWITCHES: readonly SwitchSpec<WorkspaceSwitch>[] = [
  {
    key: "memoryEnabled",
    label: "Allow memory in this workspace",
    hint: "The master switch. Off: agents get no notes (remember and recall) and no memories in this workspace; Site Policy still applies (only the site can turn it off). Nothing stored is deleted, and turning it back on brings everything back.",
  },
  {
    key: "projectMemoryEnabled",
    label: "Allow project notes",
    hint: "Notes shared with a project's members; an agent's write to them needs a member's approval.",
    needs: ["memoryEnabled"],
  },
  {
    key: "memoriesEnabled",
    label: "Allow memories",
    hint: "Short statements Kobe knows about a person, this workspace and the site, given to the agent at the start of each run. Off keeps every memory stored.",
    needs: ["memoryEnabled"],
  },
  {
    key: "workspaceMemoriesEnabled",
    label: "Workspace memories",
    hint: "Memories everyone in this workspace shares, curated by team admins and memory stewards.",
    needs: ["memoryEnabled", "memoriesEnabled"],
  },
  {
    key: "siteMemoriesEnabled",
    label: "Site memories reach this workspace's runs",
    hint: "Knowledge the site's admins and stewards keep for every workspace. Site Policy reaches this workspace's runs even when this is off.",
    needs: ["memoryEnabled", "memoriesEnabled"],
  },
  {
    key: "learnEnabled",
    label: "Learn from this chat",
    hint: "People can ask Kobe to suggest memories from a conversation and review every suggestion before anything is saved. Needs a learning model (below).",
    needs: ["memoryEnabled", "memoriesEnabled"],
  },
  {
    key: "siteProposalsEnabled",
    label: "Members may propose to the Site",
    hint: "Workspace memories can be proposed to the site. Only the statement and its reason leave this workspace, and only after a team admin confirms.",
    needs: ["memoryEnabled", "memoriesEnabled", "workspaceMemoriesEnabled"],
  },
];

/**
 * Workspace settings › Memory (`/v1/memory/settings?level=team`, KOBE-155, KOBE-381): the
 * Workspace's memory switches and learning model. What applies is the AND with the Site's
 * switches; turning a switch off stops use and deletes nothing.
 */
export function TeamMemoryPage() {
  const teamId = useTeamAccess().team.id;
  const { state, reload } = useResource(() => getTeamMemory(teamId));
  const effective = useResource(() => getEffectiveMemory(teamId));
  const models = useResource(() => listTeamModels(teamId));
  const saved = () => {
    reload();
    effective.reload();
  };
  return (
    <>
      <PageHeader title="Memory" />
      <ResourceView state={state} label="memory settings">
        {(settings) => (
          <>
            <MemorySwitchesForm
              specs={WORKSPACE_SWITCHES}
              switches={settings}
              save={(change) => putTeamMemory(teamId, change)}
              onSaved={saved}
              notice={(s) => memoryNotice("in this workspace", s, "workspace")}
            />
            <ResourceView state={models.state} label="models">
              {(list) => (
                <LearningModelForm
                  teamId={teamId}
                  alias={settings.learningModelAlias}
                  models={list}
                  onSaved={saved}
                />
              )}
            </ResourceView>
            <ResourceView state={effective.state} label="what applies now">
              {(e) => <LearnStatus effective={e} />}
            </ResourceView>
          </>
        )}
      </ResourceView>
    </>
  );
}

function LearningModelForm({
  teamId,
  alias,
  models,
  onSaved,
}: {
  readonly teamId: string;
  readonly alias: string | null;
  readonly models: TeamModels;
  readonly onSaved: () => void;
}) {
  const mutation = useMutation();
  const [value, setValue] = useState(alias ?? "");
  const enabled = models.models.filter((m) => m.enabled);
  // A stored choice no longer enabled (or removed) stays visible so it can be cleared (review M2).
  const stale = alias !== null && !enabled.some((m) => m.alias === alias) ? alias : null;

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const done = await mutation.run(
      () => putTeamMemory(teamId, { learningModelAlias: value === "" ? null : value }),
      (s) =>
        s.learningModelAlias === null
          ? "This workspace uses the site's learning model."
          : `This workspace's learning model is ${s.learningModelAlias}.`,
    );
    if (done) onSaved();
  }

  return (
    <form onSubmit={onSubmit} aria-label="Learning model">
      <Field
        label="Learning model for this workspace"
        hint="When set, Learn from this chat uses this model instead of the site's learning model; None uses the site's. If the chosen model is not enabled here, Learn is unavailable and says why: it never falls back to another model or the conversation's model. Only models enabled in Workspace settings › Models are offered."
        className="my-4"
      >
        <Select value={value} onChange={(e) => setValue(e.target.value)}>
          <option value="">None</option>
          {stale !== null && <option value={stale}>{`${stale} (not enabled)`}</option>}
          {enabled.map((m) => (
            <option key={m.alias} value={m.alias}>
              {modelName(m)}
            </option>
          ))}
        </Select>
      </Field>
      <Button
        type="submit"
        variant="primary"
        disabled={mutation.pending || value === (alias ?? "")}
      >
        Save learning model
      </Button>
      <MutationStatus error={mutation.error} notice={mutation.notice} />
    </form>
  );
}

function LearnStatus({ effective }: { readonly effective: EffectiveMemory }) {
  const learn = effective.learn;
  return (
    <p role="status" className="my-4 text-sm">
      {learn.available
        ? `Learn from this chat uses ${learn.alias} (${learn.source === "site" ? "the site's learning model" : "this workspace's learning model"}).`
        : `Learn from this chat is unavailable: ${learn.message}`}
    </p>
  );
}
