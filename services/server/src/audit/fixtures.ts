import type { AuditEntry } from "@kobe/db";

/** A fully populated audit entry for formatting tests. */
export function entry(over: Partial<AuditEntry> & { seq?: number } = {}): AuditEntry {
  const seq = over.seq ?? 1;
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    seq,
    at: new Date("2026-10-01T12:00:00.123Z"),
    teamId: null,
    actor: {
      kind: "user",
      id: "11111111-1111-4111-8111-111111111111",
      name: "Ada",
      email: "ada@example.test",
    },
    action: "identity.team.created",
    target: { teamId: "22222222-2222-4222-8222-222222222222" },
    ip: "203.0.113.7",
    userAgent: "Mozilla/5.0",
    prevHash: "a".repeat(64),
    hash: "b".repeat(64),
    ...over,
  };
}
