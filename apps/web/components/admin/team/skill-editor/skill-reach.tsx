"use client";

import { useState } from "react";
import {
  getSkillReach,
  getSkillUsage,
  setSkillAccess,
  type SkillAccess,
  type SkillReach,
  type SkillReachAgent,
  type SkillSummary,
  type SkillUsage,
} from "../../../../lib/admin/api/team/skills";
import { addSkillHref, TEAM_SKILL_RULE } from "../../../../lib/admin/skills/reach";
import { Button, Field, FormRow, Section, Select } from "../../../ui/console";
import { useTeamAccess } from "../../console-context";
import { MutationStatus } from "../../error-notice";
import { DateTime } from "../../parts";
import { useMutation, useResource } from "../../use-resource";
import { useNavigate } from "../../../shell/use-navigate";

const HINT = "m-0 my-1 text-sm text-console-muted";

const ACCESS_ORDER: readonly SkillAccess[] = ["available", "default_on", "required", "hidden"];
const ACCESS_LABEL: Readonly<Record<SkillAccess, string>> = {
  available: "Available",
  default_on: "On by default",
  required: "Required",
  hidden: "Hidden",
};
const ACCESS_HINT: Readonly<Record<SkillAccess, string>> = {
  available: "Members turn it on for themselves.",
  default_on: "Loads for agents that aren't exclusive; members may turn it off.",
  required: "Loads in every run in the team, exclusive agents too (team admins only).",
  hidden: "Only for agents that name it.",
};

/**
 * Where a skill is used (KOBE-297), under its editor: for a team skill, the agents whose runs get
 * it (named, or by its access mode: On by default or Required, KOBE-316) and "Add to agent…"; for any
 * skill the caller may see usage of, how often runs used it. Both are extras: a failed read
 * leaves a quiet line, never an alert over the editor.
 */
export function SkillReachPanel({ skill }: { readonly skill: SkillSummary }) {
  return (
    <>
      {skill.scope === "team" && <TeamReach skill={skill} />}
      <Usage skill={skill} />
    </>
  );
}

const ORIGIN: Readonly<Record<SkillReachAgent["scope"], string>> = {
  team: "Team",
  personal: "Personal",
  gallery: "Built-in",
};

function TeamReach({ skill }: { readonly skill: SkillSummary }) {
  const access = useTeamAccess();
  const teamId = access.team.id;
  const { state, reload } = useResource(() => getSkillReach(teamId, skill.id));
  const mutation = useMutation();
  const isAdmin = access.permissions.includes("team.skills.review");
  const canSet = isAdmin || access.permissions.includes("team.skills.publish");

  return (
    <Section id="skill-reach-heading" title="Agents using this skill" description={TEAM_SKILL_RULE}>
      {state.status === "loading" && <p role="status">Loading agents…</p>}
      {state.status === "error" && (
        <p className={HINT}>The agents using this skill could not be read.</p>
      )}
      {state.status === "ready" && (
        <>
          <Field label="Access" hint={ACCESS_HINT[state.data.access]}>
            <Select
              value={state.data.access}
              disabled={
                !canSet || (state.data.access === "required" && !isAdmin) || mutation.pending
              }
              onChange={async (e) => {
                const next = e.target.value as SkillAccess;
                const done = await mutation.run(
                  () => setSkillAccess(teamId, skill.id, next),
                  (v) =>
                    v.warning === "many_required"
                      ? `${ACCESS_LABEL[v.access]}. The team now has ${v.requiredCount} Required skills: they load in every run and count first against the limit of 64.`
                      : `${ACCESS_LABEL[v.access]}.`,
                );
                if (done) reload();
              }}
            >
              {ACCESS_ORDER.map((a) => (
                <option key={a} value={a} disabled={a === "required" && !isAdmin}>
                  {ACCESS_LABEL[a]}
                </option>
              ))}
            </Select>
          </Field>
          {!canSet && <p className={HINT}>Only builders and team admins can change this.</p>}
          {canSet && !isAdmin && <p className={HINT}>Only team admins set or change Required.</p>}
          <MutationStatus error={mutation.error} notice={mutation.notice} />
          {!state.data.approved && (
            <p className={HINT}>
              No version is approved yet: no agent gets this skill until a team admin approves one.
            </p>
          )}
          <ReachList reach={state.data} />
          <AddToAgent slug={skill.slug} agents={state.data.agents} />
        </>
      )}
    </Section>
  );
}

function ReachList({ reach }: { readonly reach: SkillReach }) {
  const using = reach.agents.filter((a) => a.via !== null);
  if (using.length === 0) return <p>No agent uses it yet.</p>;
  return (
    <ul aria-label="Agents using this skill">
      {using.map((a) => (
        <li key={a.id}>
          <strong>{a.name}</strong> {ORIGIN[a.scope]} ·{" "}
          {a.via === "named" ? "names it" : "by its access mode"}
        </li>
      ))}
    </ul>
  );
}

/** Team agents the caller may edit that don't name the skill yet (not even in their draft). */
function AddToAgent({
  slug,
  agents,
}: {
  readonly slug: string;
  readonly agents: readonly SkillReachAgent[];
}) {
  const [chosen, setChosen] = useState("");
  const navigate = useNavigate();
  const choices = agents.filter((a) => a.canEdit && a.via !== "named" && !a.inDraft);
  if (choices.length === 0) return null;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (chosen !== "") navigate(addSkillHref(chosen, slug));
      }}
    >
      <FormRow className="mb-1">
        <Field label="Add to agent…">
          <Select value={chosen} onChange={(e) => setChosen(e.target.value)}>
            <option value="">Choose an agent</option>
            {choices.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        </Field>
        <Button type="submit" disabled={chosen === ""}>
          Open in builder
        </Button>
      </FormRow>
      <p className={HINT}>
        The builder opens with the skill added to the agent&apos;s draft; save and publish it there.
      </p>
    </form>
  );
}

/** Usage in this team; nothing at all for a caller who may not see it (403). */
function Usage({ skill }: { readonly skill: SkillSummary }) {
  const teamId = useTeamAccess().team.id;
  const { state } = useResource(() => getSkillUsage(teamId, skill.id));
  if (state.status !== "ready") return null;
  return (
    <Section id="skill-usage-heading" title="Usage in this team (last 90 days)">
      <UsageText usage={state.data} />
    </Section>
  );
}

function UsageText({ usage }: { readonly usage: SkillUsage }) {
  if (usage.uses === 0) return <p>Not used yet.</p>;
  const others = usage.agents.filter((a) => a.name === null).reduce((n, a) => n + a.uses, 0);
  return (
    <>
      <p>
        Used {usage.uses} {usage.uses === 1 ? "time" : "times"}, last{" "}
        <DateTime value={usage.lastUsedAt} />.
      </p>
      <ul aria-label="Uses by agent">
        {usage.agents
          .filter((a) => a.name !== null)
          .map((a) => (
            <li key={a.agentId ?? ""}>
              {a.name}: {a.uses}
            </li>
          ))}
        {others > 0 && <li>Other agents: {others}</li>}
      </ul>
    </>
  );
}
