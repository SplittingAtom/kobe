"use client";

import { SiteGrantSection, type SiteGrantCopy } from "./site-grant-section";

export const SITE_STEWARD_HINT =
  "Site memory stewards curate Site memory: they add, edit, archive and pin the facts and conventions every workspace sees, and accept or dismiss what team admins propose for the Site. They can't make an item Policy or change memory switches, and the grant gives no other Site rights. Site admins can already do all of this.";

const SITE_STEWARD_COPY: SiteGrantCopy = {
  grant: "memory_steward",
  title: "Site memory stewards",
  hint: SITE_STEWARD_HINT,
  name: "Site memory steward",
  pickerLabel: "Steward",
  takeDescription: "They can no longer change Site memory. What they saved stays.",
  offerAdmins: false,
};

/** Site memory stewards (KOBE-380, SM19): the `memory_steward` site grant. */
export function SiteMemoryStewardsSection() {
  return <SiteGrantSection copy={SITE_STEWARD_COPY} />;
}
