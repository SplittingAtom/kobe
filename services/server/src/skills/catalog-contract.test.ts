import { describe, expect, it } from "vitest";
import {
  registryPublisher,
  registryReviewAction,
  registrySkillStatus,
  registryTagKind,
  registryTagStatus,
  registryVersionState,
  scanVerdict,
  siteGrant,
  skillAccess,
  skillInstallOrigin,
  skillPinMode,
} from "@kobe/db";
import {
  REGISTRY_PUBLISHERS,
  REGISTRY_REVIEW_ACTIONS,
  REGISTRY_SKILL_STATUSES,
  REGISTRY_TAG_KINDS,
  REGISTRY_TAG_STATUSES,
  REGISTRY_VERSION_STATES,
  SCAN_VERDICTS,
  SITE_GRANTS,
  SKILL_ACCESS_MODES,
  SKILL_INSTALL_ORIGINS,
  SKILL_PIN_MODES,
} from "@kobe/protocol";

/** KOBE-311: the database enums of the catalog are exactly the protocol's closed sets. */
describe("catalog enums match the protocol contract", () => {
  it.each([
    ["skill_pin_mode", skillPinMode.enumValues, SKILL_PIN_MODES],
    ["skill_access", skillAccess.enumValues, SKILL_ACCESS_MODES],
    ["skill_install_origin", skillInstallOrigin.enumValues, SKILL_INSTALL_ORIGINS],
    ["registry_tag_kind", registryTagKind.enumValues, REGISTRY_TAG_KINDS],
    ["registry_tag_status", registryTagStatus.enumValues, REGISTRY_TAG_STATUSES],
    ["registry_publisher", registryPublisher.enumValues, REGISTRY_PUBLISHERS],
    ["registry_skill_status", registrySkillStatus.enumValues, REGISTRY_SKILL_STATUSES],
    ["registry_version_state", registryVersionState.enumValues, REGISTRY_VERSION_STATES],
    ["registry_review_action", registryReviewAction.enumValues, REGISTRY_REVIEW_ACTIONS],
    ["scan_verdict", scanVerdict.enumValues, SCAN_VERDICTS],
    ["site_grant", siteGrant.enumValues, SITE_GRANTS],
  ] as const)("%s", (_name, db, protocol) => {
    expect([...db]).toEqual([...protocol]);
  });
});
