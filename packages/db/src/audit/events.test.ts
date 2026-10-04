import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AUDIT_ACTIONS, AUDIT_CATEGORIES, AUDIT_EVENTS } from "./events.js";

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
      "install",
      "models",
      "mcp",
      "platform",
      "policy",
      "run",
      "sandbox",
      "thread",
      "workspace",
    ]);
  });

  it("is documented: docs/audit-log.md lists every action", () => {
    const doc = readFileSync(new URL("../../../../docs/audit-log.md", import.meta.url), "utf8");
    expect(AUDIT_ACTIONS.filter((a) => !doc.includes(`\`${a}\``))).toEqual([]);
  });
});
