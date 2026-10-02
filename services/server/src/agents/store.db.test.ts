import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createDb, users, type KobeDatabase } from "@kobe/db";
import {
  createAgent,
  deleteAgent,
  findAgent,
  listAgents,
  setAgentStatus,
  updateAgent,
  type AgentLocation,
} from "./store.js";

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

beforeAll(async () => {
  db = createDb(inject("appUrl"));
  await db.db.insert(users).values([
    { id: alice, name: "Alice", email: `${alice}@store.test` },
    { id: bob, name: "Bob", email: `${bob}@store.test` },
  ]);
  const created = await createAgent(
    db.db,
    { scope: "personal", ownerUserId: alice },
    { definition, baseSlug: "private", ownerUserId: alice },
  );
  if (!created.ok) throw new Error(created.error);
  aliceAgent = created.value.id;
});

afterAll(() => db.close());

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

  it("deleteAgent", async () => {
    expect(await deleteAgent(db.db, asBob, aliceAgent)).toBe(false);
  });

  it("createAgent owns the row by the location, never by the input", async () => {
    const created = await createAgent(db.db, asBob, {
      definition,
      baseSlug: "private",
      ownerUserId: alice,
    });
    expect(created.ok && created.value.ownerUserId).toBe(bob);
  });

  it("leaves Alice's agent untouched", async () => {
    const mine = await findAgent(db.db, { scope: "personal", ownerUserId: alice }, aliceAgent);
    expect(mine).toMatchObject({ prompt: "Alice only.", status: "active", revision: 1 });
  });

  it("refuses a personal location without a valid owner", async () => {
    const bad = { scope: "personal", ownerUserId: "" } as AgentLocation;
    await expect(listAgents(db.db, bad)).rejects.toThrow(/personal agents need an owner/);
    await expect(findAgent(db.db, bad, aliceAgent)).rejects.toThrow(
      /personal agents need an owner/,
    );
    await expect(deleteAgent(db.db, bad, aliceAgent)).rejects.toThrow(
      /personal agents need an owner/,
    );
  });
});
