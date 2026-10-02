import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, inject, it } from "vitest";
import { waitForMigrations } from "./wait.js";

/** A migrations folder whose newest journal entry is later than anything applied. */
function futureJournal(): string {
  const dir = mkdtempSync(join(tmpdir(), "kobe-journal-"));
  mkdirSync(join(dir, "meta"));
  writeFileSync(
    join(dir, "meta", "_journal.json"),
    JSON.stringify({ entries: [{ idx: 0, when: Date.now() + 86_400_000, tag: "0000_future" }] }),
  );
  return dir;
}

describe("waitForMigrations (as the app role)", () => {
  it("resolves once this build's latest migration is applied", async () => {
    await expect(
      waitForMigrations({ databaseUrl: inject("appUrl"), timeoutMs: 5_000 }),
    ).resolves.toBeUndefined();
  });

  it("times out with a clear error while a newer migration is still pending", async () => {
    await expect(
      waitForMigrations({
        databaseUrl: inject("appUrl"),
        migrationsFolder: futureJournal(),
        timeoutMs: 1_000,
        intervalMs: 200,
      }),
    ).rejects.toThrow(/0000_future.*not applied/);
  });
});
