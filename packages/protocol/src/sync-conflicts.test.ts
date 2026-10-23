import { describe, expect, it } from "vitest";
import {
  CAPABILITY_SYNC_CONFLICTS,
  SANDBOX_SMALL_FRAME_MAX_BYTES,
  decodeSandboxFrame,
  decodeServerFrame,
  encodeFrame,
  isConflictCopyOf,
  runStartFrameSchema,
  syncConflictActionBodySchema,
  syncConflictSchema,
  threadSyncConflictsResponseSchema,
} from "./index.js";

const SHA_M = "a".repeat(64);
const SHA_A = "b".repeat(64);
const RUN = "3f2c1d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
const THREAD = "4a3b2c1d-6e5f-4a7b-9c8d-1e2f3a4b5c6d";
const conflict = {
  path: "docs/notes.md",
  conflict_path: "docs/notes.conflict-20261023T120000Z.md",
  member_sha256: SHA_M,
  agent_sha256: SHA_A,
};

describe("sync conflict contract (KOBE-492)", () => {
  it("names the capability", () => {
    expect(CAPABILITY_SYNC_CONFLICTS).toBe("sync_conflicts");
  });

  it("recognises conflict copies in the same folder only", () => {
    expect(isConflictCopyOf("notes.md", "notes.conflict-20261023T120000Z.md")).toBe(true);
    expect(isConflictCopyOf("notes.md", "notes.conflict-20261023T120000Z-2.md")).toBe(true);
    expect(isConflictCopyOf("Makefile", "Makefile.conflict-20261023T120000Z")).toBe(true);
    expect(isConflictCopyOf("a/notes.md", "b/notes.conflict-20261023T120000Z.md")).toBe(false);
    expect(isConflictCopyOf("notes.md", "notes.md")).toBe(false);
    expect(isConflictCopyOf("notes.md", "other.md")).toBe(false);
    expect(isConflictCopyOf("notes.md", "notes.conflict-yesterday.md")).toBe(false);
  });

  it("takes valid conflicts and refuses hostile names and hashes", () => {
    expect(syncConflictSchema.safeParse(conflict).success).toBe(true);
    for (const bad of [
      { ...conflict, path: "../etc/passwd" },
      { ...conflict, path: "/workspace/notes.md" },
      { ...conflict, conflict_path: "../notes.conflict-20261023T120000Z.md" },
      { ...conflict, conflict_path: "docs/other.md" },
      { ...conflict, path: "docs/‮notes.md" },
      { ...conflict, member_sha256: "XYZ" },
      { ...conflict, agent_sha256: SHA_A.toUpperCase() },
      { ...conflict, extra: 1 },
    ]) {
      expect(syncConflictSchema.safeParse(bad).success).toBe(false);
    }
  });

  it("decodes the agent's frame with bounded strings (the server validates the names)", () => {
    const frame = {
      v: 1,
      type: "workspace.conflict",
      ...conflict,
      at: "2026-10-23T12:00:00.000Z",
    } as const;
    expect(decodeSandboxFrame(encodeFrame(frame))).toEqual({ ok: true, frame });
    // A hostile name still decodes (dropped by the server, never closing the connection) ...
    const hostile = { ...frame, path: "../x" };
    expect(decodeSandboxFrame(encodeFrame(hostile)).ok).toBe(true);
    // ... but an oversize one does not, and the frame stays a small frame.
    expect(decodeSandboxFrame(encodeFrame({ ...frame, path: "a".repeat(1025) })).ok).toBe(false);
    expect(Buffer.byteLength(encodeFrame(frame))).toBeLessThan(SANDBOX_SMALL_FRAME_MAX_BYTES);
    expect(decodeSandboxFrame(encodeFrame({ ...frame, content: "x" } as typeof frame)).ok).toBe(
      false,
    );
  });

  it("decodes the server's note and the run.start field", () => {
    const note = {
      v: 1 as const,
      type: "workspace.conflict_note" as const,
      run_id: RUN,
      thread_id: THREAD,
      conflicts: [conflict],
    };
    expect(decodeServerFrame(encodeFrame(note))).toEqual({ ok: true, frame: note });
    expect(decodeServerFrame(encodeFrame({ ...note, conflicts: [] })).ok).toBe(false);
    expect(decodeServerFrame(encodeFrame({ ...note, conflicts: Array(6).fill(conflict) })).ok).toBe(
      false,
    );
    expect(runStartFrameSchema.shape.sync_conflicts.safeParse([conflict]).success).toBe(true);
  });

  it("shapes the thread route", () => {
    expect(
      threadSyncConflictsResponseSchema.safeParse({
        conflicts: [{ id: RUN, ...conflict, created_at: "2026-10-23T12:00:00.000Z" }],
      }).success,
    ).toBe(true);
    expect(syncConflictActionBodySchema.safeParse({ action: "dismissed" }).success).toBe(true);
    expect(syncConflictActionBodySchema.safeParse({ action: "delete" }).success).toBe(false);
  });
});
