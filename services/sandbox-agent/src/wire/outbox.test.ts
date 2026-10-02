import { describe, expect, it } from "vitest";
import { Outbox, RESEND_DEDUPE_MS } from "./outbox.js";

const R = "run-1";
const enc = (seq: number) => `frame-${seq}`;

function filled(count: number, maxBytes = 1_000_000) {
  const outbox = new Outbox(maxBytes);
  outbox.open(R, "thread-1");
  for (let i = 0; i < count; i++) outbox.append(R, enc);
  return outbox;
}

describe("Outbox", () => {
  it("assigns gapless seqs from 1 per run", () => {
    const outbox = new Outbox(1000);
    outbox.open(R, "t");
    outbox.open("run-2", "t");
    expect(outbox.append(R, enc)).toMatchObject({ ok: true, seq: 1, text: "frame-1" });
    expect(outbox.append(R, enc)).toMatchObject({ ok: true, seq: 2 });
    expect(outbox.append("run-2", enc)).toMatchObject({ ok: true, seq: 1 });
  });

  it("drops frames on cumulative ack and ignores acks beyond what was sent", () => {
    const outbox = filled(5);
    expect(outbox.ack(R, 3)).toBe(true);
    expect(outbox.resend(R, 1)).toEqual(["frame-4", "frame-5"]);
    expect(outbox.ack(R, 9)).toBe(false);
    expect(outbox.get(R)?.ackedSeq).toBe(3);
  });

  it("re-sends from from_seq once and ignores duplicate resends for the same gap", () => {
    const outbox = filled(5);
    expect(outbox.resend(R, 3)).toEqual(["frame-3", "frame-4", "frame-5"]);
    expect(outbox.resend(R, 3)).toEqual([]);
    expect(outbox.resend(R, 4)).toEqual([]);
    outbox.append(R, enc);
    expect(outbox.resend(R, 6)).toEqual(["frame-6"]);
    outbox.resetConnectionState();
    expect(outbox.resend(R, 3)).toEqual(["frame-3", "frame-4", "frame-5", "frame-6"]);
  });

  it("serves a repeated resend again once the dedupe window has passed", () => {
    const outbox = filled(3);
    expect(outbox.resend(R, 2, 1000)).toEqual(["frame-2", "frame-3"]);
    expect(outbox.resend(R, 2, 1000 + RESEND_DEDUPE_MS - 1)).toEqual([]);
    expect(outbox.resend(R, 2, 1000 + RESEND_DEDUPE_MS)).toEqual(["frame-2", "frame-3"]);
  });

  it("knows when frames needed for a resend were already dropped as acked", () => {
    const outbox = filled(4);
    outbox.ack(R, 2);
    expect(outbox.canResendFrom(R, 3)).toBe(true);
    expect(outbox.canResendFrom(R, 2)).toBe(false);
    expect(outbox.canResendFrom("nope", 1)).toBe(false);
  });

  it("ignores resends beyond the last seq", () => {
    expect(filled(2).resend(R, 3)).toEqual([]);
  });

  it("lists runs with their last seq for hello, and forgets finished runs once acked", () => {
    const outbox = filled(2);
    expect(outbox.helloRuns()).toEqual([{ run_id: R, thread_id: "thread-1", last_seq: 2 }]);
    outbox.finish(R);
    expect(outbox.has(R)).toBe(true);
    outbox.ack(R, 2);
    expect(outbox.has(R)).toBe(false);
    expect(outbox.bytes).toBe(0);
  });

  it("refuses to grow past its byte limit", () => {
    const outbox = new Outbox(20);
    outbox.open(R, "t");
    expect(outbox.append(R, () => "x".repeat(15))).toMatchObject({ ok: true });
    expect(outbox.append(R, () => "x".repeat(15))).toEqual({ ok: false, reason: "overflow" });
    expect(outbox.get(R)?.lastSeq).toBe(1);
    outbox.drop(R);
    expect(outbox.bytes).toBe(0);
  });

  it("rejects appends to unknown runs", () => {
    expect(new Outbox(10).append("nope", enc)).toEqual({ ok: false, reason: "unknown_run" });
  });
});
