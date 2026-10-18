"use client";

import {
  getSkillChoices,
  setSkillChoice,
  type ChoiceKind,
  type PersonalChoice,
  type TeamChoice,
} from "../../../../lib/admin/api/team/skill-choices";
import { Checkbox, Section } from "../../../ui/console";
import { useTeamAccess } from "../../console-context";
import { MutationStatus } from "../../error-notice";
import { ResourceView } from "../../parts";
import { useMutation, useResource } from "../../use-resource";

const HINT = "m-0 my-1 text-sm text-console-muted";

const ACCESS_HINT: Readonly<Record<TeamChoice["access"], string>> = {
  available: "Available: off unless you turn it on.",
  default_on: "On by default: you can turn it off.",
  required: "Required by the team: always on.",
  hidden: "Hidden: only for agents that name it.",
};

/**
 * What loads in your runs in this team (KOBE-316, SK27, D22): your personal skills, each on or
 * off here only, and the team's skills and catalog installs you turn on or off for yourself.
 * Changes apply from your next run. Required skills are the team's choice.
 */
export function MySkillChoices() {
  const access = useTeamAccess();
  const teamId = access.team.id;
  const { state, reload } = useResource(() => getSkillChoices(teamId));
  const mutation = useMutation();
  const toggle = async (kind: ChoiceKind, skill: PersonalChoice, enabled: boolean) => {
    const done = await mutation.run(
      () => setSkillChoice(teamId, { kind, skillId: skill.skillId, enabled }),
      () => `${skill.name} is ${enabled ? "on" : "off"} for your runs in ${access.team.name}.`,
    );
    if (done) reload();
  };
  return (
    <Section
      id="my-skill-choices-heading"
      title={`Skills in your runs in ${access.team.name}`}
      description="Changes apply from your next run, in this team only."
    >
      <ResourceView state={state} label="your skill choices">
        {(choices) => (
          <>
            <Group title="Your personal skills" empty="You have no personal skills yet.">
              {choices.personal.map((s) => (
                <Checkbox
                  key={s.skillId}
                  label={s.name}
                  checked={s.enabled}
                  disabled={mutation.pending}
                  onChange={(e) => toggle("personal", s, e.target.checked)}
                />
              ))}
            </Group>
            <TeamGroup
              title="Team skills"
              kind="team"
              skills={choices.team}
              pending={mutation.pending}
              toggle={toggle}
            />
            <TeamGroup
              title="From the catalog"
              kind="catalog"
              skills={choices.catalog}
              pending={mutation.pending}
              toggle={toggle}
            />
            <MutationStatus error={mutation.error} notice={mutation.notice} />
          </>
        )}
      </ResourceView>
    </Section>
  );
}

function Group({
  title,
  empty,
  children,
}: {
  readonly title: string;
  readonly empty: string;
  readonly children: readonly React.ReactNode[];
}) {
  return (
    <fieldset className="mb-3">
      <legend className="font-semibold">{title}</legend>
      {children.length === 0 ? <p className={HINT}>{empty}</p> : children}
    </fieldset>
  );
}

function TeamGroup({
  title,
  kind,
  skills,
  pending,
  toggle,
}: {
  readonly title: string;
  readonly kind: ChoiceKind;
  readonly skills: readonly TeamChoice[];
  readonly pending: boolean;
  readonly toggle: (kind: ChoiceKind, skill: PersonalChoice, enabled: boolean) => unknown;
}) {
  return (
    <Group title={title} empty="None.">
      {skills.map((s) => (
        <Checkbox
          key={s.skillId}
          label={s.name}
          hint={ACCESS_HINT[s.access]}
          checked={s.enabled}
          disabled={pending || s.access === "required"}
          onChange={(e) => toggle(kind, s, e.target.checked)}
        />
      ))}
    </Group>
  );
}
