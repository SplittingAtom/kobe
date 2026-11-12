import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "./migrate.js";
import {
  createTestDatabase,
  migrationsBefore,
  testServerUrl,
  type TestDatabase,
} from "./test-support/database.js";

/**
 * KOBE-625 (spec docs/specs/sso-oidc-scim.md §4–§10, SSO-1): the single sign-on and SCIM tables as
 * an upgrade runs them (the owner role) over a populated database at the previous migration
 * (teams, users, a session, memberships including a Kobe-managed one). The new tables start empty;
 * existing rows survive; the checks hold; the app role gets exactly the registry's grants
 * (`scim_tokens`: no DELETE, UPDATE only on `last_used_at`/`revoked_at`); `team_members.added_via`
 * now also takes `idp:<uuid>`.
 */
const MARKER = 'CREATE TABLE "sso_providers"';

let db: TestDatabase | undefined;
let older = "";
const teamId = randomUUID();
const userId = randomUUID();
const otherUser = randomUUID();
const sessionId = randomUUID();
const TENANT = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";
const SEALED = "e1.k1.c2VhbGVk.bm9uY2U.dGFn";
const SHA = "ab".repeat(32);

async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

const database = (): TestDatabase => {
  if (!db) throw new Error("database not created");
  return db;
};
const asApp = <T>(fn: (c: pg.Client) => Promise<T>) => withClient(database().appUrl, fn);
const asAdmin = <T>(fn: (c: pg.Client) => Promise<T>) => withClient(database().adminUrl, fn);

/** The SQLSTATE a statement fails with (undefined when it succeeds). */
async function code(
  c: pg.Client,
  sql: string,
  params: unknown[] = [],
): Promise<string | undefined> {
  try {
    await c.query(sql, params);
    return undefined;
  } catch (err) {
    return (err as { code?: string }).code;
  }
}

/** Inserts a console-managed Entra provider; returns its id. */
async function provider(c: pg.Client, slug: string, extra: Record<string, unknown> = {}) {
  const row = {
    slug,
    display_name: "Contoso",
    kind: "entra",
    issuer: `https://login.microsoftonline.com/${TENANT}/v2.0`,
    client_id: "11111111-2222-4333-8444-555555555555",
    client_secret_sealed: SEALED,
    client_secret_key_id: "k1",
    tenant_id: TENANT,
    subject_claim: "oid",
    access_claim: "roles",
    ...extra,
  };
  const cols = Object.keys(row);
  const { rows } = await c.query<{ id: string }>(
    `INSERT INTO sso_providers (${cols.join(", ")})
     VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING id`,
    Object.values(row),
  );
  const [first] = rows;
  if (!first) throw new Error("no row returned");
  return first.id;
}

const SSO_TABLES = [
  "sso_providers",
  "sso_identities",
  "sso_access_mappings",
  "session_sso_contexts",
  "scim_tokens",
  "scim_groups",
  "scim_group_members",
];

beforeAll(async () => {
  older = migrationsBefore(MARKER);
  db = await createTestDatabase(testServerUrl(), { migrationsFolder: older });
  await asAdmin(async (c) => {
    await c.query(`INSERT INTO teams (id, slug, name) VALUES ($1, 'research', 'Research')`, [
      teamId,
    ]);
    await c.query(`INSERT INTO users (id, name, email) VALUES ($1, 'Ann', $2), ($3, 'Bob', $4)`, [
      userId,
      `${userId}@upgrade.test`,
      otherUser,
      `${otherUser}@upgrade.test`,
    ]);
    await c.query(
      `INSERT INTO team_members (team_id, user_id, role, added_via)
       VALUES ($1, $2, 'team_admin', NULL), ($1, $3, 'member', 'skill_reviewer_grant')`,
      [teamId, userId, otherUser],
    );
    await c.query(
      `INSERT INTO sessions (id, user_id, token, expires_at) VALUES ($1, $2, 'tok', now() + interval '1 day')`,
      [sessionId, userId],
    );
  });
  const { ownerUrl, appRole } = database();
  await runMigrations({ databaseUrl: ownerUrl, appRole });
}, 180_000);

afterAll(async () => {
  await db?.drop();
  if (older) rmSync(older, { recursive: true, force: true });
});

describe("SSO and SCIM tables on upgrade (KOBE-625)", () => {
  it("adds the seven tables empty and keeps existing rows", async () => {
    await asAdmin(async (c) => {
      for (const t of SSO_TABLES) {
        const { rows } = await c.query(`SELECT count(*)::int AS n FROM ${t}`);
        expect(rows, t).toEqual([{ n: 0 }]);
      }
      const { rows } = await c.query(
        `SELECT user_id, added_via FROM team_members WHERE team_id = $1 ORDER BY role`,
        [teamId],
      );
      expect(rows).toHaveLength(2);
      const { rows: s } = await c.query(`SELECT count(*)::int AS n FROM sessions`);
      expect(s).toEqual([{ n: 1 }]);
    });
  });

  it("keeps every new table site-wide: no RLS, no team_id except the mappings", async () => {
    await asAdmin(async (c) => {
      const { rows } = await c.query<{ name: string; rls: boolean; team: boolean }>(
        `SELECT c.relname AS name, c.relrowsecurity AS rls,
                EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid
                         AND a.attname = 'team_id' AND NOT a.attisdropped) AS team
           FROM pg_class c WHERE c.relname = ANY($1) ORDER BY c.relname`,
        [SSO_TABLES],
      );
      expect(rows.filter((r) => r.rls)).toEqual([]);
      expect(rows.filter((r) => r.team).map((r) => r.name)).toEqual(["sso_access_mappings"]);
    });
  });

  it("holds the provider checks (slug, kind, tenant, sealed secret, Helm secrets stay out)", async () => {
    await asApp(async (c) => {
      const id = await provider(c, "contoso");
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
      const { rows } = await c.query(
        `SELECT enabled, jit_provisioning, managed_by, mfa_rule, allowed_email_domains
           FROM sso_providers WHERE id = $1`,
        [id],
      );
      expect(rows[0]).toMatchObject({
        enabled: false,
        jit_provisioning: true,
        managed_by: "console",
        allowed_email_domains: [],
      });
      expect(rows[0].mfa_rule).toMatchObject({ amr_any: expect.any(Array), acrs_any: [] });

      expect(await code(c, "INSERT INTO sso_providers (slug) VALUES ('x')")).toBe("23502");
    });
    // Each bad row in its own statement (autocommit), so one failure does not hide another.
    await asApp(async (c) => {
      const cases: Array<[Record<string, unknown>, string]> = [
        [{ slug: "Bad Slug" }, "23514"],
        [{ slug: "-lead" }, "23514"],
        [{ kind: "saml" }, "23514"],
        [{ tenant_id: null }, "23514"],
        [{ issuer: "http://login.microsoftonline.com/x/v2.0" }, "23514"],
        [{ subject_claim: "email" }, "23514"],
        [{ access_claim: "scopes" }, "23514"],
        [{ client_secret_sealed: "plaintext-secret" }, "23514"],
        // A console provider keeps its secret sealed in the row ...
        [{ client_secret_sealed: null, client_secret_key_id: null }, "23514"],
        [{ client_secret_key_id: null }, "23514"],
        // ... a Helm one never copies it into the database.
        [{ managed_by: "helm" }, "23514"],
        [{ display_name: "" }, "23514"],
        [{ max_session_hours: 0 }, "23514"],
        [{ mfa_rule: JSON.stringify(["mfa"]) }, "23514"],
        [{ slug: "contoso" }, "23505"],
      ];
      for (const [extra, expected] of cases) {
        let got: string | undefined;
        try {
          await provider(
            c,
            (extra.slug as string | undefined) ?? `p-${randomUUID().slice(0, 8)}`,
            extra,
          );
        } catch (err) {
          got = (err as { code?: string }).code;
        }
        expect(got, JSON.stringify(extra)).toBe(expected);
      }
      // A Helm-managed provider and a generic OIDC provider without a tenant are fine.
      await provider(c, "helm-idp", {
        managed_by: "helm",
        client_secret_sealed: null,
        client_secret_key_id: null,
      });
      await provider(c, "keycloak", {
        kind: "oidc",
        tenant_id: null,
        issuer: "https://idp.example.test/realms/kobe",
        subject_claim: "sub",
        access_claim: "groups",
      });
    });
  });

  it("keys identities on (provider, subject), one per user and provider; links block deletion", async () => {
    await asApp(async (c) => {
      const p = await provider(c, "ident");
      const insert = (subject: string, user: string, via = "jit") =>
        code(
          c,
          `INSERT INTO sso_identities (provider_id, subject, user_id, linked_via) VALUES ($1, $2, $3, $4)`,
          [p, subject, user, via],
        );
      expect(await insert("oid-1", userId)).toBeUndefined();
      expect(await insert("oid-1", otherUser)).toBe("23505");
      expect(await insert("oid-2", userId)).toBe("23505");
      expect(await insert("oid-3", otherUser, "email")).toBe("23514");
      expect(await insert("", otherUser)).toBe("23514");
      // Delete a provider only when no identity is linked (spec §4); otherwise disable it.
      expect(await code(c, `DELETE FROM sso_providers WHERE id = $1`, [p])).toBe("23503");
      expect(
        await code(c, `DELETE FROM sso_identities WHERE provider_id = $1`, [p]),
      ).toBeUndefined();
      expect(await code(c, `DELETE FROM sso_providers WHERE id = $1`, [p])).toBeUndefined();
    });
  });

  it("maps claim values to a team role, once per (provider, value, team); cascades with the provider", async () => {
    await asApp(async (c) => {
      const p = await provider(c, "maps");
      const insert = (value: string, role: string) =>
        code(
          c,
          `INSERT INTO sso_access_mappings (provider_id, claim_value, team_id, role) VALUES ($1, $2, $3, $4)`,
          [p, value, teamId, role],
        );
      expect(await insert("kobe.research.member", "member")).toBeUndefined();
      expect(await insert("kobe.research.admin", "team_admin")).toBeUndefined();
      expect(await insert("kobe.research.member", "contributor")).toBe("23505");
      // Team roles only (SSO6): no site role can be named.
      expect(await insert("kobe.owner", "owner")).toBe("22P02");
      expect(await insert("", "member")).toBe("23514");
      expect(
        await code(
          c,
          `INSERT INTO sso_access_mappings (provider_id, claim_value, team_id, role) VALUES ($1, 'x', $2, 'member')`,
          [p, randomUUID()],
        ),
      ).toBe("23503");
      await c.query(`DELETE FROM sso_providers WHERE id = $1`, [p]);
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM sso_access_mappings WHERE provider_id = $1`,
        [p],
      );
      expect(rows).toEqual([{ n: 0 }]);
    });
  });

  it("records the SSO context of a session and drops it with the session", async () => {
    await asApp(async (c) => {
      const p = await provider(c, "ctx");
      await c.query(
        `INSERT INTO session_sso_contexts (session_id, provider_id, mfa_satisfied, amr, acr)
         VALUES ($1, $2, true, '{mfa,pwd}', 'c1')`,
        [sessionId, p],
      );
      // A provider with live SSO sessions can't be deleted until they are ended (spec §9).
      expect(await code(c, `DELETE FROM sso_providers WHERE id = $1`, [p])).toBe("23503");
      await c.query(`DELETE FROM sessions WHERE id = $1`, [sessionId]);
      const { rows } = await c.query(`SELECT count(*)::int AS n FROM session_sso_contexts`);
      expect(rows).toEqual([{ n: 0 }]);
    });
  });

  it("stores SCIM tokens as hashes only; the app role can't delete them or rewrite the hash", async () => {
    await asApp(async (c) => {
      const p = await provider(c, "scim");
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO scim_tokens (provider_id, token_hash, prefix) VALUES ($1, $2, 'kobe_scim_Ab12')
         RETURNING id`,
        [p, SHA],
      );
      const tokenId = rows[0]?.id ?? "";
      expect(tokenId).not.toBe("");
      expect(
        await code(
          c,
          `INSERT INTO scim_tokens (provider_id, token_hash, prefix) VALUES ($1, 'kobe_scim_plaintext', 'kobe_scim_x')`,
          [p],
        ),
      ).toBe("23514");
      expect(
        await code(
          c,
          `INSERT INTO scim_tokens (provider_id, token_hash, prefix) VALUES ($1, $2, 'kobe_scim_y')`,
          [p, SHA],
        ),
      ).toBe("23505");
      expect(await code(c, `DELETE FROM scim_tokens WHERE id = $1`, [tokenId])).toBe("42501");
      expect(
        await code(c, `UPDATE scim_tokens SET token_hash = $2 WHERE id = $1`, [
          tokenId,
          "cd".repeat(32),
        ]),
      ).toBe("42501");
      expect(
        await code(c, `UPDATE scim_tokens SET provider_id = provider_id WHERE id = $1`, [tokenId]),
      ).toBe("42501");
      expect(
        await code(c, `UPDATE scim_tokens SET last_used_at = now() WHERE id = $1`, [tokenId]),
      ).toBeUndefined();
      expect(
        await code(c, `UPDATE scim_tokens SET revoked_at = now() WHERE id = $1`, [tokenId]),
      ).toBeUndefined();
      // Revocation is final: a revoked token never works again.
      expect(
        await code(c, `UPDATE scim_tokens SET revoked_at = NULL WHERE id = $1`, [tokenId]),
      ).toBe("P0001");
      expect(
        await code(
          c,
          `UPDATE scim_tokens SET revoked_at = now() + interval '1 day' WHERE id = $1`,
          [tokenId],
        ),
      ).toBe("P0001");
    });
  });

  it("keeps SCIM groups per provider and their members per group", async () => {
    await asApp(async (c) => {
      const p = await provider(c, "groups");
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO scim_groups (provider_id, external_id, display_name) VALUES ($1, 'g-1', 'Research')
         RETURNING id`,
        [p],
      );
      const groupId = rows[0]?.id ?? "";
      expect(groupId).not.toBe("");
      expect(
        await code(
          c,
          `INSERT INTO scim_groups (provider_id, external_id, display_name) VALUES ($1, 'g-1', 'Again')`,
          [p],
        ),
      ).toBe("23505");
      const member = (user: string) =>
        code(c, `INSERT INTO scim_group_members (group_id, user_id) VALUES ($1, $2)`, [
          groupId,
          user,
        ]);
      expect(await member(userId)).toBeUndefined();
      expect(await member(userId)).toBe("23505");
      await c.query(`DELETE FROM scim_groups WHERE id = $1`, [groupId]);
      const { rows: left } = await c.query(`SELECT count(*)::int AS n FROM scim_group_members`);
      expect(left).toEqual([{ n: 0 }]);
    });
  });

  it("lets team_members carry idp:<provider uuid> (and nothing else new)", async () => {
    await asAdmin(async (c) => {
      const via = `idp:${randomUUID()}`;
      expect(
        await code(c, `UPDATE team_members SET added_via = $2 WHERE user_id = $1`, [
          otherUser,
          via,
        ]),
      ).toBeUndefined();
      for (const bad of ["idp:", "idp:not-a-uuid", `idp:${randomUUID().toUpperCase()}`, "scim"]) {
        expect(
          await code(c, `UPDATE team_members SET added_via = $2 WHERE user_id = $1`, [
            otherUser,
            bad,
          ]),
          bad,
        ).toBe("23514");
      }
      expect(
        await code(
          c,
          `UPDATE team_members SET added_via = 'skill_reviewer_grant' WHERE user_id = $1`,
          [otherUser],
        ),
      ).toBeUndefined();
    });
  });
});
