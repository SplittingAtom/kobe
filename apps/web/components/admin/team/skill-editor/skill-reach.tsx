"use client";

import { useState } from "react";
import {
  getSkillReach,
  getSkillUsage,
  setSkillOffer,
  type SkillReach,
  type SkillReachAgent,
  type SkillSummary,
  type SkillUsage,
} from "../../../../lib/admin/api/team/skills";
import { addSkillHref, TEAM_SKILL_RULE } from "../../../../lib/admin/skills/reach";
import { Button, Checkbox, Field, FormRow, Section, Select } from "../../../ui/console";
import { useTeamAccess } from "../../console-context";
import { MutationStatus } from "../../error-notice";
import { DateTime } from "../../parts";
import { useMutation, useResource } from "../../use-resource";

const HINT = "m-0 my-1 text-sm text-console-muted";

/**
 * Where a skill is used (KOBE-297), under its editor: for a team skill, the agents whose runs get
 * it (named, or by "Offer to all agents", which team admins switch) and "Add to agent…"; for any
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

  return (
    <Section id="skill-reach-heading" title="Agents using this skill" description={TEAM_SKILL_RULE}>
      {state.status === "loading" && <p role="status">Loading agents…</p>}
      {state.status === "error" && (
        <p className={HINT}>The agents using this skill could not be read.</p>
      )}
      {state.status === "ready" && (
        <>
          <Checkbox
            label="Offer to all agents"
            checked={state.data.offerToAll}
            disabled={!isAdmin || mutation.pending}
            onChange={async (e) => {
              const next = e.target.checked;
              const done = await mutation.run(
                () => setSkillOffer(teamId, skill.id, next),
                (v) =>
                  v.offerToAll
                    ? "Offered to all agents that aren't exclusive."
                    : "No longer offered to all agents.",
              );
              if (done) reload();
            }}
          />
          {!isAdmin && <p className={HINT}>Only team admins can change this.</p>}
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
          {a.via === "named" ? "names it" : "offered to all"}
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
  const choices = agents.filter((a) => a.canEdit && a.via !== "named" && !a.inDraft);
  if (choices.length === 0) return null;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (chosen !== "") window.location.assign(addSkillHref(chosen, slug));
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
