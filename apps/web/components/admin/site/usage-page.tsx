"use client";

import { getSiteUsage } from "../../../lib/admin/api/usage";
import { PageHeader, Section } from "../../ui/console";
import { UsageDashboard } from "../usage/usage-dashboard";
import { SiteBudget } from "./site-budget";

/**
 * Site console: model usage and spend across every team (KOBE-43). Counts and costs only:
 * site admins never see team content here (D8).
 */
export function SiteUsagePage() {
  return (
    <>
      <PageHeader
        title="Usage and spend"
        description="Model calls across every team, by team, user, model and agent."
      />
      <SiteBudget />
      <Section title="Usage">
        <UsageDashboard load={getSiteUsage} />
      </Section>
    </>
  );
}
