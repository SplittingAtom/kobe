import { AUDIT_EVENTS, type AuditEvent } from "@kobe/db";
import { pino } from "pino";
import { describe, expect, it, vi } from "vitest";
import { ConnectionAudit, type ConnectionRecord } from "./connection-audit.js";

const logger = pino({ level: "silent" });
const base: ConnectionRecord = {
  teamId: "0b5e8f1c-2d3a-4b5c-8d9e-0f1a2b3c4d5e",
  userId: "2d7a0b3e-4f5c-4d7e-8fa0-2b3c4d5e6f70",
  sandboxId: "4f9c2d5a-6b7e-4f90-8bc2-4d5e6f708192",
  domain: "pypi.org",
  port: 443,
  outcome: "allowed",
  reason: undefined,
  bytesUp: 100,
  bytesDown: 1000,
};

describe("ConnectionAudit", () => {
  it("aggregates per key and window, counting every connection once, with valid targets", async () => {
    const written: AuditEvent[] = [];
    const audit = new ConnectionAudit({
      write: async (events) => void written.push(...events),
      logger,
      flushMs: 60_000,
    });
    audit.record(base);
    audit.record(base);
    audit.record({ ...base, outcome: "blocked", reason: "not_enabled", bytesUp: 0, bytesDown: 0 });
    audit.record({ ...base, domain: undefined, outcome: "blocked", reason: "invalid_target" });
    await audit.flush();
    expect(written).toHaveLength(3);
    const allowed = written.find(
      (e) => e.target && "outcome" in e.target && e.target.outcome === "allowed",
    );
    expect(allowed?.target).toMatchObject({
      connections: 2,
      bytesUp: 200,
      bytesDown: 2000,
      domain: "pypi.org",
    });
    for (const event of written) {
      expect(event.action).toBe("egress.connection");
      expect(event.actor).toEqual({ kind: "system", id: null });
      expect(AUDIT_EVENTS["egress.connection"].target.safeParse(event.target).success).toBe(true);
    }
    await audit.flush();
    expect(written).toHaveLength(3);
  });

  it("keeps rows for the next flush when the write fails", async () => {
    const write = vi.fn().mockRejectedValueOnce(new Error("db down")).mockResolvedValue(undefined);
    const audit = new ConnectionAudit({ write, logger, flushMs: 60_000 });
    audit.record(base);
    await audit.flush();
    audit.record(base);
    await audit.flush();
    expect(write).toHaveBeenCalledTimes(2);
    const events = write.mock.calls[1]?.[0] as AuditEvent[];
    expect(events).toHaveLength(1);
    expect(events[0]?.target).toMatchObject({ connections: 2 });
  });

  it("collapses a sandbox's random-host flood into one aggregated row (bounded audit writes)", async () => {
    const written: AuditEvent[] = [];
    const audit = new ConnectionAudit({
      write: async (events) => void written.push(...events),
      logger,
      flushMs: 60_000,
      distinctKeys: { burst: 5, perSecond: 0 },
    });
    for (let i = 0; i < 1_000; i++) {
      audit.record({
        ...base,
        domain: `r${i}.example.com`,
        outcome: "blocked",
        reason: "not_in_ceiling",
        bytesUp: 0,
        bytesDown: 0,
      });
    }
    // Another sandbox is not affected by this one's flood.
    audit.record({ ...base, sandboxId: "5a0d3e6b-7c8f-4a01-9cd3-5e6f708192a3" });
    await audit.flush();
    expect(written).toHaveLength(7);
    const collapsed = written.find((e) => (e.target as { aggregated?: boolean }).aggregated);
    expect(collapsed?.target).toMatchObject({
      connections: 995,
      outcome: "blocked",
      aggregated: true,
    });
    expect(collapsed?.target).not.toHaveProperty("domain");
    for (const event of written) {
      expect(AUDIT_EVENTS["egress.connection"].target.safeParse(event.target).success).toBe(true);
    }
  });

  it("flushes early when many distinct keys pile up", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const audit = new ConnectionAudit({ write, logger, flushMs: 60_000, maxKeys: 3 });
    for (const port of [1, 2, 3]) audit.record({ ...base, port });
    await audit.stop();
    expect(write).toHaveBeenCalledTimes(1);
  });
});
