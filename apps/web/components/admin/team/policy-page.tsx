"use client";

import { createTeamRule, deleteTeamRule, listTeamRules } from "../../../lib/admin/api/team/policy";
import { PageHeader } from "../../ui/console";
import { useTeamAccess } from "../console-context";
import { RulesEditor } from "../policy-rules";

/** Team tool policy (spec D6/D29; `/v1/team/policy`, KOBE-35). */
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
    </>
  );
}
