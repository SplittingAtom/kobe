import { randomBytes } from "node:crypto";
import pg from "pg";
import { expect } from "vitest";
import type { KobeEvent } from "@kobe/protocol";
import { runs, sql, teamMembers, threads, withTeam } from "@kobe/db";
import { createTestDatabase, testServerUrl, type TestDatabase } from "@kobe/db/testing";
import { createApp } from "../app.js";
import { createServerDeps, type ServerDeps, type ServerDepsOptions } from "../deps.js";
import { runWithAuditContext } from "../audit/context.js";
import { appendRunEventsInTx, type NewRunEvent } from "../event-stream/append.js";
import { createTeamWithAdmin } from "../teams/members.js";
import { waitForAppSessionsToClose } from "./app-sessions.js";
import { TestBrowser } from "./browser.js";
import { MemoryMailer } from "./mailer.js";
import { SseReader } from "./sse.js";

export const PUBLIC_URL = "http://kobe.test";
const PASSWORD = "a long enough password";

export interface Replica {
  readonly deps: ServerDeps;
  readonly app: ReturnType<typeof createApp>;
}

export interface Person {
  readonly id: string;
  readonly email: string;
  /** Signed in on replica 0; the session cookie works on every replica (same database). */
  readonly browser: TestBrowser;
}

export type ReplicaTuning = NonNullable<ServerDepsOptions["eventStream"]>;

/**
 * Several server "replicas" (independent deps + app, each with its own LISTEN connection and
 * pool) on one throwaway database, plus helpers to create people, teams, threads and runs.
 */
export class EventStreamFixture {
  database!: TestDatabase;
  admin!: pg.Client;
  replicas: Replica[] = [];

  async setup(tunings: readonly ReplicaTuning[]): Promise<void> {
    this.database = await createTestDatabase(testServerUrl());
    this.admin = new pg.Client({ connectionString: this.database.adminUrl });
    await this.admin.connect();
    this.replicas = tunings.map((eventStream) => {
      const deps = createServerDeps({
        databaseUrl: this.database.appUrl,
        publicUrl: PUBLIC_URL,
        authSecret: "e".repeat(48),
        setupToken: "setup-token-for-event-stream-tests",
        trustedProxies: ["127.0.0.1/32"],
        mailer: new MemoryMailer(),
        eventStream,
      });
      return { deps, app: createApp(deps) };
    });
  }

  get db() {
    return this.replica(0).deps.database.db;
  }

  replica(i: number): Replica {
    const r = this.replicas[i];
    if (!r) throw new Error(`no replica ${i}`);
    return r;
  }

  async person(name: string): Promise<Person> {
    const email = `${name}-${randomBytes(3).toString("hex")}@events.test`;
    const { id } = await this.replica(0).deps.createUserWithPassword({
      email,
      name,
      password: PASSWORD,
    });
    const browser = new TestBrowser(this.replica(0).app, PUBLIC_URL);
    const res = await browser.post("/api/auth/sign-in/email", { email, password: PASSWORD });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    return { id, email, browser };
  }

  async team(slug: string, admin: Person, members: readonly Person[] = []): Promise<string> {
    // Store call outside a request: name the actor its audit event records (KOBE-15).
    const team = await runWithAuditContext(
      { actor: { kind: "user", id: admin.id }, ip: null, userAgent: null },
      () => createTeamWithAdmin(this.db, { slug, name: slug }, admin.id),
    );
    for (const m of members) await this.addMember(team.id, m);
    for (const p of [admin, ...members]) await this.activate(p, team.id);
    return team.id;
  }

  /** Seeds a membership directly (test setup; people normally join through KOBE-13 invites). */
  async addMember(teamId: string, p: Person): Promise<void> {
    await withTeam(this.db, teamId, (tx) =>
      tx.insert(teamMembers).values({ teamId, userId: p.id, role: "member" }),
    );
  }

  async activate(p: Person, teamId: string): Promise<void> {
    const res = await p.browser.put("/v1/me/teams/active", { teamId });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    p.browser.team = teamId;
  }

  /** A thread owned by `owner` with one running run. */
  async run(teamId: string, owner: Person): Promise<string> {
    return withTeam(this.db, teamId, async (tx) => {
      const [thread] = await tx
        .insert(threads)
        .values({ teamId, ownerUserId: owner.id, status: "running" })
        .returning({ id: threads.id });
      const [run] = await tx
        .insert(runs)
        .values({
          teamId,
          threadId: must(thread, "thread").id,
          trigger: "user",
          status: "running",
          startedAt: new Date(),
        })
        .returning({ id: runs.id });
      return must(run, "run").id;
    });
  }

  /** Ends a run the way the orchestrator must: terminal status and terminal event in one transaction. */
  async complete(teamId: string, runId: string): Promise<KobeEvent[]> {
    return withTeam(this.db, teamId, async (tx) => {
      await tx.execute(
        sql`UPDATE runs SET status = 'completed', ended_at = now() WHERE team_id = ${teamId} AND id = ${runId}`,
      );
      return appendRunEventsInTx(tx, teamId, runId, [
        { type: "run.completed", payload: { leaf_entry_id: null } },
      ]);
    });
  }

  /** GET /v1/runs/{id}/events on a replica as `p`; returns the raw streaming response. */
  async open(
    replica: number,
    p: Person,
    runId: string,
    opts: { lastEventId?: string; startingAfter?: string } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = {
      cookie: [...p.browser.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
      "x-forwarded-for": p.browser.ip,
      accept: "text/event-stream",
    };
    if (p.browser.team) headers["x-kobe-team"] = p.browser.team;
    if (opts.lastEventId !== undefined) headers["last-event-id"] = opts.lastEventId;
    const q = opts.startingAfter !== undefined ? `?starting_after=${opts.startingAfter}` : "";
    return this.replica(replica).app.request(`${PUBLIC_URL}/v1/runs/${runId}/events${q}`, {
      headers,
    });
  }

  async stream(replica: number, p: Person, runId: string, lastEventId?: number) {
    const res = await this.open(
      replica,
      p,
      runId,
      lastEventId === undefined ? {} : { lastEventId: String(lastEventId) },
    );
    expect(res.status).toBe(200);
    return new SseReader(res.body);
  }

  async seqsInDb(teamId: string, runId: string): Promise<number[]> {
    const { rows } = await this.admin.query<{ seq: number }>(
      `SELECT seq FROM run_events WHERE team_id = $1 AND run_id = $2 ORDER BY seq`,
      [teamId, runId],
    );
    return rows.map((r) => r.seq);
  }

  async teardown(): Promise<void> {
    for (const r of this.replicas) await r.deps.close();
    await this.admin?.end();
    if (this.database) {
      await waitForAppSessionsToClose(this.database.appRole);
      await this.database.drop();
    }
  }
}

export function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`missing ${what}`);
  return value;
}

export const delta = (text: string, message_id = "m1"): NewRunEvent => ({
  type: "text.delta",
  payload: { message_id, content_index: 0, delta: text },
});

export const range = (from: number, to: number): number[] =>
  Array.from({ length: Math.max(0, to - from + 1) }, (_, i) => from + i);

/**
 * Seeded PRNG (mulberry32) for randomized tests. The seed comes from KOBE_TEST_SEED or the clock and
 * is logged, so a failing interleaving can be replayed with `KOBE_TEST_SEED=<seed>`.
 */
export function seededRandom(label: string): (() => number) & { readonly seed: number } {
  const seed = Number(process.env.KOBE_TEST_SEED ?? Date.now() % 2 ** 31) >>> 0;
  console.info(`[${label}] KOBE_TEST_SEED=${seed}`);
  let a = seed;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return Object.assign(next, { seed });
}
