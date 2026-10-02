"use client";

import { createTeamRule, deleteTeamRule, listTeamRules } from "../../../lib/admin/api/team/policy";
import { useTeamAccess } from "../console-context";
import { RulesEditor } from "../policy-rules";
import styles from "../admin.module.css";

/** Team tool policy (spec D6/D29; `/v1/team/policy`, KOBE-35). */
export function TeamPolicyPage() {
  const teamId = useTeamAccess().team.id;
  return (
    <>
      <h1>Policy</h1>
      <p className={styles.hint}>
        Team rules apply inside the install floor: they can deny or ask for more, and allow rules
        only pre-approve one built-in tool or one connector&apos;s tools. Install deny and ask rules
        always win.
      </p>
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
