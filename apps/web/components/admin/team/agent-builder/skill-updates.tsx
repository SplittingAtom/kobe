import {
  listAgentSkillUpdates,
  type AgentSkillUpdate,
} from "../../../../lib/admin/api/team/agent-builder";
import { Notice } from "../../../ui/console";
import { useResource } from "../../use-resource";

const WHY: Readonly<Record<Exclude<AgentSkillUpdate["status"], "ok">, string>> = {
  blocklisted: "is blocklisted",
  suspended: "is suspended after a rescan",
  not_approved: "is no longer approved",
};

const frozenLabel = (s: AgentSkillUpdate) => (s.frozen ? `${s.name} ${s.frozen.semver}` : s.name);

/**
 * "Skill update available" (KOBE-318, SK28): the current version runs the team skill versions it
 * froze at publish. A newer valid version shows here, and publishing again picks it up; a frozen
 * version that is now blocklisted, suspended or no longer approved is named with its reason,
 * since runs leave it out (it is never swapped for another version). Quiet while loading, on an
 * error and when there is nothing to say.
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
  const left = state.data.skills.filter((s) => s.status !== "ok" && s.frozen !== null);
  const updates = state.data.skills.filter((s) => s.update !== null);
  if (left.length === 0 && updates.length === 0) return null;
  return (
    <Notice tone={left.length > 0 ? "warn" : "info"} title="Skill versions" className="my-4">
      <ul className="m-0 list-none p-0">
        {left.map((s) => (
          <li key={`left-${s.name}`}>
            {frozenLabel(s)} {WHY[s.status as keyof typeof WHY]}: runs of v{version} leave it out.
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
