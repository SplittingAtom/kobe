"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import {
  downloadSkillBundle,
  getSkill,
  uploadSkillZip,
  type SkillScope,
  type SkillSummary,
} from "../../../../lib/admin/api/team/skills";
import {
  buildZip,
  composeSkillMd,
  decodeBundle,
  splitSkillMd,
  type KeptFile,
} from "../../../../lib/admin/skills/bundle";
import { SKILL_LIMITS } from "../../../../lib/admin/skills/limits";
import {
  validateSkill,
  type DraftFile,
  type SkillDraft,
  type SkillErrors,
} from "../../../../lib/admin/skills/validate";
import type { ApiResult } from "../../../../lib/api/client";
import {
  Button,
  Field,
  Notice,
  PageHeader,
  Select,
  Textarea,
  TextInput,
} from "../../../ui/console";
import { useTeamAccess } from "../../console-context";
import { ErrorNotice, MutationStatus } from "../../error-notice";
import { useMutation, useResource } from "../../use-resource";
import { fieldError } from "../agent-builder/field-errors";
import { skillPaths, type SkillArea } from "./area";
import { FilesEditor } from "./files-editor";
import { SkillReachPanel } from "./skill-reach";
import { TEAM_SKILL_RULE } from "../../../../lib/admin/skills/reach";

const EMPTY: SkillDraft = { name: "", description: "", other: "", body: "", files: [] };

interface Loaded {
  readonly skill: SkillSummary;
  readonly draft: SkillDraft;
  readonly kept: readonly KeptFile[];
}

/** Create a skill, or edit one and save the result as its next version (KOBE-83). */
export function SkillEditorPage({
  skillId,
  area = "team",
}: {
  readonly skillId?: string;
  /** `my`: the member's own area, personal skills only (KOBE-98). */
  readonly area?: SkillArea;
}) {
  return skillId ? (
    <ExistingSkill skillId={skillId} area={area} />
  ) : (
    <Editor loaded={null} area={area} />
  );
}

function BackLink({ area }: { readonly area: SkillArea }) {
  return <Link href={skillPaths(area).base}>{skillPaths(area).backLabel}</Link>;
}

async function loadSkill(teamId: string, id: string): Promise<ApiResult<Loaded>> {
  const skill = await getSkill(teamId, id);
  if (!skill.ok) return skill;
  const zip = await downloadSkillBundle(teamId, id, skill.data.latestVersion);
  if (!zip.ok) return zip;
  const decoded = decodeBundle(zip.data);
  const parts = decoded.ok ? splitSkillMd(decoded.value.skillMd) : null;
  if (!decoded.ok || !parts?.ok) {
    const message = !decoded.ok ? decoded.error : parts && !parts.ok ? parts.error : "";
    return { ok: false, error: { status: 0, code: "bundle_unreadable", message } };
  }
  const files = decoded.value.text.map((f, i) => ({ key: i + 1, ...f }));
  return {
    ok: true,
    status: 200,
    data: { skill: skill.data, draft: { ...parts.value, files }, kept: decoded.value.kept },
  };
}

function ExistingSkill({ skillId, area }: { readonly skillId: string; readonly area: SkillArea }) {
  const teamId = useTeamAccess().team.id;
  const { state } = useResource(() => loadSkill(teamId, skillId));
  if (state.status !== "ready") {
    return (
      <>
        <p className="m-0 mb-1 text-sm">
          <BackLink area={area} />
        </p>
        {state.status === "loading" ? (
          <p role="status">Loading skill…</p>
        ) : (
          <ErrorNotice error={state.error} />
        )}
      </>
    );
  }
  return <Editor loaded={state.data} area={area} />;
}

function Editor({ loaded, area }: { readonly loaded: Loaded | null; readonly area: SkillArea }) {
  const paths = skillPaths(area);
  const teamId = useTeamAccess().team.id;
  const [skill, setSkill] = useState(loaded?.skill ?? null);
  const kept = loaded?.kept ?? [];
  const [draft, setDraft] = useState<SkillDraft>(loaded?.draft ?? EMPTY);
  const [scope, setScope] = useState<SkillScope>(paths.newScope);
  const [attempted, setAttempted] = useState(false);
  const [sizeError, setSizeError] = useState<string | null>(null);
  const mutation = useMutation();

  const validation = useMemo(() => validateSkill(draft, kept), [draft, kept]);
  const errors: SkillErrors = attempted && !validation.ok ? validation.errors : {};
  const problems = attempted ? validation.problems + (sizeError ? 1 : 0) : 0;
  const set = (patch: Partial<SkillDraft>) => setDraft((d) => ({ ...d, ...patch }));

  async function save() {
    setAttempted(true);
    setSizeError(null);
    if (!validation.ok) return;
    const zip = buildZip(
      composeSkillMd(draft),
      draft.files.map(({ path, text }) => ({ path, text })),
      kept,
    );
    if (zip.length > SKILL_LIMITS.maxBundleBytes) {
      setSizeError(
        `The packed skill is ${(zip.length / 1024 / 1024).toFixed(1)} MiB; the limit is 5 MiB.`,
      );
      return;
    }
    const target = skill?.scope ?? scope;
    await mutation.run(
      async () => {
        const res = await uploadSkillZip(teamId, target, zip);
        if (res.ok && !skill) window.location.assign(`${paths.base}/${res.data.skill.id}`);
        if (res.ok) setSkill(res.data.skill);
        return res;
      },
      (data) => (skill ? `Saved as v${data.version.version}.` : "Skill created."),
    );
    setAttempted(false);
  }

  return (
    <>
      <PageHeader title={skill ? skill.slug : "New skill"} back={<BackLink area={area} />} />
      {problems > 0 && (
        <Notice tone="error">
          <p>
            Fix {problems} {problems === 1 ? "problem" : "problems"} before saving.
          </p>
          {sizeError && <p>{sizeError}</p>}
        </Notice>
      )}
      <MutationStatus error={mutation.error} notice={mutation.notice} />
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="my-4 grid grid-cols-[minmax(0,1fr)] gap-4 md:grid-cols-2">
          {!skill && area === "team" && (
            <Field
              label="Scope"
              hint={`Team skills are shared with the team; personal ones are only yours. ${TEAM_SKILL_RULE}`}
            >
              <Select
                className="w-full"
                value={scope}
                onChange={(e) => setScope(e.target.value as SkillScope)}
              >
                <option value="team">Team skill</option>
                <option value="personal">Personal skill</option>
              </Select>
            </Field>
          )}
          <Field
            label="Name"
            hint={
              skill
                ? "The name identifies the skill and can't change. Create a new skill to rename."
                : "Lowercase letters, digits and hyphens. Permanent."
            }
            error={fieldError(errors.name)}
          >
            <TextInput
              type="text"
              className="w-full read-only:bg-console-panel"
              value={draft.name}
              readOnly={skill !== null}
              onChange={(e) => set({ name: e.target.value })}
            />
          </Field>
          <Field
            label="Description"
            hint="Tells the agent when to use the skill."
            error={fieldError(errors.description)}
            className="md:col-span-2"
          >
            <TextInput
              type="text"
              className="w-full"
              value={draft.description}
              onChange={(e) => set({ description: e.target.value })}
            />
          </Field>
          <Field
            label="Other frontmatter (YAML)"
            hint="Optional extra keys, such as license: MIT."
            error={fieldError(errors.other)}
            className="md:col-span-2"
          >
            <Textarea
              rows={3}
              className="w-full"
              value={draft.other}
              onChange={(e) => set({ other: e.target.value })}
            />
          </Field>
        </div>
        <Field label="Instructions (SKILL.md body)" error={fieldError(errors.body)}>
          <Textarea
            className="min-h-64 w-full resize-y font-mono"
            value={draft.body}
            onChange={(e) => set({ body: e.target.value })}
          />
        </Field>
        <FilesEditor
          files={draft.files}
          kept={kept}
          errors={errors.files}
          onChange={(files: readonly DraftFile[]) => set({ files })}
        />
        {errors.form && (
          <p className="m-0 mt-2 text-sm font-medium text-console-danger">
            {errors.form.join(" ")}
          </p>
        )}
        <div className="my-4 flex flex-wrap items-center gap-2">
          <Button type="submit" variant="primary" disabled={mutation.pending}>
            {skill ? "Save as new version" : "Create skill"}
          </Button>
          {skill && (
            <span className="text-sm text-console-muted">
              Current version: v{skill.latestVersion}.
            </span>
          )}
        </div>
      </form>
      {/* Keyed by the version: a saved version may change the review state the panel shows. */}
      {skill && <SkillReachPanel key={skill.latestVersion} skill={skill} />}
    </>
  );
}
