"use client";

import { getTeamUsage } from "../../../lib/admin/api/usage";
import { useTeamAccess } from "../console-context";
import { UsageDashboard } from "../usage/usage-dashboard";

/** Team console: the team's model usage and spend (KOBE-43; team admins, D8). */
export function TeamUsagePage() {
  const teamId = useTeamAccess().team.id;
  return (
    <>
      <h1>Usage</h1>
      <p>Model calls made from this team's sandboxes, by user, model and agent.</p>
      <UsageDashboard load={(q) => getTeamUsage(teamId, q)} />
    </>
  );
}
