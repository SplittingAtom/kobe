import http from "node:http";
import net from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SYSTEM_ACTOR, auditStandalone } from "@kobe/db";
import { AUDIT_FORWARD_LOCK, AuditForwarder, backoffMs } from "./audit/forward/forwarder.js";
import { otlpSink } from "./audit/forward/otlp.js";
import { syslogSink } from "./audit/forward/syslog.js";
import { createPgReconcileLock } from "./sandbox/reconcile-lock.js";
import type { TestBrowser } from "./testing/browser.js";
import { openHarness, type Harness } from "./testing/harness.js";

/** KOBE-19: audit export (CSV/JSONL) and SIEM forwarding (syslog, OTLP) with retry and health. */
let h: Harness;
let owner: TestBrowser;
let admin: TestBrowser;
let alice: TestBrowser;
let bob: TestBrowser;
let member: TestBrowser;
let finance = "";
let marketing = "";
const closers: (() => Promise<void> | void)[] = [];

const SETUP_TOKEN = "setup-token-for-harness-tests-01";

const record = (replica: string) =>
  auditStandalone(h.deps.database.db, {
    action: "platform.isolation.changed",
    actor: SYSTEM_ACTOR,
    target: { from: "verified", to: "missing", replica },
  });

beforeAll(async () => {
  h = await openHarness();
  const setup = await h.browser().post("/v1/setup", {
    setupToken: SETUP_TOKEN,
    email: "owner@export.test",
    name: "Owner",
    password: "a long enough password",
  });
  expect(setup.status).toBe(201);
  await h.createUser("admin@export.test", "admin");
  const aliceId = await h.createUser("alice@export.test");
  const bobId = await h.createUser("bob@export.test");
  await h.createUser("member@export.test");
  owner = await h.signIn("owner@export.test");
  admin = await h.signIn("admin@export.test");
  alice = await h.signIn("alice@export.test");
  bob = await h.signIn("bob@export.test");
  member = await h.signIn("member@export.test");
  finance = (
    await admin.post("/v1/install/teams", {
      slug: "finance",
      name: "Finance",
      adminUserId: aliceId,
    })
  ).json.team.id;
  marketing = (
    await admin.post("/v1/install/teams", {
      slug: "marketing",
      name: "Marketing",
      adminUserId: bobId,
    })
  ).json.team.id;
  await alice.put("/v1/me/teams/active", { teamId: finance });
  await bob.put("/v1/me/teams/active", { teamId: marketing });
});

afterAll(async () => {
  for (const close of closers.splice(0)) await close();
  await h?.close();
});

const lines = (text: string) =>
  text
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Record<string, any>);

describe("export", () => {
  it("is for admins only", async () => {
    expect((await member.get("/v1/install/audit/export?format=csv")).status).toBe(403);
    // Not a team admin (the member has no team yet, so the team gate answers first).
    expect((await member.get("/v1/team/audit/export?format=csv")).status).not.toBe(200);
  });

  it("downloads the install log as CSV and JSONL with the install-only fields", async () => {
    const csv = await admin.get("/v1/install/audit/export?format=csv");
    expect(csv.status).toBe(200);
    expect(csv.headers.get("content-type")).toContain("text/csv");
    expect(csv.headers.get("content-disposition")).toMatch(
      /^attachment; filename="kobe-audit-.*\.csv"$/,
    );
    expect(csv.text.split("\r\n")[0]).toBe(
      "seq,id,at,team_id,actor_kind,actor_id,actor_name,actor_email,action,target,ip,user_agent,prev_hash,hash",
    );
    const jsonl = await admin.get("/v1/install/audit/export?format=jsonl");
    const events = lines(jsonl.text);
    expect(events.map((e) => e.seq)).toEqual([...events.map((e) => e.seq)].sort((a, b) => a - b));
    expect(events[0]).toHaveProperty("hash");
    expect(new Set(events.map((e) => e.teamId))).toEqual(new Set([null, finance, marketing]));
    // The JSONL download adds its own audit.exported row after the CSV one was cut.
    expect(csv.text.split("\r\n").length - 2).toBeLessThanOrEqual(events.length);
  });

  it("exports only the requested date range, and one team on request", async () => {
    const all = lines((await admin.get("/v1/install/audit/export?format=jsonl")).text);
    const future = new Date(Date.now() + 3600_000).toISOString();
    const none = await admin.get(
      `/v1/install/audit/export?format=jsonl&since=${encodeURIComponent(future)}`,
    );
    expect(none.status).toBe(200);
    expect(none.text).toBe("");
    const until = await admin.get(
      `/v1/install/audit/export?format=jsonl&until=${encodeURIComponent(all[2]?.at ?? "")}`,
    );
    expect(lines(until.text).length).toBeGreaterThanOrEqual(2);
    expect(lines(until.text).length).toBeLessThan(all.length);
    const team = lines(
      (await admin.get(`/v1/install/audit/export?format=jsonl&teamId=${marketing}`)).text,
    );
    expect(team.length).toBeGreaterThan(0);
    expect(team.every((e) => e.teamId === marketing)).toBe(true);
  });

  it("validates parameters", async () => {
    for (const q of [
      "",
      "format=xml",
      "format=csv&since=yesterday",
      "format=csv&bogus=1",
      `format=csv&since=${encodeURIComponent("2026-10-02T00:00:00Z")}&until=${encodeURIComponent("2026-10-01T00:00:00Z")}`,
    ]) {
      expect((await admin.get(`/v1/install/audit/export?${q}`)).status, q).toBe(400);
    }
    expect((await alice.get(`/v1/team/audit/export?format=csv&teamId=${marketing}`)).status).toBe(
      400,
    );
  });

  it("gives a team admin only their team, without IPs or chain fields (RLS path)", async () => {
    const mine = await alice.get("/v1/team/audit/export?format=jsonl");
    expect(mine.status).toBe(200);
    const events = lines(mine.text);
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.teamId === finance)).toBe(true);
    for (const f of ["ip", "userAgent", "prevHash", "hash"])
      expect(events[0]).not.toHaveProperty(f);
    const csv = await alice.get("/v1/team/audit/export?format=csv");
    expect(csv.text.split("\r\n")[0]).toBe(
      "seq,id,at,team_id,actor_kind,actor_id,actor_name,actor_email,action,target",
    );
    const theirs = lines((await bob.get("/v1/team/audit/export?format=jsonl")).text);
    expect(theirs.every((e) => e.teamId === marketing)).toBe(true);
    expect(theirs.some((e) => events.some((m) => m.id === e.id))).toBe(false);
  });

  it("records each export (rows, range, completeness) in the right view", async () => {
    const before = lines((await alice.get("/v1/team/audit/export?format=jsonl")).text).length;
    await h.mailer.settle();
    const view = await alice.get("/v1/team/audit?action=audit.exported&limit=50");
    const latest = view.json.events[0];
    expect(latest).toMatchObject({
      action: "audit.exported",
      teamId: finance,
      target: { format: "jsonl", complete: true },
    });
    expect(latest.target.rows).toBeGreaterThanOrEqual(before);
    const install = await admin.get("/v1/install/audit?action=audit.exported&limit=50");
    expect(install.json.events.some((e: { teamId: string | null }) => e.teamId === null)).toBe(
      true,
    );
  });

  it("streams a long log in pages without gaps or repeats", async () => {
    for (let i = 0; i < 430; i++) await record(`bulk-${i}`);
    const events = lines((await owner.get("/v1/install/audit/export?format=jsonl")).text);
    const seqs = events.map((e) => e.seq as number);
    expect(seqs.length).toBeGreaterThan(430);
    expect(seqs.every((s, i) => i === 0 || s === (seqs[i - 1] ?? 0) + 1)).toBe(true);
  });
});

/** A syslog collector and an OTLP collector that can be told to fail. */
async function collectors() {
  const syslog: Buffer[] = [];
  const syslogServer = net.createServer((socket) => {
    socket.on("data", (c: Buffer) => syslog.push(c));
    socket.on("error", () => undefined);
  });
  await new Promise<void>((r) => syslogServer.listen(0, "127.0.0.1", r));
  const otlp: { records: any[] } = { records: [] };
  const state = { status: 200 };
  const otlpServer = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      res.statusCode = state.status;
      if (state.status < 300) {
        otlp.records.push(...(JSON.parse(body).resourceLogs[0].scopeLogs[0].logRecords as any[]));
      }
      res.end("{}");
    });
  });
  await new Promise<void>((r) => otlpServer.listen(0, "127.0.0.1", r));
  closers.push(
    () => void syslogServer.close(),
    () => void otlpServer.close(),
  );
  return {
    syslog,
    otlp,
    state,
    syslogPort: (syslogServer.address() as net.AddressInfo).port,
    otlpPort: (otlpServer.address() as net.AddressInfo).port,
  };
}

const seqOf = (record: any): number =>
  Number(record.attributes.find((a: any) => a.key === "kobe.audit.seq").value.intValue);
const syslogSeqs = (chunks: Buffer[]): number[] =>
  [
    ...Buffer.concat(chunks)
      .toString("utf8")
      .matchAll(/ seq="(\d+)"/g),
  ].map((m) => Number(m[1]));

describe("forwarding health view", () => {
  it("is for install admins and says when nothing is configured", async () => {
    expect((await member.get("/v1/install/audit/forwarding")).status).toBe(403);
    const res = await admin.get("/v1/install/audit/forwarding");
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ enabled: false, destinations: [] });
  });
});

describe("forwarding", () => {
  it("delivers new events to a syslog and an OTLP collector, then waits for more", async () => {
    const c = await collectors();
    const now = new Date();
    const forwarder = new AuditForwarder({
      db: h.deps.database.db,
      sinks: [
        syslogSink({ host: "127.0.0.1", port: c.syslogPort, tls: false }),
        otlpSink({ url: `http://127.0.0.1:${c.otlpPort}/v1/logs`, headers: {} }),
      ],
      lock: createPgReconcileLock(h.deps.database.pool, undefined, `${AUDIT_FORWARD_LOCK}.t1`),
      log: { warn: () => undefined, error: () => undefined },
      now: () => now,
    });
    expect(await forwarder.runOnce()).toBe(true); // first run: cursor starts at the head
    expect(c.otlp.records).toHaveLength(0);

    const sent = [await record("fwd-1"), await record("fwd-2"), await record("fwd-3")];
    await forwarder.runOnce();
    await new Promise((r) => setTimeout(r, 100));
    expect(c.otlp.records.map(seqOf)).toEqual(sent.map((s) => s.seq));
    expect(syslogSeqs(c.syslog)).toEqual(sent.map((s) => s.seq));

    await forwarder.runOnce(); // nothing new: nothing repeated
    expect(c.otlp.records).toHaveLength(3);

    expect(await readHealth("syslog")).toMatchObject({ status: "ok", failures: 0, behind: 0 });
  });

  it("retries failures with backoff, keeps the cursor, and shows them in the health view", async () => {
    const c = await collectors();
    let now = new Date();
    const warned: object[] = [];
    const forwarder = new AuditForwarder({
      db: h.deps.database.db,
      sinks: [otlpSink({ url: `http://127.0.0.1:${c.otlpPort}/v1/logs`, headers: {} })],
      lock: createPgReconcileLock(h.deps.database.pool, undefined, `${AUDIT_FORWARD_LOCK}.t2`),
      log: { warn: (o) => void warned.push(o), error: () => undefined },
      now: () => now,
    });
    await forwarder.runOnce(); // initialize at head
    c.state.status = 503;
    const lost = [await record("down-1"), await record("down-2")];
    await forwarder.runOnce();
    expect(warned).toHaveLength(1);
    await forwarder.runOnce(); // inside the backoff window: no attempt
    expect(warned).toHaveLength(1);

    const down = await readHealth("otlp");
    expect(down).toMatchObject({ status: "retrying", failures: 1, behind: 2 });
    expect(down.lastError).toContain("HTTP 503");
    expect(down.lastError).not.toContain("127.0.0.1");
    expect(Date.parse(down.nextAttemptAt)).toBeGreaterThan(now.getTime());

    now = new Date(now.getTime() + backoffMs(1) + 1);
    await forwarder.runOnce();
    expect(warned).toHaveLength(2);
    expect((await readHealth("otlp")).failures).toBe(2);

    c.state.status = 200;
    now = new Date(now.getTime() + backoffMs(2) + 1);
    await forwarder.runOnce();
    expect(c.otlp.records.map(seqOf)).toEqual(lost.map((s) => s.seq)); // nothing skipped or doubled
    expect(await readHealth("otlp")).toMatchObject({ status: "ok", failures: 0, behind: 0 });
  });

  it("lets one replica forward at a time", async () => {
    const name = `${AUDIT_FORWARD_LOCK}.t3`;
    const holder = createPgReconcileLock(h.deps.database.pool, undefined, name);
    const forwarder = new AuditForwarder({
      db: h.deps.database.db,
      sinks: [],
      lock: createPgReconcileLock(h.deps.database.pool, undefined, name),
      log: { warn: () => undefined, error: () => undefined },
    });
    const ranWhileHeld = await holder.runExclusive(() => forwarder.runOnce());
    expect(ranWhileHeld).toEqual({ ran: true, value: false });
    expect(await forwarder.runOnce()).toBe(true);
  });
});

async function readHealth(destination: string) {
  const { deps } = h;
  const { readForwardingHealth } = await import("./audit/forward/state.js");
  const health = await readForwardingHealth(deps.database.db, ["syslog", "otlp"]);
  return health.destinations.find((d) => d.destination === destination) as Record<string, any>;
}
