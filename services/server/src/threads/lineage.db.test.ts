import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  LINEAGE_MAX_DEPTH,
  LINEAGE_MAX_SIBLINGS,
  threadLineageResponseSchema,
  type ThreadLineageResponse,
} from "@kobe/protocol";
import { withTeam, type KobeTx } from "@kobe/db";
import { RunFixture } from "../testing/run-fixture.js";
import type { Person } from "../testing/event-stream-fixture.js";
import { readLineage } from "./lineage.js";

/**
 * KOBE-533 (TL1, TL2): `GET /v1/threads/{id}/lineage`. Families are seeded with the superuser
 * (a fork's link is set at INSERT, KOBE-215) so activity order and Trash are exact; every read
 * goes through the route as the member, and the answer must parse with the protocol schema.
 */
const f = new RunFixture();

beforeAll(async () => {
  await f.setup();
});
afterAll(async () => {
  await f.teardown();
});

const MINUTE = 60_000;

interface Seed {
  title?: string | null;
  forkOf?: string;
  /** Minutes ago of the last activity: smaller is newer. */
  ago?: number;
  deleted?: boolean;
  shared?: boolean;
  isTest?: boolean;
  skillTest?: boolean;
  skillEval?: boolean;
}

async function thread(team: string, owner: Person, s: Seed = {}): Promise<string> {
  const id = randomUUID();
  await f.fx.admin.query(
    `INSERT INTO threads (team_id, id, owner_user_id, title, forked_from_thread_id,
       forked_at_entry_id, last_activity_at, deleted_at, shared_to_team, is_test, skill_test,
       skill_eval)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      team,
      id,
      owner.id,
      s.title === undefined ? `t-${id.slice(0, 4)}` : s.title,
      s.forkOf ?? null,
      s.forkOf ? "e1" : null,
      new Date(Date.now() - (s.ago ?? 0) * MINUTE),
      s.deleted ? new Date(Date.now() - 1000 * MINUTE) : null,
      s.shared ?? false,
      s.isTest ?? false,
      s.skillTest ?? false,
      s.skillEval ?? false,
    ],
  );
  return id;
}

async function lineage(p: Person, id: string) {
  const res = await f.on(0, p).get(`/v1/threads/${id}/lineage`);
  return res;
}

async function read(p: Person, id: string): Promise<ThreadLineageResponse> {
  const res = await lineage(p, id);
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  return threadLineageResponseSchema.parse(res.json);
}

const ids = (list: readonly { thread_id: string }[]) => list.map((t) => t.thread_id);

describe("a family (ac-1)", () => {
  it("answers root-first ancestors with siblings, self with its fork point, and forks", async () => {
    const w = await f.world();
    const other = await f.member(w.team);
    const me = w.owner;
    const root = await thread(w.team, me, { title: "Budget 2027", ago: 50 });
    const a = await thread(w.team, me, { forkOf: root, ago: 40 });
    const b = await thread(w.team, me, { forkOf: root, ago: 30, title: null });
    const c = await thread(w.team, me, { forkOf: b, ago: 20 });
    const d = await thread(w.team, me, { forkOf: c, ago: 10 });
    const shared = await thread(w.team, other, { forkOf: c, ago: 5, shared: true });
    await thread(w.team, other, { forkOf: c, ago: 1 }); // private to `other`

    const body = await read(me, c);
    expect(body.thread_id).toBe(c);
    expect(body.root_hidden).toBe(false);
    expect(ids(body.ancestors)).toEqual([root, b]);
    expect(body.ancestors[0]).toMatchObject({ title: "Budget 2027", deleted_at: null });
    expect(body.ancestors[0]?.siblings).toEqual([]);
    expect(body.ancestors[1]?.title).toBeNull();
    expect(ids(body.ancestors[1]?.siblings ?? [])).toEqual([b, a]);
    expect(body.self).toMatchObject({ thread_id: c, forked_at_entry_id: "e1" });
    expect(ids(body.self.siblings)).toEqual([c]);
    expect(body.forks.map((x) => [x.thread_id, x.owner])).toEqual([
      [shared, "other"],
      [d, "me"],
    ]);
    expect(body.forks_more).toBe(false);

    const top = await read(me, root);
    expect(top.ancestors).toEqual([]);
    expect(top.self).toMatchObject({ forked_at_entry_id: null, siblings: [] });
    expect(ids(top.forks)).toEqual([b, a]);
  });
});

describe("hidden and purged ancestors (ac-2)", () => {
  it("stops at an unreadable ancestor with root_hidden and reveals nothing about it", async () => {
    const w = await f.world();
    const other = await f.member(w.team);
    const secret = await thread(w.team, other, { title: "Secret plans" });
    const x = await thread(w.team, w.owner, { forkOf: secret, ago: 10 });
    const x2 = await thread(w.team, w.owner, { forkOf: secret, ago: 5 });
    const y = await thread(w.team, w.owner, { forkOf: x });

    const body = await read(w.owner, y);
    expect(body.root_hidden).toBe(true);
    expect(ids(body.ancestors)).toEqual([x]);
    expect(body.ancestors[0]?.siblings).toEqual([]);
    const text = JSON.stringify(body);
    expect(text).not.toContain(secret);
    expect(text).not.toContain("Secret plans");
    expect(text).not.toContain(x2); // a sibling under the hidden parent would hint at it

    const self = await read(w.owner, x);
    expect(self).toMatchObject({ root_hidden: true, ancestors: [] });
    expect(self.self.siblings).toEqual([]);
    expect(JSON.stringify(self)).not.toContain(secret);
  });

  it("leaves the chain shorter with no flag when an ancestor was purged", async () => {
    const w = await f.world();
    const root = await thread(w.team, w.owner);
    const mid = await thread(w.team, w.owner, { forkOf: root });
    const leaf = await thread(w.team, w.owner, { forkOf: mid });
    await f.fx.admin.query(`DELETE FROM threads WHERE team_id = $1 AND id = $2`, [w.team, root]);

    const body = await read(w.owner, leaf);
    expect(body.root_hidden).toBe(false);
    expect(ids(body.ancestors)).toEqual([mid]);
    expect(body.ancestors[0]?.siblings).toEqual([]);
    expect(body.self.forked_at_entry_id).toBe("e1");
  });
});

describe("readers, strangers and unlisted threads (ac-3)", () => {
  it("gives a D23 reader only what they may read", async () => {
    const w = await f.world();
    const reader = await f.member(w.team);
    const root = await thread(w.team, w.owner, { title: "Private root" });
    const a = await thread(w.team, w.owner, { forkOf: root, shared: true, ago: 10 });
    const hiddenFork = await thread(w.team, w.owner, { forkOf: a, ago: 5 });
    const b = await thread(w.team, w.owner, { forkOf: a, shared: true, ago: 1 });

    const body = await read(reader, a);
    expect(body.root_hidden).toBe(true);
    expect(body.ancestors).toEqual([]);
    expect(body.forks.map((x) => [x.thread_id, x.owner])).toEqual([[b, "other"]]);
    const text = JSON.stringify(body);
    expect(text).not.toContain(root);
    expect(text).not.toContain(hiddenFork);
    expect(text).not.toContain("Private root");

    const mine = await read(w.owner, a);
    expect(ids(mine.forks)).toEqual([b, hiddenFork]);
  });

  it("answers 404 thread_not_found to a stranger and to a member who may not read it", async () => {
    const w = await f.world();
    const member = await f.member(w.team);
    const elsewhere = await f.world();
    const t = await thread(w.team, w.owner);
    for (const p of [member, elsewhere.owner]) {
      const res = await lineage(p, t);
      expect(res.status).toBe(404);
      expect(res.json.code).toBe("thread_not_found");
    }
    const unknown = await lineage(w.owner, randomUUID());
    expect(unknown.status).toBe(404);
  });

  it("never lists builder test, Workbench or eval threads", async () => {
    const w = await f.world();
    const root = await thread(w.team, w.owner);
    const ok = await thread(w.team, w.owner, { forkOf: root });
    await thread(w.team, w.owner, { forkOf: root, isTest: true });
    await thread(w.team, w.owner, { forkOf: root, skillTest: true });
    await thread(w.team, w.owner, { forkOf: root, skillEval: true });
    const body = await read(w.owner, root);
    expect(ids(body.forks)).toEqual([ok]);
    expect(ids((await read(w.owner, ok)).self.siblings)).toEqual([ok]);
  });
});

describe("Trash (ac-4)", () => {
  it("lists the owner's trashed threads with deleted_at, never another member's", async () => {
    const w = await f.world();
    const reader = await f.member(w.team);
    const root = await thread(w.team, w.owner, { shared: true, deleted: true });
    const live = await thread(w.team, w.owner, { forkOf: root, shared: true, ago: 10 });
    const trashed = await thread(w.team, w.owner, {
      forkOf: live,
      shared: true,
      deleted: true,
      ago: 1,
    });
    const kept = await thread(w.team, w.owner, { forkOf: live, shared: true, ago: 5 });

    const mine = await read(w.owner, live);
    expect(ids(mine.ancestors)).toEqual([root]);
    expect(mine.ancestors[0]?.deleted_at).toEqual(expect.any(String));
    expect(ids(mine.forks)).toEqual([trashed, kept]);
    expect(mine.forks[0]?.deleted_at).toEqual(expect.any(String));
    expect(mine.forks[1]?.deleted_at).toBeNull();

    const theirs = await read(reader, live);
    expect(theirs.root_hidden).toBe(true);
    expect(theirs.ancestors).toEqual([]);
    expect(ids(theirs.forks)).toEqual([kept]);
    expect(JSON.stringify(theirs)).not.toContain(trashed);
  });
});

/**
 * A transaction that counts the statements it runs: a query builder counts when it is awaited
 * (a builder only used as a subquery never is), `execute` when called.
 */
function counting(tx: KobeTx): { tx: KobeTx; count: () => number } {
  let n = 0;
  const builder = (v: unknown): v is object => typeof v === "object" && v !== null;
  const track = <T extends object>(obj: T, root: boolean): T =>
    new Proxy(obj, {
      get(target, key, receiver) {
        const value: unknown = Reflect.get(target, key, receiver);
        if (typeof value !== "function") return value;
        const fn = value as (...args: unknown[]) => unknown;
        return (...args: unknown[]) => {
          if (key === "then" || (root && key === "execute")) n += 1;
          const out = fn.apply(target, args);
          return builder(out) && key !== "then" ? track(out, false) : out;
        };
      },
    });
  return { tx: track(tx, true), count: () => n };
}

describe("caps and cost (ac-5)", () => {
  it("climbs at most LINEAGE_MAX_DEPTH generations", async () => {
    const w = await f.world();
    const chain = [await thread(w.team, w.owner)];
    for (let i = 0; i < LINEAGE_MAX_DEPTH + 2; i += 1) {
      chain.push(await thread(w.team, w.owner, { forkOf: chain[chain.length - 1] as string }));
    }
    const last = chain[chain.length - 1] as string;
    const body = await read(w.owner, last);
    expect(body.ancestors).toHaveLength(LINEAGE_MAX_DEPTH);
    expect(ids(body.ancestors)).toEqual(chain.slice(-LINEAGE_MAX_DEPTH - 1, -1));
    expect(body.root_hidden).toBe(false);
  });

  it("cuts sibling and fork lists at LINEAGE_MAX_SIBLINGS with the more flag", async () => {
    const w = await f.world();
    const root = await thread(w.team, w.owner);
    const forks: string[] = [];
    for (let i = 0; i < LINEAGE_MAX_SIBLINGS + 5; i += 1) {
      forks.push(await thread(w.team, w.owner, { forkOf: root, ago: i + 1 }));
    }
    const top = await read(w.owner, root);
    expect(ids(top.forks)).toEqual(forks.slice(0, LINEAGE_MAX_SIBLINGS));
    expect(top.forks_more).toBe(true);

    // The oldest fork is past the cut, yet its own siblings still include it (last, oldest).
    const oldest = forks[forks.length - 1] as string;
    const body = await read(w.owner, oldest);
    expect(body.self.siblings).toHaveLength(LINEAGE_MAX_SIBLINGS);
    expect(body.self.siblings_more).toBe(true);
    expect(body.self.siblings.at(-1)?.thread_id).toBe(oldest);
    expect(ids(body.self.siblings).slice(0, -1)).toEqual(forks.slice(0, LINEAGE_MAX_SIBLINGS - 1));

    const newest = await read(w.owner, forks[0] as string);
    expect(newest.self.siblings_more).toBe(true);
    expect(newest.self.siblings[0]?.thread_id).toBe(forks[0]);
  });

  it("reads in one transaction: the thread, one query per generation, one forks query", async () => {
    const w = await f.world();
    const other = await f.member(w.team);
    const root = await thread(w.team, w.owner);
    const a = await thread(w.team, w.owner, { forkOf: root });
    const b = await thread(w.team, w.owner, { forkOf: a });
    await thread(w.team, w.owner, { forkOf: b });
    const viewer = { teamId: w.team, userId: w.owner.id, projectIds: [] };

    const plain = await withTeam(f.fx.db, w.team, async (tx) => {
      const c = counting(tx);
      const body = await readLineage(c.tx, viewer, b);
      return { body, count: c.count() };
    });
    expect(ids(plain.body?.ancestors ?? [])).toEqual([root, a]);
    expect(plain.count).toBe(2 + 2);

    // A hidden parent costs its one (empty) walk step.
    const secret = await thread(w.team, other);
    const x = await thread(w.team, w.owner, { forkOf: secret });
    const hidden = await withTeam(f.fx.db, w.team, async (tx) => {
      const c = counting(tx);
      const body = await readLineage(c.tx, viewer, x);
      return { body, count: c.count() };
    });
    expect(hidden.body?.root_hidden).toBe(true);
    expect(hidden.count).toBe(2 + 1);
  });
});
