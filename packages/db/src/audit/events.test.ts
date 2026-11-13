import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AUDIT_ACTIONS,
  AUDIT_CATEGORIES,
  AUDIT_EVENTS,
  HISTORICAL_AUDIT_ACTIONS,
  auditActionNames,
  auditCategoryNames,
  isAuditAction,
} from "./events.js";
import { AUDIT_VIA_AGENT_KEY } from "./write.js";

/** Field names that suggest content or credentials; the allowlist must never contain them. */
const FORBIDDEN_FIELD =
  /password|secret|token|key$|cookie|^code$|prompt|content|message|text|body|input|output|totp/i;

describe("audit event taxonomy", () => {
  it.each(AUDIT_ACTIONS)("%s is a valid action name (matches the database check)", (action) => {
    expect(action).toMatch(/^[a-z][a-z_]*(\.[a-z][a-z_]*){1,3}$/);
    expect(action.length).toBeLessThanOrEqual(64);
  });

  it.each(AUDIT_ACTIONS)(
    "%s has a strict target without content or credential fields",
    (action) => {
      const { target } = AUDIT_EVENTS[action];
      expect(target.safeParse({ unexpected: 1 }).success).toBe(false);
      expect(Object.keys(target.shape).filter((k) => FORBIDDEN_FIELD.test(k))).toEqual([]);
      // KOBE-618: `viaAgent` is the person-via-agent record `audit()` adds to any action.
      expect(Object.keys(target.shape)).not.toContain(AUDIT_VIA_AGENT_KEY);
      // Free text is bounded everywhere: every string field has a maximum length or a format.
      for (const [field, schema] of Object.entries(target.shape)) {
        const inner = schema instanceof z.ZodOptional ? schema.unwrap() : schema;
        if (inner instanceof z.ZodString) {
          expect(inner.maxLength ?? inner.format, `${action}.${field}`).toBeTruthy();
        }
      }
    },
  );

  it("has the categories the read API filters on", () => {
    expect(AUDIT_CATEGORIES.sort()).toEqual([
      "agent",
      "approval",
      "audit",
      "auth",
      "egress",
      "governance",
      "identity",
      "mcp",
      "memory",
      "models",
      "platform",
      "policy",
      "project",
      "registry",
      "retention",
      "run",
      "sandbox",
      "schedule",
      "site",
      "skill",
      "team",
      "thread",
      "thread_folder",
      "workspace",
    ]);
  });

  // KOBE-255: "install" became "site". Rows written before keep their names (the hash chain
  // covers them); readers and filters treat each historical name as its successor.
  it("maps every historical install name to a current site action, never written again", () => {
    expect(HISTORICAL_AUDIT_ACTIONS).toEqual({
      "install.settings.updated": "site.settings.updated",
      "identity.install_role.granted": "identity.site_role.granted",
      "identity.install_role.revoked": "identity.site_role.revoked",
      "memory.install_settings_changed": "memory.site_settings_changed",
    });
    for (const [old, current] of Object.entries(HISTORICAL_AUDIT_ACTIONS)) {
      expect(isAuditAction(old)).toBe(false);
      expect(isAuditAction(current)).toBe(true);
      expect(auditActionNames(current)).toEqual([current, old]);
    }
    expect(AUDIT_ACTIONS.filter((a) => /install/.test(a))).toEqual([]);
    expect(auditActionNames("auth.sign_out")).toEqual(["auth.sign_out"]);
  });

  it("filters the site category over historical site rows too", () => {
    expect(auditCategoryNames("site")).toEqual(["site", "install"]);
    expect(auditCategoryNames("identity")).toEqual(["identity"]);
  });

  it("sandbox.runtime_tampered records ids and the run kind only (KOBE-271)", () => {
    const { scope, target } = AUDIT_EVENTS["sandbox.runtime_tampered"];
    expect(scope).toBe("team");
    const ids = {
      sandboxId: "0b8f2a3e-5d1c-4e8f-9a6b-7c2d1e0f3a4b",
      userId: "1b8f2a3e-5d1c-4e8f-9a6b-7c2d1e0f3a4b",
      threadId: "2b8f2a3e-5d1c-4e8f-9a6b-7c2d1e0f3a4b",
      runId: "3b8f2a3e-5d1c-4e8f-9a6b-7c2d1e0f3a4b",
      replicaId: "4b8f2a3e-5d1c-4e8f-9a6b-7c2d1e0f3a4b",
    };
    expect(target.safeParse({ ...ids, runKind: "message" }).success).toBe(true);
    expect(target.safeParse({ ...ids, runKind: "compaction" }).success).toBe(true);
    expect(target.safeParse({ ...ids, runKind: "other" }).success).toBe(false);
    expect(target.safeParse({ ...ids, runKind: "message", reason: "x" }).success).toBe(false);
  });

  it("records a branding change per setting, with a label or a sha256 (KOBE-497, TH12)", () => {
    const { target, scope } = AUDIT_EVENTS["site.branding.updated"];
    expect(scope).toBe("site");
    const sha = "0123456789abcdef".repeat(4);
    expect(target.safeParse({ setting: "app_name", value: "Acme" }).success).toBe(true);
    expect(target.safeParse({ setting: "theme", value: "tokyo-nights" }).success).toBe(true);
    expect(target.safeParse({ setting: "show_name", value: "false" }).success).toBe(true);
    expect(target.safeParse({ setting: "logo_theme_color", value: "true" }).success).toBe(true);
    for (const setting of ["logo", "logo_dark", "favicon"])
      expect(target.safeParse({ setting, value: sha }).success).toBe(true);
    expect(target.safeParse({ setting: "css", value: "x" }).success).toBe(false);
    expect(target.safeParse({ setting: "app_name", value: "" }).success).toBe(false);
    expect(target.safeParse({ setting: "app_name", value: "a\nb" }).success).toBe(false);
    expect(target.safeParse({ setting: "logo", value: sha, bytes: "x" }).success).toBe(false);
  });

  it("records SSO and SCIM actions by ids and codes only (KOBE-625, spec sso-oidc-scim §12)", () => {
    const providerId = "0b8f2a3e-5d1c-4e8f-9a6b-7c2d1e0f3a4b";
    const userId = "1b8f2a3e-5d1c-4e8f-9a6b-7c2d1e0f3a4b";
    const teamId = "2b8f2a3e-5d1c-4e8f-9a6b-7c2d1e0f3a4b";
    const credentialId = "3b8f2a3e-5d1c-4e8f-9a6b-7c2d1e0f3a4b";
    const sso = AUDIT_ACTIONS.filter((a) => /^identity\.(sso|scim)\./.test(a)).sort();
    expect(sso).toEqual([
      "identity.scim.deactivation_refused",
      "identity.scim.group.created",
      "identity.scim.group.deleted",
      "identity.scim.group.updated",
      "identity.scim.reactivation_refused",
      "identity.scim.token.created",
      "identity.scim.token.revoked",
      "identity.scim.user.created",
      "identity.scim.user.deactivated",
      "identity.scim.user.reactivated",
      "identity.scim.user.updated",
      "identity.sso.link.created",
      "identity.sso.link.removed",
      "identity.sso.link_expectation.withdrawn",
      "identity.sso.link_expected",
      "identity.sso.mapping.created",
      "identity.sso.mapping.deleted",
      "identity.sso.mapping_conflict",
      "identity.sso.provider.created",
      "identity.sso.provider.deleted",
      "identity.sso.provider.disabled",
      "identity.sso.provider.enabled",
      "identity.sso.provider.updated",
    ]);
    for (const a of sso) expect(AUDIT_EVENTS[a].scope, a).toBe("site");

    const ok = (action: keyof typeof AUDIT_EVENTS, target: unknown) =>
      AUDIT_EVENTS[action].target.safeParse(target).success;
    expect(ok("auth.sign_in.succeeded", { method: "sso" })).toBe(true);
    expect(ok("auth.sign_in.failed", { method: "sso", reason: "groups_overage" })).toBe(true);
    expect(
      ok("identity.sso.provider.created", { providerId, slug: "contoso", kind: "entra" }),
    ).toBe(true);
    expect(ok("identity.sso.provider.created", { providerId, slug: "contoso", kind: "saml" })).toBe(
      false,
    );
    expect(
      ok("identity.sso.mapping.created", {
        providerId,
        mappingId: credentialId,
        teamId,
        role: "member",
      }),
    ).toBe(true);
    // Team roles only (SSO6).
    expect(
      ok("identity.sso.mapping.created", {
        providerId,
        mappingId: credentialId,
        teamId,
        role: "owner",
      }),
    ).toBe(false);
    expect(
      ok("identity.sso.mapping_conflict", {
        providerId,
        teamId,
        userId,
        reason: "last_team_admin",
      }),
    ).toBe(true);
    expect(ok("identity.sso.link.created", { providerId, userId, method: "local_proof" })).toBe(
      true,
    );
    expect(ok("identity.sso.link.created", { providerId, userId, method: "email" })).toBe(false);
    // Never a claim value, subject or email in the log.
    expect(
      ok("identity.sso.link.created", { providerId, userId, method: "jit", subject: "x" }),
    ).toBe(false);
    expect(ok("identity.scim.token.created", { providerId, credentialId })).toBe(true);
    expect(ok("identity.scim.user.deactivated", { providerId, userId, credentialId })).toBe(true);
    expect(ok("identity.scim.deactivation_refused", { providerId, userId, credentialId })).toBe(
      true,
    );
    expect(ok("identity.scim.reactivation_refused", { providerId, userId, credentialId })).toBe(
      true,
    );
    // Memberships the mappings manage reuse the published team events, with `via: "idp"`.
    expect(ok("identity.member.added", { userId, role: "member", via: "idp", providerId })).toBe(
      true,
    );
    expect(ok("identity.member.removed", { userId, role: "member", via: "idp", providerId })).toBe(
      true,
    );
    expect(
      ok("identity.member.role_changed", {
        userId,
        from: "member",
        to: "team_admin",
        via: "idp",
        providerId,
      }),
    ).toBe(true);
    expect(ok("identity.member.taken_over", { userId, providerId })).toBe(true);
    // KOBE-638: a Site admin's changes from the Site console.
    expect(ok("identity.member.added", { userId, role: "member", via: "site_admin" })).toBe(true);
    expect(ok("identity.member.removed", { userId, role: "member", via: "site_admin" })).toBe(true);
    expect(
      ok("identity.member.role_changed", {
        userId,
        from: "member",
        to: "contributor",
        via: "site_admin",
      }),
    ).toBe(true);
    expect(ok("identity.member.taken_over", { userId, providerId, via: "site_admin" })).toBe(true);
    expect(ok("identity.member.added", { userId, role: "member", via: "site_console" })).toBe(
      false,
    );
    expect(AUDIT_EVENTS["identity.member.taken_over"].scope).toBe("team");
  });

  it("records semantic memory actions by ids, scopes, kinds and counts only (KOBE-377, SM28)", () => {
    const ok = (action: string, target: unknown) =>
      (AUDIT_EVENTS as Record<string, { target: z.ZodType }>)[action]?.target.safeParse(target)
        .success ?? false;
    const itemId = "11111111-1111-4111-8111-111111111111";
    expect(
      [
        "memory.item.created",
        "memory.item.updated",
        "memory.item.reverted",
        "memory.item.archived",
        "memory.item.restored",
        "memory.item.pinned",
        "memory.item.unpinned",
        "memory.item.superseded",
        "memory.items.imported",
        "memory.items.exported",
        "memory.policy.set",
        "memory.policy.override",
        "memory.lint.override",
        "memory.steward.granted",
        "memory.steward.revoked",
      ].filter((a) => !isAuditAction(a)),
    ).toEqual([]);
    expect(
      ok("memory.item.created", {
        scope: "team",
        itemId,
        kind: "fact",
        version: 1,
        actorKind: "user",
        pinned: false,
        policy: false,
      }),
    ).toBe(true);
    // Created as Policy or pinned is recorded on `created` itself (review M5).
    expect(
      ok("memory.item.created", {
        scope: "site",
        itemId,
        kind: "convention",
        version: 1,
        actorKind: "user",
        pinned: false,
        policy: true,
      }),
    ).toBe(true);
    expect(
      ok("memory.item.created", {
        scope: "site",
        itemId,
        kind: "fact",
        version: 1,
        actorKind: "user",
      }),
    ).toBe(false);
    // Never the statement.
    expect(
      ok("memory.item.created", {
        scope: "team",
        itemId,
        kind: "fact",
        version: 1,
        actorKind: "user",
        statement: "x",
      }),
    ).toBe(false);
    expect(
      ok("memory.item.created", {
        scope: "project",
        itemId,
        kind: "fact",
        version: 1,
        actorKind: "user",
      }),
    ).toBe(false);
    expect(
      ok("memory.item.updated", {
        scope: "portable",
        itemId,
        version: 3,
        previousVersion: 2,
        changed: ["statement", "tags"],
      }),
    ).toBe(true);
    expect(
      ok("memory.lint.override", { scope: "user", itemId, version: 1, warnings: ["instruction"] }),
    ).toBe(true);
    expect(ok("memory.policy.override", { scope: "team", itemId, version: 1, conflicts: 2 })).toBe(
      true,
    );
    expect(ok("memory.policy.set", { itemId, version: 1, policy: true })).toBe(true);
    expect(
      ok("memory.items.exported", {
        scope: "site",
        format: "csv",
        count: 3,
        includeInactive: false,
      }),
    ).toBe(true);
    expect(AUDIT_EVENTS["memory.item.created"].scope).toBe("any");
    expect(AUDIT_EVENTS["memory.policy.set"].scope).toBe("site");
    expect(AUDIT_EVENTS["memory.steward.granted"].scope).toBe("team");
  });

  it("is documented: docs/audit-log.md lists every action", () => {
    const doc = readFileSync(new URL("../../../../docs/audit-log.md", import.meta.url), "utf8");
    expect(AUDIT_ACTIONS.filter((a) => !doc.includes(`\`${a}\``))).toEqual([]);
  });
});
