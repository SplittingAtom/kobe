// @vitest-environment happy-dom
import { cleanup, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findSection } from "../../lib/admin/nav/registry";
import { must } from "../../lib/testing/must";
import { BackupPage } from "./site/backup-page";
import { forbidNativeConfirm, renderSite, stubApi, summary } from "./testing";

beforeEach(forbidNativeConfirm);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const RESTORES = "GET /v1/site/audit?limit=1&action=platform.restore.completed";
const RETENTION = "GET /v1/site/retention";
const running = { maximum: "forever", applied: "forever", pending: null, paused: false };

const restore = {
  id: "e-9",
  seq: 412,
  at: "2026-10-09T08:00:00.000Z",
  teamId: null,
  actor: { kind: "system", id: null, name: null, email: null },
  action: "platform.restore.completed",
  target: {
    backupCreatedAt: "2026-10-08T23:00:00.000Z",
    tables: 61,
    rows: 120345,
    operator: "ops@example.org",
    auditHeadSeq: 411,
    auditHeadHash: "e".repeat(64),
  },
  ip: null,
  userAgent: null,
};

describe("Site backup and restore (KOBE-291)", () => {
  it("is a ready site admin section", () => {
    const section = must(findSection("site", "backup"));
    expect(section.status.kind).toBe("ready");
    expect(section.label).toBe("Backup and restore");
    expect(section.console === "site" && section.minRole).toBe("admin");
  });

  it("says backups aren't visible, shows the last restore and that deleting jobs run", async () => {
    const calls = stubApi({
      [RESTORES]: [200, { events: [restore], nextCursor: "412" }],
      [RETENTION]: [200, running],
    });
    renderSite(<BackupPage />);
    expect(screen.getByRole("note").textContent).toMatch(/Kobe can't see your backups/);
    const last = (await screen.findByText("Restored")).closest("dl") as HTMLElement;
    expect(last.textContent).toMatch(/ops@example\.org/);
    expect(last.textContent).toMatch(/120,345 rows in 61 tables/);
    expect(last.textContent).toContain(`411:${"e".repeat(64)}`);
    expect(within(last).getAllByRole("time")).toHaveLength(2);
    expect(await screen.findByText("Running")).toBeTruthy();
    expect(summary(calls).sort()).toEqual([RESTORES, RETENTION].sort());
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("says when the site was never restored, and when the deleting jobs are paused", async () => {
    stubApi({
      [RESTORES]: [200, { events: [], nextCursor: null }],
      [RETENTION]: [200, { ...running, paused: true }],
    });
    renderSite(<BackupPage />);
    expect(await screen.findByText("No restore has been recorded on this site.")).toBeTruthy();
    expect(await screen.findByText("Paused")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Retention maximum" }).getAttribute("href")).toBe(
      "/admin/site/retention",
    );
  });

  it("shows the steps with placeholders only, and points to the full runbook", async () => {
    stubApi({
      [RESTORES]: [403, { code: "forbidden", message: "Only site admins read the audit log." }],
      [RETENTION]: [200, running],
    });
    renderSite(<BackupPage />);
    expect((await screen.findByRole("alert")).textContent).toMatch(/Only site admins/);
    const backup = screen.getByLabelText("Take a backup").textContent ?? "";
    expect(backup).toMatch(/kobe backup --out/);
    expect(screen.getByLabelText("Restore a backup").textContent).toMatch(/kobe restore --from/);
    for (const region of ["Back up", "Restore"]) {
      expect(screen.getByRole("region", { name: region }).textContent).toContain(
        "docs/backup-restore.md",
      );
    }
    // Placeholders, never a host, an address or a credential.
    const page = document.body.textContent ?? "";
    expect(page).not.toMatch(/\b\d{1,3}(\.\d{1,3}){3}\b/);
    expect(page).not.toMatch(/https?:\/\//);
  });
});
