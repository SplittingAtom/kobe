"use client";

import { useState, type FormEvent } from "react";
import {
  createRegistryTeam,
  getRegistrySettings,
  putRegistrySettings,
  type RegistrySettings,
  type RegistrySettingsUpdate,
} from "../../../lib/admin/api/site/skill-registry";
import {
  Button,
  Checkbox,
  ChoiceGroup,
  Field,
  Notice,
  PageHeader,
  Textarea,
  TextInput,
} from "../../ui/console";
import { MutationStatus } from "../error-notice";
import { ResourceView } from "../parts";
import { useMutation, useResource, type Mutation } from "../use-resource";
import { SkillMirrorStatusPanel } from "./skill-mirror-status";

/**
 * Registry settings (KOBE-330, SK20, SK21): the Registry team that runs all site-side work (until
 * it is named the Registry is "not ready" and Approve is disabled), the Site judge, the submission
 * rules, eval limits, the import allowlist, the external scanner and the git mirror. Site admins
 * only; every save is audited.
 */
export const NOT_READY =
  "The Registry is not ready: create the Registry team. Until then nobody can approve a submission.";

export function SkillRegistryPage() {
  const { state, reload } = useResource(getRegistrySettings);
  // Outside the form, which remounts on the saved settings: the notice outlives the reload.
  const mutation = useMutation();
  return (
    <>
      <PageHeader title="Skill Registry" />
      <ResourceView state={state} label="Registry settings">
        {(settings) => (
          <>
            {settings.ready && settings.registryTeam ? (
              <Notice tone="info">
                <p>Ready. Site-side runs use the team {settings.registryTeam.name}.</p>
              </Notice>
            ) : (
              <>
                <Notice tone="warn">
                  <p>{NOT_READY}</p>
                </Notice>
                <CreateRegistryTeam onCreated={reload} />
              </>
            )}
            <RegistryForm
              key={settings.updatedAt}
              settings={settings}
              mutation={mutation}
              onSaved={reload}
            />
            <MutationStatus error={mutation.error} notice={mutation.notice} />
            {settings.mirror.enabled && <SkillMirrorStatusPanel key={settings.updatedAt} />}
          </>
        )}
      </ResourceView>
    </>
  );
}

type Draft = Record<string, string>;

const RULE_FIELDS = [
  ["minCases", "Eval cases, at least"],
  ["minNegativeCases", "Negative trigger cases, at least"],
  ["minPassRate", "Pass rate with the skill, at least (0 to 1)"],
  ["minLift", "Lift over the baseline, at least (−1 to 1)"],
  ["minTriggerPrecision", "Trigger precision, at least (0 to 1)"],
  ["retriesPerFailingCase", "Automatic retries per failing case"],
] as const;
const LIMIT_FIELDS = [
  ["maxConcurrentSandboxes", "Eval sandboxes at once per team"],
  ["maxCases", "Cases per suite, at most"],
  ["caseWallClockMinutes", "Minutes per case, at most"],
] as const;

function draftOf(s: RegistrySettings): Draft {
  const rules = s.submissionRules as unknown as Record<string, number | boolean>;
  const limits = s.evalLimits as unknown as Record<string, number>;
  return {
    judgeAlias: s.judgeAlias ?? "",
    ...Object.fromEntries(RULE_FIELDS.map(([k]) => [k, String(rules[k])])),
    ...Object.fromEntries(LIMIT_FIELDS.map(([k]) => [k, String(limits[k])])),
    refuseBlockVerdict: String(s.submissionRules.refuseBlockVerdict),
    requireLicense: String(s.submissionRules.requireLicense),
    requireFreshScorecard: String(s.submissionRules.requireFreshScorecard),
    importAllowlist: s.importAllowlist.join("\n"),
    external: String(s.scanner.external),
    mirrorEnabled: String(s.mirror.enabled),
    mirrorUrl: s.mirror.url ?? "",
    mirrorBranch: s.mirror.branch ?? "",
  };
}

/** JSON with object keys sorted, to compare settings documents. */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v !== null && typeof v === "object")
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(v ?? null);
}

/** The settings the draft changed, as the server takes them (only what changed is sent). */
export function updateOf(saved: RegistrySettings, d: Draft): RegistrySettingsUpdate {
  const num = (k: string) => Number(d[k]);
  const bool = (k: string) => d[k] === "true";
  const next = {
    judgeAlias: d.judgeAlias?.trim() === "" ? null : (d.judgeAlias?.trim() ?? null),
    submissionRules: {
      ...Object.fromEntries(RULE_FIELDS.map(([k]) => [k, num(k)])),
      refuseBlockVerdict: bool("refuseBlockVerdict"),
      requireLicense: bool("requireLicense"),
      requireFreshScorecard: bool("requireFreshScorecard"),
    },
    evalLimits: Object.fromEntries(LIMIT_FIELDS.map(([k]) => [k, num(k)])),
    importAllowlist: (d.importAllowlist ?? "")
      .split("\n")
      .map((h) => h.trim().toLowerCase())
      .filter((h) => h !== ""),
    scanner: { external: bool("external") },
    mirror: {
      enabled: bool("mirrorEnabled"),
      ...(d.mirrorUrl?.trim() ? { url: d.mirrorUrl.trim() } : {}),
      ...(d.mirrorBranch?.trim() ? { branch: d.mirrorBranch.trim() } : {}),
    },
  };
  const before = {
    judgeAlias: saved.judgeAlias,
    submissionRules: saved.submissionRules,
    evalLimits: saved.evalLimits,
    importAllowlist: saved.importAllowlist,
    scanner: saved.scanner,
    mirror: saved.mirror,
  };
  const same = (a: unknown, b: unknown) => stable(a) === stable(b);
  return Object.fromEntries(
    Object.entries(next).filter(([k, v]) => !same(v, before[k as keyof typeof before])),
  ) as RegistrySettingsUpdate;
}

function RegistryForm({
  settings,
  mutation,
  onSaved,
}: {
  readonly settings: RegistrySettings;
  readonly mutation: Mutation;
  readonly onSaved: () => void;
}) {
  const [draft, setDraft] = useState<Draft>(() => draftOf(settings));
  const set = (k: string) => (e: { target: { value: string } }) =>
    setDraft((d) => ({ ...d, [k]: e.target.value }));
  const toggle = (k: string) => (e: { target: { checked: boolean } }) =>
    setDraft((d) => ({ ...d, [k]: String(e.target.checked) }));
  const update = updateOf(settings, draft);
  const dirty = Object.keys(update).length > 0;

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const done = await mutation.run(
      () => putRegistrySettings(update),
      () => "Registry settings saved.",
    );
    if (done) onSaved();
  }

  return (
    <form onSubmit={onSubmit} aria-label="Registry settings">
      <ChoiceGroup legend="Site judge" stacked className="my-4">
        <Field
          label="Site judge (model alias)"
          hint="Used for eval judging where a team has enabled it."
        >
          <TextInput value={draft.judgeAlias} onChange={set("judgeAlias")} maxLength={64} />
        </Field>
      </ChoiceGroup>
      <ChoiceGroup legend="Submission rules" stacked className="my-4">
        {RULE_FIELDS.map(([k, label]) => (
          <Field key={k} label={label}>
            <TextInput inputMode="decimal" value={draft[k]} onChange={set(k)} />
          </Field>
        ))}
        <Checkbox
          label="Refuse a Block scan verdict"
          checked={draft.refuseBlockVerdict === "true"}
          onChange={toggle("refuseBlockVerdict")}
        />
        <Checkbox
          label="Require a license field"
          checked={draft.requireLicense === "true"}
          onChange={toggle("requireLicense")}
        />
        <Checkbox
          label="Require a scorecard from this exact package"
          checked={draft.requireFreshScorecard === "true"}
          onChange={toggle("requireFreshScorecard")}
        />
      </ChoiceGroup>
      <ChoiceGroup legend="Eval limits" stacked className="my-4">
        {LIMIT_FIELDS.map(([k, label]) => (
          <Field key={k} label={label}>
            <TextInput inputMode="numeric" value={draft[k]} onChange={set(k)} />
          </Field>
        ))}
      </ChoiceGroup>
      <ChoiceGroup legend="Import, scanner and mirror" stacked className="my-4">
        <Field
          label="Import allowlist (one host per line)"
          hint="Skills can be imported only from these hosts."
        >
          <Textarea rows={3} value={draft.importAllowlist} onChange={set("importAllowlist")} />
        </Field>
        <Checkbox
          label="Run the external scanner"
          checked={draft.external === "true"}
          onChange={toggle("external")}
        />
        <Checkbox
          label="Mirror the catalog to git"
          checked={draft.mirrorEnabled === "true"}
          onChange={toggle("mirrorEnabled")}
        />
        <Field label="Mirror URL (https)">
          <TextInput value={draft.mirrorUrl} onChange={set("mirrorUrl")} />
        </Field>
        <Field label="Mirror branch">
          <TextInput value={draft.mirrorBranch} onChange={set("mirrorBranch")} />
        </Field>
      </ChoiceGroup>
      <Button type="submit" variant="primary" disabled={mutation.pending || !dirty}>
        Save
      </Button>
    </form>
  );
}

export const REGISTRY_TEAM_HINT =
  "Kobe creates a dedicated team for the Registry: its budget, policy and egress govern reviewer re-runs and catalog scorecards. You become its team admin and every Skill reviewer joins it. An existing team can't be used.";

/** Creates the dedicated Registry team (KOBE-330 review H1): never an existing team. */
function CreateRegistryTeam({ onCreated }: { readonly onCreated: () => void }) {
  const mutation = useMutation();
  const [name, setName] = useState("Skill Registry");
  const [slug, setSlug] = useState("skill-registry");

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const done = await mutation.run(
      () => createRegistryTeam({ name: name.trim(), slug }),
      () => "The Registry team is ready.",
    );
    if (done) onCreated();
  }

  return (
    <form onSubmit={onSubmit} aria-label="Create the Registry team">
      <ChoiceGroup legend="Registry team" stacked className="my-4">
        <p className="text-sm">{REGISTRY_TEAM_HINT}</p>
        <Field label="Team name">
          <TextInput
            required
            value={name}
            maxLength={100}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field label="Team slug">
          <TextInput
            required
            value={slug}
            pattern="[a-z0-9]([a-z0-9\-]{0,30}[a-z0-9])?"
            onChange={(e) => setSlug(e.target.value)}
          />
        </Field>
      </ChoiceGroup>
      <Button type="submit" variant="primary" disabled={mutation.pending}>
        Create the Registry team
      </Button>
      <MutationStatus error={mutation.error} notice={mutation.notice} />
    </form>
  );
}
