import { randomUUID } from "node:crypto";
import {
  AUDIT_EVENTS,
  EGRESS_BLOCKED_CHANNEL,
  auditLog,
  createDb,
  egressDomains,
  eq,
  events,
  isActiveTeamMember,
  loadEgressCeiling,
  loadTeamEgress,
  notifyEgressChanged,
  notifyEgressUserChanged,
  sql,
  teamEgress,
  teamMembers,
  teams,
  users,
  withTeam,
  type KobeDatabase,
} from "@kobe/db";
import pg from "pg";
import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { AllowlistCache } from "./allowlist.js";
import { dbBlockedSink } from "./blocked-reporter.js";
import { ChangeListener } from "./change-listener.js";
import { ConnectionAudit, dbAuditWriter } from "./connection-audit.js";
import type { TunnelScope } from "./tunnel-registry.js";

/** KOBE-38: the proxy's Postgres side — allowlists with LISTEN/NOTIFY invalidation, audit, events. */
const logger = pino({ level: "silent" });
const team = randomUUID();
const user = randomUUID();
const sandbox = randomUUID();
let app: KobeDatabase;
let cache: AllowlistCache;
let listener: ChangeListener;
const scopes: TunnelScope[] = [];

const until = async (fn: () => Promise<boolean>, ms = 5_000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("condition not met in time");
};

beforeAll(async () => {
  const owner = createDb(inject("ownerUrl"));
  await owner.db.insert(teams).values({ id: team, slug: `p-${team.slice(0, 8)}`, name: "Proxy" });
  await owner.close();
  app = createDb(inject("appUrl"));
  await app.db.insert(users).values({ id: user, name: "P", email: `${user}@p.test` });
  await withTeam(app.db, team, (tx) =>
    tx.insert(teamMembers).values({ teamId: team, userId: user, role: "team_admin" }),
  );
  cache = new AllowlistCache(
    {
      loadCeiling: () => loadEgressCeiling(app.db),
      loadTeam: (t) => loadTeamEgress(app.db, t),
      isActiveMember: (t, u) => isActiveTeamMember(app.db, t, u),
    },
    // Long TTLs: only change hints can make the cache re-read in these tests.
    { ttlMs: 3_600_000, degradedTtlMs: 3_600_000, memberTtlMs: 3_600_000, maxEntries: 100 },
  );
  listener = new ChangeListener({
    connectionString: inject("appUrl"),
    cache,
    logger,
    onChange: (scope) => void scopes.push(scope),
  });
  listener.start();
  await until(async () => listener.listening);
});
afterAll(async () => {
  await listener.close();
  await app.close();
});

describe("allowlist from Postgres", () => {
  it("fresh install: the team reaches nothing, registries are in the ceiling", async () => {
    expect(await cache.isActiveMember(team, user)).toBe(true);
    expect(await cache.decide(team, "pypi.org")).toEqual({ allowed: false, reason: "not_enabled" });
    expect(await cache.decide(team, "example.org")).toEqual({
      allowed: false,
      reason: "not_in_ceiling",
    });
  });

  it("enabling a domain takes effect through the change hint (no TTL wait)", async () => {
    await withTeam(app.db, team, async (tx) => {
      await tx.insert(teamEgress).values({ teamId: team, domain: "pypi.org", enabledBy: user });
      await notifyEgressChanged(tx, team);
    });
    await until(async () => (await cache.decide(team, "pypi.org")).allowed);
  });

  it("taking a domain out of the ceiling blocks it again for every team", async () => {
    await app.db.transaction(async (tx) => {
      await tx
        .update(egressDomains)
        .set({ inCeiling: false })
        .where(eq(egressDomains.domain, "pypi.org"));
      await notifyEgressChanged(tx, null);
    });
    await until(async () => !(await cache.decide(team, "pypi.org")).allowed);
    expect(await cache.decide(team, "pypi.org")).toEqual({
      allowed: false,
      reason: "not_in_ceiling",
    });
    await app.db
      .update(egressDomains)
      .set({ inCeiling: true })
      .where(eq(egressDomains.domain, "pypi.org"));
  });
});

describe("tunnel re-check hints", () => {
  it("reports the scope of every hint (team, ceiling, user) to re-check open tunnels", async () => {
    scopes.length = 0;
    await withTeam(app.db, team, (tx) => notifyEgressChanged(tx, team));
    await app.db.transaction((tx) => notifyEgressUserChanged(tx, user));
    await until(async () => scopes.length >= 2);
    expect(scopes).toEqual([
      { kind: "team", teamId: team },
      { kind: "user", userId: user },
    ]);
  });
});

describe("records", () => {
  it("writes aggregated egress.connection audit rows (system actor, team scope)", async () => {
    const audit = new ConnectionAudit({ write: dbAuditWriter(app.db), logger, flushMs: 60_000 });
    const record = {
      teamId: team,
      userId: user,
      sandboxId: sandbox,
      domain: "pypi.org",
      port: 443,
      outcome: "allowed" as const,
      reason: undefined,
      bytesUp: 10,
      bytesDown: 20,
    };
    audit.record(record);
    audit.record(record);
    await audit.stop();
    const rows = await app.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "egress.connection"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ teamId: team, actorKind: "system", actorId: null });
    expect(rows[0]?.target).toMatchObject({
      connections: 2,
      bytesUp: 20,
      bytesDown: 40,
      domain: "pypi.org",
    });
    expect(AUDIT_EVENTS["egress.connection"].target.safeParse(rows[0]?.target).success).toBe(true);
  });

  it("records a pending egress.blocked event in the team and notifies with ids only", async () => {
    const hint = new pg.Client({ connectionString: inject("appUrl") });
    await hint.connect();
    const heard: string[] = [];
    hint.on("notification", (n) => heard.push(n.payload ?? ""));
    await hint.query(`LISTEN ${EGRESS_BLOCKED_CHANNEL}`);
    await dbBlockedSink(app.db)({
      teamId: team,
      userId: user,
      sandboxId: sandbox,
      domain: "registry.npmjs.org",
      port: 443,
      reason: "not_enabled",
      requestAccess: true,
      threadHint: undefined,
    });
    await until(async () => heard.length > 0);
    await hint.end();
    const [teamId, eventId] = heard[0]?.split(":") ?? [];
    expect(teamId).toBe(team);
    const rows = await withTeam(app.db, team, (tx) =>
      tx
        .select()
        .from(events)
        .where(sql`${events.id} = ${eventId}::uuid`),
    );
    expect(rows[0]).toMatchObject({
      kind: "egress.blocked",
      status: "pending",
      ref: {
        sandbox_id: sandbox,
        user_id: user,
        domain: "registry.npmjs.org",
        reason: "not_enabled",
        request_access: true,
      },
    });
  });
});
