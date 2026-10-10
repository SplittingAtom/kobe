import { randomBytes, randomUUID } from "node:crypto";
import type { RunAgentResolver } from "../runs/seams.js";
import type { BlobStore } from "../retention/blobs.js";
import { expect } from "vitest";
import type { ServerToSandboxFrame } from "@kobe/protocol";
import { WIRE_DEFAULTS } from "../sandbox-wire/constants.js";
import { TestBrowser, type TestResponse } from "./browser.js";
import { approvalKeyring } from "../approvals/index.js";
import type { StreamTimings } from "../event-stream/stream.js";
import { EventStreamFixture, PUBLIC_URL, must, type Person } from "./event-stream-fixture.js";
import { FakeSandbox, FakeSandboxAuth, isFake, sandboxListener } from "./fake-sandbox.js";

/** Condition waits are bounded below the 30 s test timeout and sized for a loaded 2-CPU CI runner. */
const WAIT_MS = 25_000;

/**
 * Run orchestrator (KOBE-30) test world: two server replicas on one throwaway database, each with
 * a sandbox listener, and scripted sandboxes ("workspaces") that answer like Pi: per-thread session
 * entries, run events with per-run seqs, settle. Requests go over HTTP to either replica.
 */

export type RunStart = Extract<ServerToSandboxFrame, { type: "run.start" }>;

interface Entry {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
  [k: string]: unknown;
}

const entryId = () => randomBytes(4).toString("hex");

const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { total: 0 },
};

/** A Pi `message_update` text delta, as Pi 1.0 sends it. */
export const piDelta = (delta: string) => ({
  type: "message_update",
  usage,
  assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta },
});

/** A sandbox agent with Pi behind it, scripted per test. */
export class FakeWorkspace {
  readonly sessions = new Map<string, Entry[]>();
  readonly #seqs = new Map<string, number>();
  readonly #restoring = new Map<string, Entry[]>();

  constructor(readonly sb: FakeSandbox) {
    sb.respond = (f) => this.#respond(f);
  }

  #respond(f: ServerToSandboxFrame): object | null | undefined {
    if (f.type === "session.restore") {
      // Volume lost: Pi's session is rebuilt from Postgres (D13/D15), written on the final part.
      const parts = [...(this.#restoring.get(f.thread_id) ?? []), ...(f.entries as Entry[])];
      if (f.final) {
        this.sessions.set(f.thread_id, parts);
        this.#restoring.delete(f.thread_id);
      } else {
        this.#restoring.set(f.thread_id, parts);
      }
      return { v: 1, type: "command.result", command_id: f.command_id, ok: true };
    }
    if (f.type !== "pi.command" || f.command.type !== "get_entries") return undefined;
    const session = this.sessions.get(f.thread_id) ?? [];
    const since = f.command.since;
    const at = since === undefined ? -1 : session.findIndex((e) => e.id === since);
    if (since !== undefined && at < 0) {
      return {
        v: 1,
        type: "command.result",
        command_id: f.command_id,
        ok: false,
        error: { code: "pi_rejected", message: "Entry not found" },
      };
    }
    return {
      v: 1,
      type: "command.result",
      command_id: f.command_id,
      ok: true,
      data: { entries: session.slice(at + 1), leafId: session.at(-1)?.id ?? null },
    };
  }

  starts(): RunStart[] {
    return this.sb.frames("run.start");
  }

  async started(runId: string, timeoutMs = WAIT_MS): Promise<RunStart> {
    return this.sb.until(() => this.starts().find((f) => f.run_id === runId), timeoutMs);
  }

  event(start: { run_id: string; thread_id: string }, event: Record<string, unknown>): void {
    const seq = (this.#seqs.get(start.run_id) ?? 0) + 1;
    this.#seqs.set(start.run_id, seq);
    this.sb.event(start.run_id, start.thread_id, seq, event);
  }

  lastSeq(runId: string): number {
    return this.#seqs.get(runId) ?? 0;
  }

  /**
   * Pi answers the prompt: the user entry (on the requested branch), streamed text, the assistant
   * entry, `turn_end` (entries mirrored), and `agent_settled` unless `settle` is false.
   */
  reply(start: RunStart, text: string, settle = true): { user: string; assistant: string } {
    const session = this.sessions.get(start.thread_id) ?? [];
    const now = new Date().toISOString();
    const parent = start.parent_entry_id ?? session.at(-1)?.id ?? null;
    const user: Entry = {
      type: "message",
      id: entryId(),
      parentId: parent,
      timestamp: now,
      message: { role: "user", content: start.message },
    };
    const assistant: Entry = {
      type: "message",
      id: entryId(),
      parentId: user.id,
      timestamp: now,
      message: { role: "assistant", content: [{ type: "text", text }] },
    };
    this.sessions.set(start.thread_id, [...session, user, assistant]);
    this.event(start, { type: "agent_start" });
    this.event(start, { type: "message_start", message: { role: "assistant" } });
    for (const chunk of text.match(/.{1,3}/gs) ?? []) {
      this.event(start, piDelta(chunk));
    }
    this.event(start, { type: "message_end", message: { role: "assistant" } });
    this.event(start, { type: "turn_end", message: { role: "assistant" } });
    if (settle) this.event(start, { type: "agent_settled" });
    return { user: user.id, assistant: assistant.id };
  }

  async acked(runId: string): Promise<void> {
    await this.sb.until(() => this.sb.acked(runId) >= this.lastSeq(runId));
  }

  kill(): void {
    this.sb.close();
  }
}

export interface RunWorld {
  readonly team: string;
  readonly owner: Person;
  readonly target: { teamId: string; userId: string };
}

export class RunFixture {
  readonly fx = new EventStreamFixture();
  readonly auth = new FakeSandboxAuth();
  readonly listeners: Awaited<ReturnType<typeof sandboxListener>>[] = [];
  readonly workspaces: FakeWorkspace[] = [];

  async setup(
    options: {
      readonly startTimeoutMs?: number;
      readonly stopGraceMs?: number;
      /** The run-start agent resolver (KOBE-46/47 seam); default `PINNED_AGENTS`. */
      readonly agents?: RunAgentResolver;
      /** Object storage for skill bundles (KOBE-82): both replicas share it. */
      readonly blobs?: BlobStore;
      /** Event stream timers for both replicas (e.g. a short `revalidateMs` for revocation tests). */
      readonly streamTimings?: Partial<StreamTimings>;
    } = {},
  ): Promise<void> {
    const timings = options.streamTimings === undefined ? {} : { timings: options.streamTimings };
    await this.fx.setup([timings, timings], () => ({
      approvalKeys: approvalKeyring("run-fixture-approval-key-".padEnd(48, "k")),
      ...(options.blobs === undefined ? {} : { blobs: options.blobs }),
      sandboxWire: {
        sweep: false,
        tuning: {
          batchWindowMs: 20,
          resultPollMs: 100,
          lostGraceMs: 0,
          helloTimeoutMs: 2_000,
          commandTimeoutMs: {
            ...WIRE_DEFAULTS.commandTimeoutMs,
            "run.start": options.startTimeoutMs ?? 5_000,
            "run.stop": 5_000,
          },
        },
      },
      runs: {
        sweep: false,
        ...(options.agents === undefined ? {} : { agents: options.agents }),
        tuning: {
          stopGraceMs: options.stopGraceMs ?? 300,
          stallMs: 0,
          startDeadlineMs: 0,
          stopResendMs: 0,
        },
      },
    }));
    for (let i = 0; i < this.fx.replicas.length; i += 1) {
      this.listeners.push(await sandboxListener(this.fx.replica(i).deps, this.auth));
    }
  }

  async teardown(): Promise<void> {
    for (const w of this.workspaces) w.kill();
    for (const r of this.fx.replicas) {
      r.deps.runs.close();
      await r.deps.runs.idle();
    }
    for (const l of this.listeners) await l.close();
    await this.fx.teardown();
  }

  async world(members = 0): Promise<RunWorld & { readonly others: Person[] }> {
    const owner = await this.fx.person(`o${randomBytes(2).toString("hex")}`);
    const others: Person[] = [];
    for (let i = 0; i < members; i += 1) {
      others.push(await this.fx.person(`m${randomBytes(2).toString("hex")}`));
    }
    const team = await this.fx.team(`r-${randomBytes(3).toString("hex")}`, owner, others);
    return { team, owner, others, target: { teamId: team, userId: owner.id } };
  }

  /** A person in a team as a member (signed in, active team set). */
  async member(team: string): Promise<Person> {
    const p = await this.fx.person(`p${randomBytes(2).toString("hex")}`);
    await this.fx.addMember(team, p);
    await this.fx.activate(p, team);
    return p;
  }

  /** The person's browser against another replica (same session cookie and team). */
  on(replica: number, p: Person): TestBrowser {
    const b = new TestBrowser(this.fx.replica(replica).app, PUBLIC_URL);
    for (const [k, v] of p.browser.cookies) b.cookies.set(k, v);
    b.team = p.browser.team;
    return b;
  }

  async thread(p: Person, replica = 0): Promise<string> {
    const res = await this.on(replica, p).post("/v1/threads", { title: "t" });
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    return res.json.thread_id as string;
  }

  /**
   * A scripted sandbox agent. `capabilities` is what its hello advertises: a current agent
   * (default) lists `skill_bundles` and `builtin_skills`; `null` sends no capabilities at all, like an older agent.
   */
  async connect(
    w: RunWorld,
    replica = 0,
    capabilities: readonly string[] | null = ["skill_bundles", "builtin_skills"],
  ): Promise<FakeWorkspace> {
    const token = this.auth.issue({ sandboxId: randomUUID(), teamId: w.team, userId: w.owner.id });
    const sb = await FakeSandbox.connect(must(this.listeners[replica], "listener").url, token);
    if (!isFake(sb)) throw new Error(`upgrade refused: ${sb.status}`);
    const claims = this.auth.verify(token);
    sb.hello(claims.sub, [], "1.0.0", capabilities ?? undefined);
    await sb.ready();
    const ws = new FakeWorkspace(sb);
    this.workspaces.push(ws);
    return ws;
  }

  async send(
    p: Person,
    threadId: string,
    content: string,
    replica = 0,
    extra: Record<string, unknown> = {},
  ): Promise<TestResponse> {
    return this.on(replica, p).post(`/v1/threads/${threadId}/messages`, { content, ...extra });
  }

  /** Sends and expects 201; returns the run id. */
  async message(p: Person, threadId: string, content: string, replica = 0): Promise<string> {
    const res = await this.send(p, threadId, content, replica);
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    return res.json.run_id as string;
  }

  async run(team: string, runId: string) {
    const { rows } = await this.fx.admin.query<{
      status: string;
      queue_pos: number | null;
      retry_of_run_id: string | null;
      parent_entry_id: string | null;
      user_entry_id: string | null;
      approval_mode: string;
      input: string;
      thread_id: string;
    }>(
      `SELECT status, queue_pos, retry_of_run_id, parent_entry_id, user_entry_id, approval_mode,
              input, thread_id
         FROM runs WHERE team_id = $1 AND id = $2`,
      [team, runId],
    );
    return must(rows[0], "run");
  }

  async status(team: string, runId: string): Promise<string> {
    return (await this.run(team, runId)).status;
  }

  async threadStatus(team: string, threadId: string): Promise<string> {
    const { rows } = await this.fx.admin.query<{ status: string }>(
      `SELECT status FROM threads WHERE team_id = $1 AND id = $2`,
      [team, threadId],
    );
    return must(rows[0], "thread").status;
  }

  async events(team: string, runId: string) {
    const { rows } = await this.fx.admin.query<{
      seq: number;
      type: string;
      payload: Record<string, unknown>;
    }>(
      `SELECT seq, type, payload FROM run_events WHERE team_id = $1 AND run_id = $2 ORDER BY seq`,
      [team, runId],
    );
    return rows;
  }

  async types(team: string, runId: string): Promise<string[]> {
    return (await this.events(team, runId)).map((e) => e.type);
  }

  async auditActions(team: string): Promise<string[]> {
    const { rows } = await this.fx.admin.query<{ action: string }>(
      `SELECT action FROM audit_log WHERE team_id = $1 ORDER BY seq`,
      [team],
    );
    return rows.map((r) => r.action);
  }

  /** Waits (polling) until the run has `status`. */
  async until(team: string, runId: string, status: string, timeout = WAIT_MS): Promise<void> {
    await expect.poll(() => this.status(team, runId), { timeout, interval: 25 }).toBe(status);
  }
}
