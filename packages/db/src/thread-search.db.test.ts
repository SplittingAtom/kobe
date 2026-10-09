import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createDb, type KobeDatabase, type KobeTx } from "./client.js";
import { projects, teamMembers, teams, threadEntries, threads, users } from "./schema/index.js";
import {
  searchThreads,
  ThreadSearchError,
  type SearchThreadsInput,
  type ThreadSearchHit,
  type ThreadSearchPage,
} from "./thread-search.js";
import { withTeam } from "./with-team.js";

/**
 * Thread search (KOBE-33): full-text over message text and titles, trigram on titles, scoped to the
 * active team (RLS) and to the threads the viewer may read (own threads, threads shared to the
 * viewer's projects), never Trash. Runs as the app role through withTeam, like the server.
 */
const teamA = randomUUID();
const teamB = randomUUID();
let app: KobeDatabase;
let owner: KobeDatabase;

beforeAll(async () => {
  owner = createDb(inject("ownerUrl"));
  await owner.db.insert(teams).values([
    { id: teamA, slug: `sa-${teamA.slice(0, 8)}`, name: "Search A" },
    { id: teamB, slug: `sb-${teamB.slice(0, 8)}`, name: "Search B" },
  ]);
  app = createDb(inject("appUrl"));
});

afterAll(async () => {
  await app.close();
  await owner.close();
});

/** A user who is a member of each given team. */
async function newUser(...memberOf: string[]): Promise<string> {
  const id = randomUUID();
  await owner.db.insert(users).values({ id, name: "Searcher", email: `${id}@search.test` });
  for (const teamId of memberOf) {
    await withTeam(app.db, teamId, (tx) =>
      tx.insert(teamMembers).values({ teamId, userId: id, role: "member" }),
    );
  }
  return id;
}

interface ThreadSpec {
  readonly ownerUserId: string;
  readonly title?: string | null;
  readonly projectId?: string;
  readonly sharedToProject?: boolean;
  readonly deleted?: boolean;
  readonly lastActivityAt?: Date;
  /** Pi entries: `type` and payload (a Pi session v3 entry body). */
  readonly entries?: readonly { type: string; payload: Record<string, unknown> }[];
}

const userMsg = (content: unknown) => ({
  type: "message",
  payload: { message: { role: "user", content, timestamp: 1 } },
});
const assistantMsg = (...blocks: unknown[]) => ({
  type: "message",
  payload: { message: { role: "assistant", content: blocks, timestamp: 2 } },
});
const text = (t: string) => ({ type: "text", text: t });

async function newThread(teamId: string, spec: ThreadSpec): Promise<string> {
  return withTeam(app.db, teamId, async (tx) => {
    // threads.project_id references projects (KOBE-160): make sure the named project exists.
    if (spec.projectId !== undefined) {
      await tx
        .insert(projects)
        .values({
          teamId,
          id: spec.projectId,
          slug: `p-${spec.projectId.slice(0, 8)}`,
          name: "P",
          createdBy: spec.ownerUserId,
        })
        .onConflictDoNothing();
    }
    const [row] = await tx
      .insert(threads)
      .values({
        teamId,
        ownerUserId: spec.ownerUserId,
        title: spec.title ?? null,
        projectId: spec.projectId ?? null,
        sharedToProject: spec.sharedToProject ?? false,
        deletedAt: spec.deleted ? new Date() : null,
        lastActivityAt: spec.lastActivityAt ?? new Date(),
      })
      .returning({ id: threads.id });
    if (!row) throw new Error("thread insert returned nothing");
    let parentId: string | null = null;
    for (const entry of spec.entries ?? []) {
      const entryId = randomUUID().slice(0, 8);
      await tx.insert(threadEntries).values({
        teamId,
        threadId: row.id,
        entryId,
        parentId,
        type: entry.type,
        payload: entry.payload,
      });
      parentId = entryId;
    }
    return row.id;
  });
}

function search(teamId: string, input: SearchThreadsInput): Promise<ThreadSearchPage> {
  return withTeam(app.db, teamId, (tx) => searchThreads(tx, input));
}

async function ids(teamId: string, input: SearchThreadsInput): Promise<string[]> {
  return (await search(teamId, input)).hits.map((h) => h.threadId);
}

const snippetText = (hit: ThreadSearchHit | undefined): string =>
  (hit?.snippet ?? []).map((s) => s.text).join("");
const highlighted = (hit: ThreadSearchHit | undefined): string[] =>
  (hit?.snippet ?? []).filter((s) => s.highlight).map((s) => s.text);

describe("matching (ac-1)", () => {
  it("finds a thread by user and assistant message text, with the matching entry and a snippet", async () => {
    const me = await newUser(teamA);
    const thread = await newThread(teamA, {
      ownerUserId: me,
      title: "Untitled",
      entries: [
        userMsg("Please summarise the quarterly zanzibar revenue"),
        assistantMsg(text("Here is the summary of the marmalade forecast.")),
      ],
    });
    const byUser = await search(teamA, { viewerUserId: me, query: "zanzibar" });
    expect(byUser.hits.map((h) => h.threadId)).toEqual([thread]);
    expect(byUser.hits[0]?.matchedEntryId).toMatch(/^[0-9a-f]{8}$/);
    expect(highlighted(byUser.hits[0])).toEqual(["zanzibar"]);
    expect(snippetText(byUser.hits[0])).toContain("quarterly zanzibar revenue");

    const byAssistant = await search(teamA, { viewerUserId: me, query: "marmalade" });
    expect(byAssistant.hits.map((h) => h.threadId)).toEqual([thread]);
    expect(byAssistant.hits[0]?.matchedEntryId).not.toBe(byUser.hits[0]?.matchedEntryId);
  });

  it("stems words and supports web search syntax (phrases, exclusion, or)", async () => {
    const me = await newUser(teamA);
    const charts = await newThread(teamA, {
      ownerUserId: me,
      entries: [userMsg([text("draw the pelican charts for march")])],
    });
    const other = await newThread(teamA, {
      ownerUserId: me,
      entries: [userMsg("a pelican drawing without the graph")],
    });
    expect(await ids(teamA, { viewerUserId: me, query: "pelican chart" })).toEqual([charts]);
    expect(await ids(teamA, { viewerUserId: me, query: '"pelican charts"' })).toEqual([charts]);
    expect(await ids(teamA, { viewerUserId: me, query: "pelican -charts" })).toEqual([other]);
    expect((await ids(teamA, { viewerUserId: me, query: "charts or graph" })).sort()).toEqual(
      [charts, other].sort(),
    );
  });

  it("matches titles by full text and by trigram (partial words, typos), ranking title hits first", async () => {
    const me = await newUser(teamA);
    const titled = await newThread(teamA, {
      ownerUserId: me,
      title: "Kubernetes upgrade checklist",
      entries: [userMsg("nothing relevant here")],
    });
    const bodyOnly = await newThread(teamA, {
      ownerUserId: me,
      title: "Misc",
      entries: [userMsg("we talked about the kubernetes upgrade yesterday")],
    });
    expect(await ids(teamA, { viewerUserId: me, query: "kubernetes upgrade" })).toEqual([
      titled,
      bodyOnly,
    ]);
    const prefix = await search(teamA, { viewerUserId: me, query: "kuberne" });
    expect(prefix.hits.map((h) => h.threadId)).toEqual([titled]);
    expect(prefix.hits[0]?.matchedEntryId).toBeNull();
    expect(prefix.hits[0]?.snippet).toBeNull();
    expect(await ids(teamA, { viewerUserId: me, query: "kubernetse" })).toEqual([titled]);
  });

  it("indexes only user and assistant text, not tool calls, tool results, thinking, or other entries", async () => {
    const me = await newUser(teamA);
    await newThread(teamA, {
      ownerUserId: me,
      entries: [
        {
          type: "message",
          payload: { message: { role: "system", content: "quokkasystem", sections: {} } },
        },
        assistantMsg(
          { type: "thinking", thinking: "quokkathink" },
          { type: "toolCall", id: "t1", name: "bash", arguments: { cmd: "quokkacall" } },
        ),
        {
          type: "message",
          payload: {
            message: { role: "toolResult", toolCallId: "t1", content: [text("quokkaresult")] },
          },
        },
        { type: "compaction", payload: { summary: "quokkasummary", firstKeptEntryId: "x" } },
        { type: "custom_message", payload: { customType: "k", content: "quokkacustom" } },
        { type: "session_info", payload: { name: "quokkaname" } },
      ],
    });
    for (const word of [
      "quokkasystem",
      "quokkathink",
      "quokkacall",
      "quokkaresult",
      "quokkasummary",
      "quokkacustom",
      "quokkaname",
    ]) {
      expect(await ids(teamA, { viewerUserId: me, query: word }), word).toEqual([]);
    }
  });

  it("keeps the index current when a title or an entry payload changes", async () => {
    const me = await newUser(teamA);
    const thread = await newThread(teamA, {
      ownerUserId: me,
      title: "first title",
      entries: [userMsg("original wombat text")],
    });
    await withTeam(app.db, teamA, async (tx) => {
      await tx.update(threads).set({ title: "renamed narwhal" }).where(eq(threads.id, thread));
      await tx
        .update(threadEntries)
        .set({ payload: userMsg("edited capybara text").payload })
        .where(eq(threadEntries.threadId, thread));
    });
    expect(await ids(teamA, { viewerUserId: me, query: "narwhal" })).toEqual([thread]);
    expect(await ids(teamA, { viewerUserId: me, query: "capybara" })).toEqual([thread]);
    expect(await ids(teamA, { viewerUserId: me, query: "wombat" })).toEqual([]);
  });

  it("accepts very large message text without failing the append (indexes a bounded prefix)", async () => {
    const me = await newUser(teamA);
    const words = Array.from({ length: 120_000 }, (_, i) => `w${i.toString(36)}`).join(" ");
    const thread = await newThread(teamA, {
      ownerUserId: me,
      entries: [userMsg(`ocelot ${words}`)],
    });
    expect(await ids(teamA, { viewerUserId: me, query: "ocelot" })).toEqual([thread]);
  });

  it("applies exclusions and phrases to the title trigram path too (review 2)", async () => {
    const me = await newUser(teamA);
    await newThread(teamA, { ownerUserId: me, title: "qwerty asdfgh" });
    const kept = await newThread(teamA, { ownerUserId: me, title: "qwerty notes" });
    const draft = await newThread(teamA, { ownerUserId: me, title: "qwerty old draft" });
    expect((await ids(teamA, { viewerUserId: me, query: "qwerty -asdfgh" })).sort()).toEqual(
      [kept, draft].sort(),
    );
    const excluded = await ids(teamA, { viewerUserId: me, query: 'qwert -asdfgh -"old draft"' });
    expect(excluded).toEqual([kept]);
    // A quoted phrase is trigram-matched on its words, without the quotes.
    expect((await ids(teamA, { viewerUserId: me, query: '"qwerty notes"' }))[0]).toBe(kept);
  });

  it("matches terms within one message, not across messages (per-entry co-occurrence)", async () => {
    const me = await newUser(teamA);
    const together = await newThread(teamA, {
      ownerUserId: me,
      entries: [userMsg("mongoose and meerkat")],
    });
    await newThread(teamA, {
      ownerUserId: me,
      entries: [userMsg("mongoose only"), assistantMsg(text("meerkat only"))],
    });
    expect(await ids(teamA, { viewerUserId: me, query: "mongoose meerkat" })).toEqual([together]);
  });

  it("returns nothing for a query of only stop words", async () => {
    const me = await newUser(teamA);
    await newThread(teamA, { ownerUserId: me, entries: [userMsg("the and of")] });
    expect(await ids(teamA, { viewerUserId: me, query: "the and" })).toEqual([]);
  });
});

describe("snippets are plain text (ac-4)", () => {
  it("returns segments, never markup, and strips the highlight sentinels from content", async () => {
    const me = await newUser(teamA);
    await newThread(teamA, {
      ownerUserId: me,
      entries: [userMsg("<script>alert(1)</script> \uE000tapir\uE001 x < y <b>bold</b> tapir")],
    });
    const [hit] = (await search(teamA, { viewerUserId: me, query: "tapir" })).hits;
    // ts_headline drops HTML tag tokens; highlights are segments, not <b> markup.
    expect(snippetText(hit)).toContain("tapir x < y");
    expect(snippetText(hit)).not.toMatch(/<script|<b>|[\uE000\uE001]/);
    expect(highlighted(hit)).toEqual(["tapir", "tapir"]);
  });
});

describe("visibility (ac-2)", () => {
  it("never returns another user's private threads", async () => {
    const me = await newUser(teamA);
    const colleague = await newUser(teamA);
    await newThread(teamA, { ownerUserId: colleague, entries: [userMsg("secret axolotl plan")] });
    await newThread(teamA, {
      ownerUserId: colleague,
      projectId: randomUUID(),
      sharedToProject: false,
      entries: [userMsg("secret axolotl project plan")],
    });
    expect(await ids(teamA, { viewerUserId: me, query: "axolotl" })).toEqual([]);
    expect(await ids(teamA, { viewerUserId: colleague, query: "axolotl" })).toHaveLength(2);
  });

  it("returns threads shared to the viewer's projects, and filters by project", async () => {
    const me = await newUser(teamA);
    const colleague = await newUser(teamA);
    const mine = randomUUID();
    const notMine = randomUUID();
    const shared = await newThread(teamA, {
      ownerUserId: colleague,
      projectId: mine,
      sharedToProject: true,
      entries: [userMsg("shared gecko notes")],
    });
    await newThread(teamA, {
      ownerUserId: colleague,
      projectId: notMine,
      sharedToProject: true,
      entries: [userMsg("other project gecko notes")],
    });
    const own = await newThread(teamA, { ownerUserId: me, entries: [userMsg("my gecko notes")] });

    expect(await ids(teamA, { viewerUserId: me, query: "gecko" })).toEqual([own]);
    expect(
      (await ids(teamA, { viewerUserId: me, query: "gecko", projectIds: [mine] })).sort(),
    ).toEqual([own, shared].sort());
    expect(
      await ids(teamA, { viewerUserId: me, query: "gecko", projectIds: [mine], projectId: mine }),
    ).toEqual([shared]);
    expect(
      await ids(teamA, {
        viewerUserId: me,
        query: "gecko",
        projectIds: [mine],
        projectId: notMine,
      }),
    ).toEqual([]);
  });

  it("excludes threads in Trash", async () => {
    const me = await newUser(teamA);
    await newThread(teamA, { ownerUserId: me, deleted: true, entries: [userMsg("binned lemur")] });
    expect(await ids(teamA, { viewerUserId: me, query: "lemur" })).toEqual([]);
  });

  it("excludes threads inactive since before activeSince (team retention)", async () => {
    const me = await newUser(teamA);
    const old = new Date(Date.now() - 100 * 86_400_000);
    await newThread(teamA, {
      ownerUserId: me,
      lastActivityAt: old,
      entries: [userMsg("old ibis")],
    });
    const recent = await newThread(teamA, { ownerUserId: me, entries: [userMsg("new ibis")] });
    const since = new Date(Date.now() - 90 * 86_400_000);
    expect(await ids(teamA, { viewerUserId: me, query: "ibis", activeSince: since })).toEqual([
      recent,
    ]);
  });

  it("returns nothing to a viewer who is not a member of the active team", async () => {
    const formerMember = await newUser();
    await newThread(teamA, { ownerUserId: formerMember, entries: [userMsg("orphan okapi")] });
    expect(await ids(teamA, { viewerUserId: formerMember, query: "okapi" })).toEqual([]);
  });
});

describe("team isolation (ac-3)", () => {
  it("never finds another team's threads, even the viewer's own threads there", async () => {
    const me = await newUser(teamA, teamB);
    const inA = await newThread(teamA, { ownerUserId: me, entries: [userMsg("alpaca in A")] });
    const inB = await newThread(teamB, {
      ownerUserId: me,
      title: "alpaca",
      entries: [userMsg("alpaca in B")],
    });
    expect(await ids(teamA, { viewerUserId: me, query: "alpaca" })).toEqual([inA]);
    expect(await ids(teamB, { viewerUserId: me, query: "alpaca" })).toEqual([inB]);
  });

  it("refuses to run outside withTeam", async () => {
    const me = await newUser(teamA);
    await expect(
      app.db.transaction((tx: KobeTx) => searchThreads(tx, { viewerUserId: me, query: "x" })),
    ).rejects.toThrow(/withTeam/);
  });
});

describe("ranking and pagination (ac-4)", () => {
  it("pages through every hit exactly once in score order", async () => {
    const me = await newUser(teamA);
    const created: string[] = [];
    for (let i = 0; i < 7; i++) {
      created.push(
        await newThread(teamA, {
          ownerUserId: me,
          // Equal scores for some threads exercise the (last_activity_at, id) tiebreak.
          entries: [userMsg(i % 2 === 0 ? "toucan" : "toucan toucan toucan feathers")],
        }),
      );
    }
    const seen: ThreadSearchHit[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const result = await search(teamA, { viewerUserId: me, query: "toucan", limit: 3, cursor });
      expect(result.hits.length).toBeLessThanOrEqual(3);
      seen.push(...result.hits);
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }
    expect(seen.map((h) => h.threadId).sort()).toEqual([...created].sort());
    const keys = seen.map((h) => [h.score, h.lastActivityAt.getTime()] as const);
    const sorted = [...keys].sort((a, b) => b[0] - a[0] || b[1] - a[1]);
    expect(keys).toEqual(sorted);
  });

  it("returns thread metadata with each hit", async () => {
    const me = await newUser(teamA);
    const thread = await newThread(teamA, {
      ownerUserId: me,
      title: "Heron notes",
      entries: [userMsg("heron")],
    });
    const [hit] = (await search(teamA, { viewerUserId: me, query: "heron" })).hits;
    const row = await withTeam(app.db, teamA, (tx) =>
      tx
        .select()
        .from(threads)
        .where(and(eq(threads.teamId, teamA), eq(threads.id, thread))),
    );
    expect(hit).toMatchObject({
      threadId: thread,
      title: "Heron notes",
      ownerUserId: me,
      projectId: null,
      status: "idle",
      sharedToProject: false,
      agentId: null,
      agentVersion: null,
      lastActivityAt: row[0]?.lastActivityAt,
      createdAt: row[0]?.createdAt,
      leafEntryId: row[0]?.leafEntryId,
    });
    expect(hit?.score).toBeGreaterThan(0);
  });
});

describe("input validation (ac-5)", () => {
  it.each([
    ["an empty query", { query: "   " }],
    ["an overlong query", { query: "x".repeat(257) }],
    ["a bad viewer id", { viewerUserId: "nope" }],
    ["a bad project id", { projectIds: ["nope"] }],
    ["a limit over 50", { limit: 51 }],
    ["a tampered cursor", { cursor: "eyJzIjoiMSJ9" }],
    [
      "a cursor outside the bigint range",
      {
        cursor: Buffer.from(
          JSON.stringify({ s: 1, a: "99999999999999999999", i: randomUUID() }),
        ).toString("base64url"),
      },
    ],
    ["a negation-only query", { query: '-alpha -"beta gamma"' }],
  ])("rejects %s with a typed error and no database round trip", async (label, override) => {
    const me = await newUser(teamA);
    const err = await search(teamA, {
      viewerUserId: me,
      query: "valid",
      ...override,
    } as SearchThreadsInput).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ThreadSearchError);
    expect(err).toMatchObject({ code: /cursor/.test(label) ? "invalid_cursor" : "invalid_input" });
    expect((err as Error).message).toMatch(/^searchThreads: /);
  });
});

describe("statement timeout (review 3)", () => {
  it("maps a timeout to a typed error without SQL or parameters, and keeps the caller's transaction usable", async () => {
    const me = await newUser(teamA);
    await newThread(teamA, { ownerUserId: me, entries: [userMsg("blocked puffin")] });
    // An ACCESS EXCLUSIVE lock held elsewhere makes the search wait until its statement timeout.
    const locker = await owner.pool.connect();
    try {
      await locker.query("BEGIN");
      await locker.query("LOCK TABLE thread_entries IN ACCESS EXCLUSIVE MODE");
      const outcome = await withTeam(app.db, teamA, async (tx) => {
        const err = await searchThreads(tx, {
          viewerUserId: me,
          query: "puffin",
          timeoutMs: 200,
        }).then(
          () => undefined,
          (e: unknown) => e,
        );
        // The search ran in a savepoint: the caller's transaction and its settings survive.
        const after = await tx.execute<{ team: string; timeout: string }>(
          sql`SELECT current_setting('kobe.team_id') AS team, current_setting('statement_timeout') AS timeout`,
        );
        return { err, after: after.rows[0] };
      });
      expect(outcome.err).toBeInstanceOf(ThreadSearchError);
      expect(outcome.err).toMatchObject({ code: "timeout" });
      const message = (outcome.err as Error).message;
      expect(message).not.toMatch(/select|websearch|puffin|Failed query/i);
      expect(outcome.after).toEqual({ team: teamA, timeout: "0" });
    } finally {
      await locker.query("ROLLBACK");
      locker.release();
    }
    expect(await ids(teamA, { viewerUserId: me, query: "puffin" })).toHaveLength(1);
  });
});

describe("schema", () => {
  it("adds threads.tsv and thread_entries.tsv as stored generated columns", async () => {
    const result = await owner.db.execute<{ table_name: string; is_generated: string }>(
      sql`SELECT table_name, is_generated FROM information_schema.columns
          WHERE table_schema = 'public' AND column_name = 'tsv' ORDER BY table_name`,
    );
    expect(result.rows).toEqual([
      { table_name: "thread_entries", is_generated: "ALWAYS" },
      { table_name: "threads", is_generated: "ALWAYS" },
    ]);
  });
});
