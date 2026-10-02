import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { serve, type ServerType } from "@hono/node-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { KobeEvent } from "@kobe/protocol";
import { appendRunEvents } from "./event-stream/append.js";
import { createRunEventHub } from "./event-stream/hub.js";
import {
  EventStreamFixture,
  delta,
  must,
  range,
  type Person,
} from "./testing/event-stream-fixture.js";

const fx = new EventStreamFixture();
let server: ServerType;
let port = 0;

beforeAll(async () => {
  await fx.setup([
    { timings: { keepaliveMs: 10_000 } },
    { timings: { keepaliveMs: 10_000 } },
    // Served over real HTTP: short stall timeout for the slow-consumer test.
    { timings: { keepaliveMs: 100, stallTimeoutMs: 1_000 } },
  ]);
  server = serve({ fetch: fx.replica(2).app.fetch, port: 0, hostname: "127.0.0.1" });
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  port = (server.address() as AddressInfo).port;
  server.on("connection", (socket) => {
    connections += 1;
    socket.once("close", () => (connections -= 1));
  });
});

afterAll(async () => {
  if ("closeAllConnections" in server) server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fx.teardown();
});

const seqs = (events: readonly KobeEvent[]) => events.map((e) => e.seq);

async function fill(teamId: string, runId: string, count: number, size: number): Promise<void> {
  const text = "x".repeat(size);
  for (let done = 0; done < count; done += 50) {
    const n = Math.min(50, count - done);
    await appendRunEvents(
      fx.db,
      teamId,
      runId,
      range(1, n).map(() => delta(text)),
    );
  }
}

describe("slow consumers over real HTTP (ac-6)", () => {
  it("does not read ahead for a client that stops reading, disconnects it, and the client resumes gapless", async () => {
    const owner = await fx.person("slow");
    const team = await fx.team("slowteam", owner);
    const run = await fx.run(team, owner);
    const COUNT = 4_000;
    const SIZE = 8_000; // ~32 MB of events in Postgres
    await fill(team, run, COUNT, SIZE);
    await fx.complete(team, run);

    const cookie = [...owner.browser.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    const hub = fx.replica(2).deps.eventStream.hub;
    let text = "";
    let paused: http.IncomingMessage | undefined;
    const started = Date.now();
    await new Promise<void>((resolve, reject) => {
      const req = http.get(
        {
          host: "127.0.0.1",
          port,
          path: `/v1/runs/${run}/events`,
          headers: { cookie, "x-kobe-team": team, accept: "text/event-stream" },
        },
        (res) => {
          expect(res.statusCode).toBe(200);
          res.setEncoding("utf8");
          const onData = (chunk: string) => {
            text += chunk;
            // Read a few events, then stop reading (a frozen tab, a dead mobile radio).
            if (text.length > 3 * SIZE && !paused) {
              res.off("data", onData);
              res.pause();
              paused = res;
              resolve();
            }
          };
          res.on("data", onData);
        },
      );
      req.on("error", reject);
    });
    // The server notices the stall, drops the connection and frees the subscription and slot.
    await waitFor(() => hub.size === 0, 15_000);
    await waitFor(() => openConnections() === 0, 15_000);
    expect(Date.now() - started).toBeLessThan(10_000);

    // The client drains what was already in flight before the drop, then reconnects.
    await new Promise<void>((resolve) => {
      const res = must(paused, "paused response");
      res.on("data", (chunk: string) => (text += chunk));
      res.once("close", () => resolve());
      res.once("error", () => resolve());
      res.resume();
    });
    // Only frames that arrived whole count (the last one may have been cut off by the drop).
    const whole = text.split("\n\n").slice(0, -1);
    const ids = whole.flatMap((b) => [...b.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1])));
    const last = ids.at(-1) ?? 0;
    expect(last).toBeGreaterThan(0);
    expect(ids).toEqual(range(1, last));
    expect(last).toBeLessThan(COUNT / 2); // the server never pushed the run into the socket
    // Resume from the last complete event the client had: everything after it, nothing twice.
    const reader = await fx.stream(0, owner, run, last);
    expect(seqs(await reader.rest())).toEqual(range(last + 1, COUNT + 1));
  }, 120_000);

  it("serves a lagging but steady reader everything in order", async () => {
    const owner = await fx.person("lag");
    const team = await fx.team("lagteam", owner);
    const run = await fx.run(team, owner);
    await fill(team, run, 1_000, 8_000);
    await fx.complete(team, run);
    // In-process client that reads one frame every few ms: it gets everything, in order.
    const reader = await fx.stream(0, owner, run);
    const got: number[] = [];
    for (let e = await reader.nextEvent(); e; e = await reader.nextEvent()) {
      got.push(e.seq);
      if (got.length % 100 === 0) await new Promise((r) => setTimeout(r, 20));
    }
    expect(got).toEqual(range(1, 1_001));
  }, 60_000);
});

describe("LISTEN connection loss (ac-2)", () => {
  it("keeps delivering while the listener is down and resumes NOTIFY after reconnecting", async () => {
    const owner = await fx.person("listener");
    const team = await fx.team("listenteam", owner);
    const run = await fx.run(team, owner);
    const hub = fx.replica(1).deps.eventStream.hub;
    const reader = await fx.stream(1, owner, run);
    await reader.next(); // retry
    await waitFor(() => hub.state === "listening");

    await fx.admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE application_name = 'kobe-event-hub' AND datname = current_database()`,
    );
    await appendRunEvents(fx.db, team, run, [delta("during outage")]);
    const t0 = Date.now();
    expect((await reader.nextEvent())?.seq).toBe(1);
    expect(Date.now() - t0).toBeLessThan(5_000); // keep-alive is 10 s: polling/resync did it

    await waitFor(() => hub.state === "listening");
    const t1 = Date.now();
    await appendRunEvents(fx.db, team, run, [delta("after reconnect")]);
    expect((await reader.nextEvent())?.seq).toBe(2);
    expect(Date.now() - t1).toBeLessThan(2_000);
    await fx.complete(team, run);
    expect(seqs(await reader.rest())).toEqual([3]);
  }, 30_000);
});

describe("half-open LISTEN connection (review LOW-9)", () => {
  it("notices a silent connection by ping timeout, reconnects and resyncs", async () => {
    const owner = await fx.person("halfopen");
    const team = await fx.team("halfopenteam", owner);
    const run = await fx.run(team, owner);

    // A TCP proxy that can silently swallow traffic, like a dead NAT entry: no FIN, no RST.
    const target = new URL(fx.database.appUrl);
    const pairs: { client: net.Socket; upstream: net.Socket; frozen: boolean }[] = [];
    const proxy = net.createServer((client) => {
      const upstream = net.connect(Number(target.port || 5432), target.hostname);
      const pair = { client, upstream, frozen: false };
      pairs.push(pair);
      client.on("data", (d) => void (pair.frozen || upstream.write(d)));
      upstream.on("data", (d) => void (pair.frozen || client.write(d)));
      const end = () => {
        client.destroy();
        upstream.destroy();
      };
      client.on("error", end).on("close", end);
      upstream.on("error", end).on("close", end);
    });
    await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", () => r()));
    const via = new URL(fx.database.appUrl);
    via.hostname = "127.0.0.1";
    via.port = String((proxy.address() as AddressInfo).port);

    const hub = createRunEventHub({
      connectionString: via.toString(),
      pingMs: 200,
      pingTimeoutMs: 500,
      reconnectMinMs: 50,
      resyncJitterMs: 0,
    });
    const hints: number[] = [];
    let resyncs = 0;
    hub.subscribe(run, {
      hint: (seq) => hints.push(seq),
      resync: () => (resyncs += 1),
      close: () => undefined,
    });
    try {
      await waitFor(() => hub.state === "listening");
      for (const p of pairs) p.frozen = true;
      const before = resyncs;
      await waitFor(() => hub.state !== "listening", 5_000);
      await waitFor(() => hub.state === "listening", 10_000);
      expect(resyncs).toBeGreaterThan(before);
      await appendRunEvents(fx.db, team, run, [delta("after half-open")]);
      await waitFor(() => hints.includes(1), 5_000);
    } finally {
      await hub.close();
      for (const p of pairs) {
        p.client.destroy();
        p.upstream.destroy();
      }
      await new Promise<void>((r) => proxy.close(() => r()));
    }
  }, 30_000);
});

describe("two teams × five users stream concurrently (ac-9, U2, Gate 1)", () => {
  it("each user receives exactly their own run, gapless, and nobody can open anyone else's", async () => {
    const teams: { id: string; people: Person[] }[] = [];
    for (const t of ["gate-a", "gate-b"]) {
      const people = await Promise.all(range(1, 5).map((i) => fx.person(`${t}-u${i}`)));
      const [admin, ...members] = people as [Person, ...Person[]];
      teams.push({ id: await fx.team(t, admin, members), people });
    }
    const users = teams.flatMap((t) => t.people.map((p) => ({ team: t.id, person: p, run: "" })));
    for (const u of users) u.run = await fx.run(u.team, u.person);

    const readers = await Promise.all(users.map((u, i) => fx.stream(i % 2, u.person, u.run)));
    const PER_RUN = 60;
    const writers = users.map(async (u, i) => {
      let written = 0;
      while (written < PER_RUN) {
        const n = Math.min(PER_RUN - written, 1 + ((i + written) % 5));
        await appendRunEvents(
          fx.replica((i + written) % 2).deps.database.db,
          u.team,
          u.run,
          range(1, n).map(() => delta(`${u.person.email}:${written}`)),
        );
        written += n;
      }
      await fx.complete(u.team, u.run);
    });
    const results = await Promise.all(readers.map((r) => r.rest()));
    await Promise.all(writers);

    results.forEach((events, i) => {
      const u = must(users[i], "user");
      expect(seqs(events)).toEqual(range(1, PER_RUN + 1));
      expect(new Set(events.map((e) => e.run_id))).toEqual(new Set([u.run]));
      for (const e of events.filter((x) => x.type === "text.delta"))
        expect((e.payload as { delta: string }).delta.startsWith(`${u.person.email}:`)).toBe(true);
    });

    // Every user tries every other user's run (same team and other team): all 404.
    for (const u of users) {
      for (const other of users) {
        if (other === u) continue;
        const res = await fx.open(0, u.person, other.run, { lastEventId: "0" });
        expect(res.status).toBe(404);
        await res.body?.cancel();
      }
    }
  }, 120_000);
});

let connections = 0;
const openConnections = () => connections;

async function waitFor(cond: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 25));
  }
}
