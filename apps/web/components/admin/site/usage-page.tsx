"use client";

import { getSiteUsage } from "../../../lib/admin/api/usage";
import { UsageDashboard } from "../usage/usage-dashboard";
import { SiteBudget } from "./site-budget";

/**
 * Site console: model usage and spend across every team (KOBE-43). Counts and costs only:
 * site admins never see team content here (D8).
 */
export function SiteUsagePage() {
  return (
    <>
      <h1>Usage and spend</h1>
      <p>Model calls across every team, by team, user, model and agent.</p>
      <SiteBudget />
      <h2>Usage</h2>
      <UsageDashboard load={getSiteUsage} />
    </>
  );
}
