import { describe, expect, it, vi } from "vitest";
import type { KobeDb } from "./client.js";
import { withTeam } from "./with-team.js";

describe("withTeam (unit)", () => {
  it("rejects a team id that is not a UUID before touching the database", async () => {
    const transaction = vi.fn();
    const db = { transaction } as unknown as KobeDb;
    await expect(withTeam(db, "not-a-uuid", async () => 1)).rejects.toThrow(/team id/i);
    await expect(withTeam(db, "", async () => 1)).rejects.toThrow(/team id/i);
    expect(transaction).not.toHaveBeenCalled();
  });
});
