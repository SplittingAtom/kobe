import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createDb, users, withTeam, teams, type KobeDatabase } from "@kobe/db";
import {
  createAgent,
  findAgent,
  listAgents,
  setAgentStatus,
  updateAgent,
  type AgentLocation,
} from "./store.js";
import {
  deleteOrArchiveAgent,
  findPinnableAgent,
  getVersion,
  listVersions,
  publishAgent,
  resolveAgentPin,
  resolvePinnedAgent,
  rollbackAgent,
  unarchiveAgent,
} from "./versions.js";
import { runWithAuditContext } from "../audit/context.js";

/**
 * install_agents has no RLS backstop (install-wide, D6), so the owner filter in the store is the
 * only wall between users' personal agents. Every store function, given a personal location, must
 * apply it, and must refuse a location without an owner.
 */
let db: KobeDatabase;
const alice = randomUUID();
const bob = randomUUID();
const definition = { frontmatter: { name: "Private" }, prompt: "Alice only." };
let aliceAgent = "";
const asBob: AgentLocation = { scope: "personal", ownerUserId: bob };
const team = randomUUID();

beforeAll(async () => {
  db = createDb(inject("appUrl"));
  await db.db.insert(users).values([
    { id: alice, name: "Alice", email: `${alice}@store.test` },
    { id: bob, name: "Bob", email: `${bob}@store.test` },
  ]);
  const created = await as(alice, () =>
    createAgent(
      db.db,
      { scope: "personal", ownerUserId: alice },
      { definition, baseSlug: "private", ownerUserId: alice },
    ),
  );
  if (!created.ok) throw new Error(created.error);
  aliceAgent = created.value.id;
  const published = await as(alice, () =>
    publishAgent(db.db, { scope: "personal", ownerUserId: alice }, aliceAgent, {
      publishedBy: alice,
      expectedRevision: undefined,
    }),
  );
  if (!published.ok) throw new Error(published.error);
  await db.db.insert(teams).values({ id: team, slug: `st-${team.slice(0, 8)}`, name: "Store" });
});

afterAll(() => db.close());

/** Store writes are audited with the request's actor (KOBE-15). */
const as = <T>(userId: string, fn: () => Promise<T>) =>
  runWithAuditContext({ actor: { kind: "user", id: userId }, ip: null, userAgent: null }, fn);

describe("personal locations apply the owner filter in every store function", () => {
  it("listAgents", async () => {
    expect((await listAgents(db.db, asBob)).map((a) => a.id)).not.toContain(aliceAgent);
  });

  it("findAgent", async () => {
    expect(await findAgent(db.db, asBob, aliceAgent)).toBeNull();
    expect(await findAgent(db.db, { scope: "gallery" }, aliceAgent)).toBeNull();
  });

  it("updateAgent", async () => {
    const result = await updateAgent(db.db, asBob, aliceAgent, {
      frontmatter: { name: "Hijacked" },
      prompt: "",
    });
    expect(result).toEqual({ ok: false, error: "not_found" });
  });

  it("setAgentStatus", async () => {
    expect(await setAgentStatus(db.db, asBob, aliceAgent, "suspended")).toBeNull();
  });

  it("deleteOrArchiveAgent and unarchiveAgent", async () => {
    expect(await as(bob, () => deleteOrArchiveAgent(db.db, asBob, aliceAgent))).toBeNull();
    expect(await as(bob, () => unarchiveAgent(db.db, asBob, aliceAgent))).toBeNull();
  });

  it("publishAgent and rollbackAgent", async () => {
    const input = { publishedBy: bob, expectedRevision: undefined };
    expect(await as(bob, () => publishAgent(db.db, asBob, aliceAgent, input))).toEqual({
      ok: false,
      error: "not_found",
    });
    expect(
      await as(bob, () =>
        rollbackAgent(db.db, asBob, aliceAgent, { publishedBy: bob, fromVersion: 1 }),
      ),
    ).toEqual({ ok: false, error: "not_found" });
  });

  it("listVersions and getVersion", async () => {
    expect(await listVersions(db.db, asBob, aliceAgent, { limit: 10 })).toBeNull();
    expect(await getVersion(db.db, asBob, aliceAgent, 1)).toBeNull();
    expect(await getVersion(db.db, { scope: "gallery" }, aliceAgent, 1)).toBeNull();
  });

  it("thread pins: Bob can neither pin nor resolve Alice's personal agent", async () => {
    const viewer = { teamId: team, userId: bob };
    await withTeam(db.db, team, async (tx) => {
      expect(await findPinnableAgent(tx, viewer, aliceAgent)).toBeNull();
      expect(await resolveAgentPin(tx, viewer, aliceAgent)).toEqual({
        ok: false,
        error: "agent_not_found",
      });
      expect(
        await resolvePinnedAgent(tx, viewer, {
          agentScope: "personal",
          agentId: aliceAgent,
          agentVersion: 1,
        }),
      ).toEqual({ ok: false, error: "agent_not_found" });
      const own = await resolvePinnedAgent(
        tx,
        { teamId: team, userId: alice },
        { agentScope: "personal", agentId: aliceAgent, agentVersion: 1 },
      );
      expect(own.ok).toBe(true);
    });
  });

  it("createAgent owns the row by the location, never by the input", async () => {
    const created = await as(bob, () =>
      createAgent(db.db, asBob, { definition, baseSlug: "private", ownerUserId: alice }),
    );
    expect(created.ok && created.value.ownerUserId).toBe(bob);
  });

  it("leaves Alice's agent untouched", async () => {
    const mine = await findAgent(db.db, { scope: "personal", ownerUserId: alice }, aliceAgent);
    expect(mine).toMatchObject({
      prompt: "Alice only.",
      status: "active",
      revision: 1,
      currentVersion: 1,
      archivedAt: null,
    });
  });

  it("refuses a personal location without a valid owner", async () => {
    const bad = { scope: "personal", ownerUserId: "" } as AgentLocation;
    await expect(listAgents(db.db, bad)).rejects.toThrow(/personal agents need an owner/);
    await expect(findAgent(db.db, bad, aliceAgent)).rejects.toThrow(
      /personal agents need an owner/,
    );
    await expect(deleteOrArchiveAgent(db.db, bad, aliceAgent)).rejects.toThrow(
      /personal agents need an owner/,
    );
    await expect(listVersions(db.db, bad, aliceAgent, { limit: 1 })).rejects.toThrow(
      /personal agents need an owner/,
    );
  });
});
