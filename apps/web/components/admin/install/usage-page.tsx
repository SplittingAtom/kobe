"use client";

import { getInstallUsage } from "../../../lib/admin/api/usage";
import { UsageDashboard } from "../usage/usage-dashboard";

/**
 * Install console: model usage and spend across every team (KOBE-43). Counts and costs only:
 * install admins never see team content here (D8).
 */
export function InstallUsagePage() {
  return (
    <>
      <h1>Usage and spend</h1>
      <p>Model calls across every team, by team, user, model and agent.</p>
      <UsageDashboard load={getInstallUsage} />
    </>
  );
}
