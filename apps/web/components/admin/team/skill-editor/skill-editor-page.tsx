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
import { useTeamAccess } from "../../console-context";
import { ErrorNotice, MutationStatus } from "../../error-notice";
import { useMutation, useResource } from "../../use-resource";
import adminStyles from "../../admin.module.css";
import agentStyles from "../agent-builder/agent-builder.module.css";
import { Field } from "../agent-builder/field";
import { skillPaths, type SkillArea } from "./area";
import { FilesEditor } from "./files-editor";
import styles from "./skill-editor.module.css";

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
  return (
    <>
      <p>
        <Link href={skillPaths(area).base}>{skillPaths(area).backLabel}</Link>
      </p>
      {skillId ? (
        <ExistingSkill skillId={skillId} area={area} />
      ) : (
        <Editor loaded={null} area={area} />
      )}
    </>
  );
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
  if (state.status === "loading") return <p role="status">Loading skill…</p>;
  if (state.status === "error") return <ErrorNotice error={state.error} />;
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
      <h1>{skill ? skill.slug : "New skill"}</h1>
      {problems > 0 && (
        <div role="alert" className={adminStyles.error}>
          <p>
            Fix {problems} {problems === 1 ? "problem" : "problems"} before saving.
          </p>
          {sizeError && <p>{sizeError}</p>}
        </div>
      )}
      <MutationStatus error={mutation.error} notice={mutation.notice} />
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className={agentStyles.fields}>
          {!skill && area === "team" && (
            <Field
              label="Scope"
              hint="Team skills are shared with the team; personal ones are only yours."
            >
              {(control) => (
                <select
                  {...control}
                  value={scope}
                  onChange={(e) => setScope(e.target.value as SkillScope)}
                >
                  <option value="team">Team skill</option>
                  <option value="personal">Personal skill</option>
                </select>
              )}
            </Field>
          )}
          <Field
            label="Name"
            hint={
              skill
                ? "The name identifies the skill and can't change. Create a new skill to rename."
                : "Lowercase letters, digits and hyphens. Permanent."
            }
            errors={errors.name}
          >
            {(control) => (
              <input
                {...control}
                type="text"
                value={draft.name}
                readOnly={skill !== null}
                onChange={(e) => set({ name: e.target.value })}
              />
            )}
          </Field>
          <Field
            label="Description"
            hint="Tells the agent when to use the skill."
            errors={errors.description}
            wide
          >
            {(control) => (
              <input
                {...control}
                type="text"
                value={draft.description}
                onChange={(e) => set({ description: e.target.value })}
              />
            )}
          </Field>
          <Field
            label="Other frontmatter (YAML)"
            hint="Optional extra keys, such as license: MIT."
            errors={errors.other}
            wide
          >
            {(control) => (
              <textarea
                {...control}
                rows={3}
                value={draft.other}
                onChange={(e) => set({ other: e.target.value })}
              />
            )}
          </Field>
        </div>
        <Field label="Instructions (SKILL.md body)" errors={errors.body}>
          {(control) => (
            <textarea
              {...control}
              className={styles.body}
              value={draft.body}
              onChange={(e) => set({ body: e.target.value })}
            />
          )}
        </Field>
        <FilesEditor
          files={draft.files}
          kept={kept}
          errors={errors.files}
          onChange={(files: readonly DraftFile[]) => set({ files })}
        />
        {errors.form && <p className={agentStyles.fieldError}>{errors.form.join(" ")}</p>}
        <div className={agentStyles.toolbar}>
          <button type="submit" disabled={mutation.pending}>
            {skill ? "Save as new version" : "Create skill"}
          </button>
          {skill && (
            <span className={adminStyles.hint}>Current version: v{skill.latestVersion}.</span>
          )}
        </div>
      </form>
    </>
  );
}
