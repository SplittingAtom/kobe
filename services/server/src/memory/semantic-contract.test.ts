import { describe, expect, it } from "vitest";
import {
  AUDIT_EVENTS,
  isAuditAction,
  NOTIFICATION_KINDS as DB_NOTIFICATION_KINDS,
  SEMANTIC_MEMORY_ACTOR_KIND_VALUES,
  SEMANTIC_MEMORY_EVIDENCE_MAX_BYTES,
  SEMANTIC_MEMORY_KIND_VALUES,
  SEMANTIC_MEMORY_SCOPE_VALUES,
  SEMANTIC_MEMORY_SOURCE_ENTRIES_MAX,
  SEMANTIC_MEMORY_STATEMENT_MAX as DB_STATEMENT_MAX,
  SEMANTIC_MEMORY_STATUS_VALUES,
  SEMANTIC_MEMORY_TAG_MAX as DB_TAG_MAX,
  SEMANTIC_MEMORY_TAGS_MAX as DB_TAGS_MAX,
  SITE_MEMORY_ACTOR_KIND_VALUES,
  siteGrant,
} from "@kobe/db";
import {
  MEMORY_NOTIFICATION_KINDS,
  MEMORY_STEWARD_SITE_GRANT,
  RESERVED_MEMORY_AUDIT_ACTIONS,
  SEMANTIC_MEMORY_ACTOR_KINDS,
  SEMANTIC_MEMORY_KINDS,
  SEMANTIC_MEMORY_SCOPES,
  SEMANTIC_MEMORY_SOURCE_ENTRIES_MAX as WIRE_SOURCE_ENTRIES_MAX,
  SEMANTIC_MEMORY_STATEMENT_MAX,
  SEMANTIC_MEMORY_STATUSES,
  SEMANTIC_MEMORY_TAG_MAX,
  SEMANTIC_MEMORY_TAGS_MAX,
  SITE_GRANTS,
} from "@kobe/protocol";

/** KOBE-377: the semantic memory contract matches the KOBE-376 schema exactly. */
describe("semantic memory contract matches the schema", () => {
  it.each([
    ["scopes", SEMANTIC_MEMORY_SCOPE_VALUES, SEMANTIC_MEMORY_SCOPES],
    ["kinds", SEMANTIC_MEMORY_KIND_VALUES, SEMANTIC_MEMORY_KINDS],
    ["statuses", SEMANTIC_MEMORY_STATUS_VALUES, SEMANTIC_MEMORY_STATUSES],
    [
      "actor kinds (Workspace/portable ∪ Site)",
      [...new Set([...SEMANTIC_MEMORY_ACTOR_KIND_VALUES, ...SITE_MEMORY_ACTOR_KIND_VALUES])],
      SEMANTIC_MEMORY_ACTOR_KINDS,
    ],
  ] as const)("%s", (_name, db, protocol) => {
    expect([...db]).toEqual([...protocol]);
  });

  it("limits", () => {
    expect(SEMANTIC_MEMORY_STATEMENT_MAX).toBe(DB_STATEMENT_MAX);
    expect(SEMANTIC_MEMORY_TAGS_MAX).toBe(DB_TAGS_MAX);
    expect(SEMANTIC_MEMORY_TAG_MAX).toBe(DB_TAG_MAX);
    expect(WIRE_SOURCE_ENTRIES_MAX).toBe(SEMANTIC_MEMORY_SOURCE_ENTRIES_MAX);
    expect(SEMANTIC_MEMORY_EVIDENCE_MAX_BYTES).toBeGreaterThan(0);
  });

  it("audit: Phase A actions registered with the schema's scopes; Phase B/C names reserved", () => {
    const created = AUDIT_EVENTS["memory.item.created"].target.shape;
    expect(created.scope.options).toEqual([...SEMANTIC_MEMORY_SCOPES]);
    expect(created.kind.options).toEqual([...SEMANTIC_MEMORY_KINDS]);
    expect(created.actorKind.options).toEqual([...SEMANTIC_MEMORY_ACTOR_KINDS]);
    for (const action of RESERVED_MEMORY_AUDIT_ACTIONS) {
      expect(action).toMatch(/^memory\.[a-z_]+\.[a-z_]+$/);
      expect(isAuditAction(action), action).toBe(false);
    }
  });

  // KOBE-645 flips this to `toContain` when its migration adds the names.
  it("notification kinds wait for their migration (KOBE-645)", () => {
    for (const kind of MEMORY_NOTIFICATION_KINDS)
      expect(DB_NOTIFICATION_KINDS as readonly string[]).not.toContain(kind);
  });

  it("the Site steward grant is a site_grant value and a SITE_GRANTS member (KOBE-380)", () => {
    expect(siteGrant.enumValues as readonly string[]).toContain(MEMORY_STEWARD_SITE_GRANT);
    expect(SITE_GRANTS as readonly string[]).toContain(MEMORY_STEWARD_SITE_GRANT);
  });
});
