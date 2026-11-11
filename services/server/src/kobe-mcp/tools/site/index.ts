import type { KobeTool } from "../../catalog.js";
import {
  siteEgressCeilingAdd,
  siteEgressCeilingList,
  siteEgressCeilingSet,
  siteEgressRequestsDecide,
  siteEgressRequestsList,
} from "./egress.js";
import {
  siteConnectorsList,
  siteConnectorsSetStatus,
  siteModelsCatalogUpdate,
  siteModelsList,
} from "./models.js";
import {
  siteInvitesCreate,
  siteInvitesList,
  siteInvitesRevoke,
  siteTeamsCreate,
  siteTeamsList,
  siteUsersDeactivate,
  siteUsersList,
  siteUsersReactivate,
} from "./people.js";
import { siteAuditList, siteUsageRead } from "./reads.js";
import { siteBrandingGet, siteBrandingSet, siteBudgetGet, siteBudgetSet } from "./settings.js";
import {
  siteGrantsGive,
  siteGrantsList,
  siteGrantsTake,
  siteSkillBlocklistAdd,
  siteSkillBlocklistList,
  siteSkillBlocklistRemove,
  siteSkillReviewsClaim,
  siteSkillReviewsComment,
  siteSkillReviewsDecide,
  siteSkillReviewsList,
  siteSkillReviewsRejectAndBlock,
} from "./skills.js";

/**
 * The Site console tools (KOBE-622, spec kobe-admin-mcp §5 Site list, KA3, KA8). Console-only by
 * KA8 (no tool): break-glass, ownership transfer, site roles, legal hold, retention and every
 * irreversible deletion; the rest left out is listed in docs/ledger/KOBE-622.md.
 */
export const KOBE_SITE_TOOLS: readonly KobeTool[] = [
  siteUsersList,
  siteUsersDeactivate,
  siteUsersReactivate,
  siteTeamsList,
  siteTeamsCreate,
  siteInvitesList,
  siteInvitesCreate,
  siteInvitesRevoke,
  siteModelsList,
  siteModelsCatalogUpdate,
  siteConnectorsList,
  siteConnectorsSetStatus,
  siteEgressCeilingList,
  siteEgressCeilingAdd,
  siteEgressCeilingSet,
  siteEgressRequestsList,
  siteEgressRequestsDecide,
  siteSkillReviewsList,
  siteSkillReviewsClaim,
  siteSkillReviewsComment,
  siteSkillReviewsDecide,
  siteSkillReviewsRejectAndBlock,
  siteSkillBlocklistList,
  siteSkillBlocklistAdd,
  siteSkillBlocklistRemove,
  siteGrantsList,
  siteGrantsGive,
  siteGrantsTake,
  siteBrandingGet,
  siteBrandingSet,
  siteBudgetGet,
  siteBudgetSet,
  siteUsageRead,
  siteAuditList,
];
