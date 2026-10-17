"use client";

import { createTeamRule, deleteTeamRule, listTeamRules } from "../../../lib/admin/api/team/policy";
import {
  getTeamRememberLimits,
  listMemberRules,
  putTeamRememberLimits,
  revokeMemberRule,
} from "../../../lib/admin/api/remember";
import { PageHeader, Section } from "../../ui/console";
import { useTeamAccess } from "../console-context";
import { ResourceView } from "../parts";
import { RememberLimitsForm } from "../remember-limits-form";
import { RememberedRules } from "../remembered-rules";
import { RulesEditor } from "../policy-rules";
import { useResource } from "../use-resource";

const MEMBER_RULES = "member-rules";

/**
 * Team tool policy (spec D6/D29; `/v1/team/policy`, KOBE-35), members' remembered approvals with
 * revoke, and the team's remember limits inside the site floor (KOBE-289).
 */
export function TeamPolicyPage() {
  const teamId = useTeamAccess().team.id;
  return (
    <>
      <PageHeader
        title="Policy"
        description="Team rules apply inside the site floor: they can deny or ask for more, and allow rules only pre-approve one built-in tool or one connector's tools. Site deny and ask rules always win."
      />
      <RulesEditor
        caption="Team rules"
        effects={["deny", "ask", "allow"]}
        load={() => listTeamRules(teamId)}
        create={(rule) => createTeamRule(teamId, rule)}
        remove={(id) => deleteTeamRule(teamId, id)}
      />
      <Section
        id={MEMBER_RULES}
        title="Members' remembered approvals"
        description="Approvals members asked Kobe to remember in this team. They only lift risk and mode prompts in the member's own interactive conversations; your deny and ask rules still apply. Revoking takes effect at the next tool call."
      >
        <RememberedRules
          caption="Remembered approvals"
          headingId={MEMBER_RULES}
          showMember
          load={() => listMemberRules(teamId)}
          revoke={(id) => revokeMemberRule(teamId, id)}
          empty="No member has a remembered approval."
        />
      </Section>
      <Section
        title="Remember limits"
        description="What members may choose when they remember an approval. The site floor's limits always apply; a team can only tighten them."
      >
        <TeamLimits teamId={teamId} />
      </Section>
    </>
  );
}

function TeamLimits({ teamId }: { readonly teamId: string }) {
  const { state, reload } = useResource(() => getTeamRememberLimits(teamId));
  return (
    <ResourceView state={state} label="remember limits">
      {(limits) => (
        <RememberLimitsForm
          label="Team remember limits"
          initial={limits.effective}
          floor={limits.site}
          save={(next) => putTeamRememberLimits(teamId, next)}
          onSaved={reload}
        />
      )}
    </ResourceView>
  );
}
