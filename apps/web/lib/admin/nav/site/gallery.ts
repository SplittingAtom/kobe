import { SITE_TAB_HREF } from "../../../agents/redirects";
import { defineSiteSection, movedTo } from "../types";

export default defineSiteSection({
  id: "gallery",
  label: "Gallery agents",
  description:
    "Site-wide agents on the Agents page's Site tab: edit, compare with the repository, reset, evaluate, export, approve.",
  group: "Teams and agents",
  order: 20,
  minRole: "admin",
  // The list moved to /agents?tab=site (KOBE-570, AR12); the gallery editor stays here.
  status: movedTo(SITE_TAB_HREF),
});
