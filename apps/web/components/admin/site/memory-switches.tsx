"use client";

import { useState, type FormEvent } from "react";
import {
  getSiteMemory,
  putSiteMemory,
  type SiteMemorySettings,
  type SiteMemorySettingsDoc,
} from "../../../lib/admin/api/site/memory";
import { Button, ChoiceGroup, Field, TextInput } from "../../ui/console";
import { MutationStatus } from "../error-notice";
import { ResourceView } from "../parts";
import { useMutation, useResource } from "../use-resource";
import { MemorySwitchesForm, memoryNotice, type SwitchSpec } from "../team/memory-switches-form";

type SiteSwitch = Exclude<keyof SiteMemorySettings, "settings">;

/** The Site's switches; each workspace's own switch must be on too (KOBE-381, SM27). */
export const SITE_SWITCHES: readonly SwitchSpec<SiteSwitch>[] = [
  {
    key: "memoryEnabled",
    label: "Allow memory on this site",
    hint: "The master switch. Off: no workspace's agents get notes (remember and recall), memories or Site Policy; it is the only switch that stops Policy. Nothing stored is deleted.",
  },
  {
    key: "projectMemoryEnabled",
    label: "Allow project notes on this site",
    hint: "Notes shared with a project's members; an agent's write to them needs a member's approval.",
    needs: ["memoryEnabled"],
  },
  {
    key: "memoriesEnabled",
    label: "Allow memories on this site",
    hint: "Short statements Kobe knows about a person, a workspace and the site, given to the agent at the start of each run. Off keeps every memory stored.",
    needs: ["memoryEnabled"],
  },
  {
    key: "portableEnabled",
    label: "Portable preferences",
    hint: "A person's preferences (how they like answers, units, tone) follow them into every workspace they belong to. Facts about work never leave their workspace.",
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
    hint: "Workspaces can propose memories to the site. A team admin confirms first; a site admin or site memory steward accepts. Only the statement and its reason are sent.",
    needs: ["memoryEnabled", "memoriesEnabled"],
  },
];

/**
 * Site console › Settings › Memory (`/v1/memory/settings?level=site`, KOBE-155, KOBE-381): the
 * Site memory switches and the Site memory settings. A workspace's memory is on only while both
 * this and the workspace's own switch are on.
 */
export function MemorySwitchesSection() {
  const { state, reload } = useResource(getSiteMemory);
  return (
    <ResourceView state={state} label="memory settings">
      {(site) => (
        <>
          <MemorySwitchesForm
            specs={SITE_SWITCHES}
            switches={site}
            save={putSiteMemory}
            onSaved={reload}
            notice={(s) => memoryNotice("on this site", s)}
            saveLabel="Save memory settings"
          />
          <SiteMemorySettingsForm settings={site.settings} onSaved={reload} />
        </>
      )}
    </ResourceView>
  );
}

type NumberKey =
  | "contextBudgetKib"
  | "versionCap"
  | "staleAfterDays"
  | "retentionDays"
  | "limitUser"
  | "limitPortable"
  | "limitTeam"
  | "limitSite"
  | "learnPassesPerHour"
  | "savesPerMinute";
type Draft = Record<NumberKey | "learningModelAlias" | "embeddingModelAlias", string>;

const draftOf = (s: SiteMemorySettingsDoc): Draft => ({
  learningModelAlias: s.learningModelAlias ?? "",
  embeddingModelAlias: s.embeddingModelAlias ?? "",
  contextBudgetKib: String(s.contextBudgetKib),
  versionCap: String(s.versionCap),
  staleAfterDays: String(s.staleAfterDays),
  retentionDays: String(s.retentionDays),
  limitUser: String(s.scopeLimits.user),
  limitPortable: String(s.scopeLimits.portable),
  limitTeam: String(s.scopeLimits.team),
  limitSite: String(s.scopeLimits.site),
  learnPassesPerHour: String(s.rateLimits.learnPassesPerHour),
  savesPerMinute: String(s.rateLimits.savesPerMinute),
});

/** The draft as a settings document (checked with `invalidNumber` first). */
const docOf = (d: Draft): SiteMemorySettingsDoc => {
  const num = (k: NumberKey) => (d[k].trim() === "" ? Number.NaN : Number(d[k]));
  const alias = (v: string) => (v.trim() === "" ? null : v.trim());
  return {
    learningModelAlias: alias(d.learningModelAlias),
    embeddingModelAlias: alias(d.embeddingModelAlias),
    contextBudgetKib: num("contextBudgetKib"),
    versionCap: num("versionCap"),
    staleAfterDays: num("staleAfterDays"),
    retentionDays: num("retentionDays"),
    scopeLimits: {
      user: num("limitUser"),
      portable: num("limitPortable"),
      team: num("limitTeam"),
      site: num("limitSite"),
    },
    rateLimits: {
      learnPassesPerHour: num("learnPassesPerHour"),
      savesPerMinute: num("savesPerMinute"),
    },
  };
};

/** Each number's label (as people read it) and allowed range; the server checks them too. */
const RANGES: Readonly<Record<NumberKey, readonly [string, number, number]>> = {
  contextBudgetKib: ["The context budget", 4, 16],
  versionCap: ["Versions kept per memory", 5, 500],
  staleAfterDays: ["Stale after", 7, 3650],
  retentionDays: ["The retention window", 30, 3650],
  limitUser: ["Each scope limit", 1, 1000],
  limitPortable: ["Each scope limit", 1, 1000],
  limitTeam: ["Each scope limit", 1, 1000],
  limitSite: ["Each scope limit", 1, 1000],
  learnPassesPerHour: ["Learning passes per hour", 1, 100],
  savesPerMinute: ["Memory saves per minute", 1, 600],
};

/** The first number outside its range, as a sentence; null when all are fine. */
export function invalidNumber(d: Draft): string | null {
  for (const [k, [label, min, max]] of Object.entries(RANGES) as [
    NumberKey,
    readonly [string, number, number],
  ][]) {
    const v = Number(d[k]);
    if (d[k].trim() === "" || !Number.isInteger(v) || v < min || v > max)
      return `${label} must be a whole number from ${min} to ${max}.`;
  }
  return null;
}

const NUMBER_FIELDS: readonly (readonly [NumberKey, string, string])[] = [
  [
    "contextBudgetKib",
    "Context budget (KiB, 4 to 16)",
    "How much room the memories given to the agent at the start of a run may take. Policy always fits within its own 2 KiB.",
  ],
  [
    "versionCap",
    "Versions kept per memory",
    "Older versions beyond this are dropped when a memory is edited again; the current one always stays.",
  ],
  [
    "staleAfterDays",
    "Stale after (days)",
    "A memory nobody has confirmed or used for this long is marked for review. Nothing is archived or deleted automatically.",
  ],
  [
    "retentionDays",
    "Site retention window (days)",
    "How long archived memories and their history are kept before retention may remove them. Legal holds always win.",
  ],
];

const LIMIT_FIELDS: readonly (readonly [NumberKey, string])[] = [
  ["limitUser", "Memories per person in a workspace"],
  ["limitPortable", "Portable preferences per person"],
  ["limitTeam", "Workspace memories per workspace"],
  ["limitSite", "Site memories"],
];

function SiteMemorySettingsForm({
  settings,
  onSaved,
}: {
  readonly settings: SiteMemorySettingsDoc;
  readonly onSaved: () => void;
}) {
  const mutation = useMutation();
  const [draft, setDraft] = useState<Draft>(() => draftOf(settings));
  const set = (k: keyof Draft) => (e: { target: { value: string } }) =>
    setDraft((d) => ({ ...d, [k]: e.target.value }));
  const dirty = JSON.stringify(draft) !== JSON.stringify(draftOf(settings));

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const invalid = invalidNumber(draft);
    const done = await mutation.run(
      () =>
        invalid === null
          ? putSiteMemory({ settings: docOf(draft) })
          : Promise.resolve({
              ok: false as const,
              error: { status: 400, code: "invalid_request", message: invalid },
            }),
      () => "Site memory settings saved.",
    );
    if (done) onSaved();
  }

  return (
    <form onSubmit={onSubmit} aria-label="Site memory settings">
      <ChoiceGroup legend="Models" stacked className="my-4">
        <Field
          label="Learning model (model alias)"
          hint="Learn from this chat uses it in every workspace that has no learning model of its own; the workspace must have it enabled. Learning never falls back to another model or the conversation's model: with no usable learning model, Learn is unavailable and says why."
        >
          <TextInput
            value={draft.learningModelAlias}
            onChange={set("learningModelAlias")}
            maxLength={64}
          />
        </Field>
        <Field
          label="Embedding model (model alias)"
          hint="Not used yet: only if search by meaning is added later. Search uses English word matching."
        >
          <TextInput
            value={draft.embeddingModelAlias}
            onChange={set("embeddingModelAlias")}
            maxLength={64}
          />
        </Field>
      </ChoiceGroup>
      <ChoiceGroup legend="Limits" stacked className="my-4">
        {NUMBER_FIELDS.map(([k, label, hint]) => (
          <Field key={k} label={label} hint={hint}>
            <TextInput inputMode="numeric" value={draft[k]} onChange={set(k)} />
          </Field>
        ))}
      </ChoiceGroup>
      <ChoiceGroup
        legend="Scope limits"
        hint="The most active memories each place may hold (up to 1000). Saving refuses beyond it; nothing is evicted."
        stacked
        className="my-4"
      >
        {LIMIT_FIELDS.map(([k, label]) => (
          <Field key={k} label={label}>
            <TextInput inputMode="numeric" value={draft[k]} onChange={set(k)} />
          </Field>
        ))}
      </ChoiceGroup>
      <ChoiceGroup legend="Rate limits" stacked className="my-4">
        <Field label="Learning passes per person per hour">
          <TextInput
            inputMode="numeric"
            value={draft.learnPassesPerHour}
            onChange={set("learnPassesPerHour")}
          />
        </Field>
        <Field label="Memory saves per person per minute">
          <TextInput
            inputMode="numeric"
            value={draft.savesPerMinute}
            onChange={set("savesPerMinute")}
          />
        </Field>
      </ChoiceGroup>
      <Button type="submit" variant="primary" disabled={mutation.pending || !dirty}>
        Save site memory settings
      </Button>
      <MutationStatus error={mutation.error} notice={mutation.notice} />
    </form>
  );
}
