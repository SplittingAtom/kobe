import {
  listAgentSkillUpdates,
  type AgentSkillLeftOut,
  type AgentSkillUpdate,
} from "../../../../lib/admin/api/team/agent-builder";
import { Notice } from "../../../ui/console";
import { useResource } from "../../use-resource";

const WHY: Readonly<Record<Exclude<AgentSkillUpdate["status"], "ok">, string>> = {
  blocklisted: "is blocklisted",
  suspended: "is suspended after a rescan",
  not_approved: "is no longer approved",
};

/** Why no version of a skill can load (a publish left it out). */
const NONE: Readonly<Record<AgentSkillLeftOut["reason"], string>> = {
  blocklisted: "every version is blocklisted",
  suspended: "its newest version is suspended after a rescan",
  not_approved: "it has no approved version",
};

/** A publish's warning for a skill it left out of the frozen versions (KOBE-318). */
export const leftOutText = (s: AgentSkillLeftOut, version: number) =>
  `${s.name} is left out of v${version}: ${NONE[s.reason]}.`;

/**
 * "Skill update available" (KOBE-318, SK28): the current version runs the team skill versions it
 * froze at publish. A newer loadable version shows here, and publishing again picks it up; a
 * frozen version that is now blocklisted, suspended or no longer approved is named with its
 * reason, since runs leave it out (it is never swapped for another version), and so is a skill
 * the publish left out because none of its versions could load. Quiet while loading, on an error
 * and when there is nothing to say.
 */
export function SkillUpdates({
  teamId,
  agentId,
  version,
}: {
  readonly teamId: string;
  readonly agentId: string;
  readonly version: number;
}) {
  const { state } = useResource(() => listAgentSkillUpdates(teamId, agentId));
  if (state.status !== "ready") return null;
  const { skills } = state.data;
  const left = skills.filter((s) => s.status !== "ok" && s.frozen !== null);
  const none = skills.filter((s) => s.frozen === null && s.update === null);
  const updates = skills.filter((s) => s.update !== null);
  if (left.length + none.length + updates.length === 0) return null;
  return (
    <Notice
      tone={left.length + none.length > 0 ? "warn" : "info"}
      title="Skill versions"
      className="my-4"
    >
      <ul className="m-0 list-none p-0">
        {left.map((s) => (
          <li key={`left-${s.name}`}>
            {s.name} {s.frozen?.semver} {WHY[s.status as keyof typeof WHY]}: runs of v{version}{" "}
            leave it out.
          </li>
        ))}
        {none.map((s) => (
          <li key={`none-${s.name}`}>
            {leftOutText(
              { name: s.name, reason: s.status === "ok" ? "not_approved" : s.status },
              version,
            )}
          </li>
        ))}
        {updates.map((s) => (
          <li key={`update-${s.name}`}>
            Skill update available: {s.name} {s.frozen ? `${s.frozen.semver} → ` : ""}
            {s.update?.semver}. Publish again to use it.
          </li>
        ))}
      </ul>
    </Notice>
  );
}
