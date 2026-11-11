import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, inject, it } from "vitest";
import {
  AUDIT_VIA_AGENT_KEY,
  AuditEventError,
  audit,
  verifyAuditChain,
  type AuditEvent,
  type AuditVia,
} from "./audit/index.js";
import { createDb } from "./client.js";
import { readKobeMcpMode, seedKobeBuiltinConnector } from "./connectors/builtin.js";
import {
  KOBE_BUILTIN_CONNECTOR_ID,
  KOBE_BUILTIN_CONNECTOR_URL,
  KOBE_MCP_MODE_KEY,
  connectors,
  siteSettings,
  teams,
} from "./schema/index.js";
import { withTeam } from "./with-team.js";

/** KOBE-618 (KA-1): the built-in `kobe` connector row, the site switch, and audit `via`. */
const app = createDb(inject("appUrl"), { max: 8 });
afterAll(() => app.close());

const pgCode = (err: unknown) => (err as { cause?: { code?: string } }).cause?.code;

describe("the built-in kobe connector row", () => {
  it("is seeded once however many replicas seed it at the same time", async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => seedKobeBuiltinConnector(app.db)),
    );
    const rows = await app.db.select().from(connectors).where(eq(connectors.builtin, "kobe"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: KOBE_BUILTIN_CONNECTOR_ID,
      url: KOBE_BUILTIN_CONNECTOR_URL,
      authKind: "none",
      credentialSource: "member",
      toolsSnapshot: [],
      toolsHash: null,
    });
    expect(results.filter((r) => r.outcome === "seeded").length).toBeLessThanOrEqual(1);
    expect(results.every((r) => r.outcome !== "names_taken")).toBe(true);
    // A later start finds it.
    expect(await seedKobeBuiltinConnector(app.db)).toEqual({
      outcome: "present",
      name: rows[0]?.name,
    });
  });

  it("refuses a registered connector carrying the internal URL", async () => {
    await expect(
      app.db
        .insert(connectors)
        .values({ name: `fake-${randomUUID().slice(0, 8)}`, url: KOBE_BUILTIN_CONNECTOR_URL }),
    ).rejects.toSatisfy((e) => pgCode(e) === "23514");
  });

  it("refuses a built-in row with another id, URL, credential or a pinned snapshot", async () => {
    const name = () => `b-${randomUUID().slice(0, 8)}`;
    const bad = [
      { id: randomUUID(), url: KOBE_BUILTIN_CONNECTOR_URL },
      { id: KOBE_BUILTIN_CONNECTOR_ID, url: "https://mcp.example.com/mcp" },
      {
        id: KOBE_BUILTIN_CONNECTOR_ID,
        url: KOBE_BUILTIN_CONNECTOR_URL,
        authKind: "api_key" as const,
      },
      { id: KOBE_BUILTIN_CONNECTOR_ID, url: KOBE_BUILTIN_CONNECTOR_URL, toolsHash: "a".repeat(64) },
    ];
    for (const values of bad) {
      // A distinct transaction per attempt: the unique id may conflict before the check.
      const code = await app.db
        .insert(connectors)
        .values({ name: name(), builtin: "kobe", ...values })
        .then(() => "inserted")
        .catch((e: unknown) => pgCode(e));
      expect(["23514", "23505"], JSON.stringify(values)).toContain(code);
    }
    await expect(
      app.db.execute(
        sql`UPDATE connectors SET url = 'https://evil.example.com/mcp' WHERE builtin = 'kobe'`,
      ),
    ).rejects.toSatisfy((e) => pgCode(e) === "23514");
  });
});

describe("the site switch kobe_mcp.mode (KA5)", () => {
  it("defaults to docs, reads a known mode, and treats anything else as docs", async () => {
    await app.db.delete(siteSettings).where(eq(siteSettings.key, KOBE_MCP_MODE_KEY));
    expect(await readKobeMcpMode(app.db)).toBe("docs");
    for (const [value, mode] of [
      ["admin", "admin"],
      ["off", "off"],
      ["ADMIN", "docs"],
      ["", "docs"],
    ] as const) {
      await app.db
        .insert(siteSettings)
        .values({ key: KOBE_MCP_MODE_KEY, value })
        .onConflictDoUpdate({ target: siteSettings.key, set: { value } });
      expect(await readKobeMcpMode(app.db)).toBe(mode);
    }
    await app.db.delete(siteSettings).where(eq(siteSettings.key, KOBE_MCP_MODE_KEY));
  });
});

describe("audit via agent (spec §7)", () => {
  const teamId = randomUUID();
  const person = randomUUID();
  const via = {
    kind: "agent" as const,
    threadId: randomUUID(),
    runId: randomUUID(),
    toolCallId: "call_01:abc",
  };
  const roleChanged = (extra: Partial<AuditEvent> = {}): AuditEvent =>
    ({
      action: "identity.member.role_changed",
      actor: { kind: "user", id: person },
      teamId,
      target: { userId: randomUUID(), from: "member", to: "team_admin" },
      ...extra,
    }) as AuditEvent;

  it("records the person with via on any action, and the chain verifies", async () => {
    const owner = createDb(inject("ownerUrl"));
    await owner.db
      .insert(teams)
      .values({ id: teamId, slug: `via-${teamId.slice(0, 8)}`, name: "Via" });
    await owner.close();
    const ref = await withTeam(app.db, teamId, (tx) => audit(tx, roleChanged({ via })));
    const res = await app.db.execute<{ actor_id: string; target: Record<string, unknown> }>(
      sql`SELECT actor_id, target FROM audit_log WHERE seq = ${ref.seq}`,
    );
    expect(res.rows[0]?.actor_id).toBe(person);
    expect(res.rows[0]?.target[AUDIT_VIA_AGENT_KEY]).toEqual({
      threadId: via.threadId,
      runId: via.runId,
      toolCallId: via.toolCallId,
    });
    // A site-level action takes it too.
    await app.db.transaction((tx) =>
      audit(tx, { action: "auth.sign_out", actor: { kind: "user", id: person }, target: {}, via }),
    );
    const report = await verifyAuditChain(app.db);
    expect(report.ok).toBe(true);
  });

  it("refuses via from a non-person, malformed via, and via smuggled in the target", async () => {
    const attempts: AuditEvent[] = [
      roleChanged({ via, actor: { kind: "agent", id: randomUUID() } }),
      roleChanged({ via: { ...via, toolCallId: "bad id with spaces" } }),
      roleChanged({ via: { ...via, threadId: "not-a-uuid" } }),
      roleChanged({ via: { ...via, kind: "user" } as unknown as AuditVia }),
      {
        ...roleChanged(),
        target: {
          userId: randomUUID(),
          from: "member",
          to: "team_admin",
          [AUDIT_VIA_AGENT_KEY]: { runId: randomUUID() },
        },
      } as unknown as AuditEvent,
    ];
    for (const event of attempts) {
      await expect(withTeam(app.db, teamId, (tx) => audit(tx, event))).rejects.toBeInstanceOf(
        AuditEventError,
      );
    }
  });
});
