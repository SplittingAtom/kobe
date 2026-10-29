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
      "thread",
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
    for (const setting of ["logo", "logo_dark", "favicon"])
      expect(target.safeParse({ setting, value: sha }).success).toBe(true);
    expect(target.safeParse({ setting: "css", value: "x" }).success).toBe(false);
    expect(target.safeParse({ setting: "app_name", value: "" }).success).toBe(false);
    expect(target.safeParse({ setting: "app_name", value: "a\nb" }).success).toBe(false);
    expect(target.safeParse({ setting: "logo", value: sha, bytes: "x" }).success).toBe(false);
  });

  it("is documented: docs/audit-log.md lists every action", () => {
    const doc = readFileSync(new URL("../../../../docs/audit-log.md", import.meta.url), "utf8");
    expect(AUDIT_ACTIONS.filter((a) => !doc.includes(`\`${a}\``))).toEqual([]);
  });
});
