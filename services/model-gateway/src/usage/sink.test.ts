import { randomUUID } from "node:crypto";
import type { ModelUsageRecord } from "@kobe/db";
import pino from "pino";
import { describe, expect, it } from "vitest";
import type { CallRecord } from "../seams.js";
import { DbUsageSink, usageRecordOf } from "./sink.js";

const logger = pino({ level: "silent" });

const call = (over: Partial<CallRecord> = {}): CallRecord => ({
  teamId: randomUUID(),
  userId: randomUUID(),
  sandboxId: randomUUID(),
  runId: undefined,
  route: "openai",
  path: "/v1/chat/completions",
  model: "openai/m",
  status: 200,
  startedAt: new Date(),
  durationMs: 5,
  ttfbMs: 1,
  bytesIn: 10,
  bytesOut: 20,
  errorType: undefined,
  aborted: false,
  usage: { source: "reported", counts: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } },
  ...over,
});

describe("usageRecordOf", () => {
  it("records only model calls that reached Bifrost", () => {
    expect(usageRecordOf(call({ usage: undefined }))).toBeUndefined();
    expect(usageRecordOf(call({ model: undefined }))).toBeUndefined();
    expect(usageRecordOf(call())).toMatchObject({ inputTokens: 1, outputTokens: 2 });
  });
});

describe("DbUsageSink", () => {
  it("writes one batch per team and retries only the team whose write failed", async () => {
    const writes: ModelUsageRecord[][] = [];
    const failing = randomUUID();
    let failures = 1;
    const sink = new DbUsageSink({
      logger,
      flushMs: 60_000,
      write: async (records) => {
        if (records[0]?.teamId === failing && failures-- > 0) throw new Error("db down");
        writes.push([...records]);
        return records.length;
      },
    });
    const ok = randomUUID();
    sink.record(call({ teamId: ok }));
    sink.record(call({ teamId: failing }));
    sink.record(call({ teamId: ok }));
    await sink.flush();
    expect(writes.map((w) => [w[0]?.teamId, w.length])).toEqual([[ok, 2]]);
    expect(sink.pending).toBe(1);
    await sink.close();
    expect(writes.map((w) => [w[0]?.teamId, w.length])).toEqual([
      [ok, 2],
      [failing, 1],
    ]);
  });

  it("retries a failed batch row by row, so one bad row does not sink its team's others", async () => {
    const writes: ModelUsageRecord[][] = [];
    const team = randomUUID();
    const bad = randomUUID();
    const sink = new DbUsageSink({
      logger,
      flushMs: 60_000,
      maxAttempts: 2,
      write: async (records) => {
        if (records.some((r) => r.userId === bad)) throw new Error("foreign key");
        writes.push([...records]);
        return records.length;
      },
    });
    sink.record(call({ teamId: team }));
    sink.record(call({ teamId: team, userId: bad }));
    await sink.flush();
    expect(writes).toEqual([]);
    await sink.flush();
    expect(writes.map((w) => w.length)).toEqual([1]);
    await sink.flush();
    expect(sink.pending).toBe(0);
    await sink.close();
  });

  it("gives up on a record after its attempts and bounds the queue", async () => {
    const sink = new DbUsageSink({
      logger,
      flushMs: 60_000,
      maxQueue: 3,
      maxAttempts: 2,
      write: async () => {
        throw new Error("db down");
      },
    });
    for (let i = 0; i < 5; i++) sink.record(call());
    expect(sink.pending).toBe(3);
    await sink.flush();
    await sink.flush();
    expect(sink.pending).toBe(0);
    await sink.close();
  });
});
