import { describe, expect, it } from "vitest";
import { scheduledRunMessage } from "../mail/messages.js";
import { scheduleWhen } from "./email.js";
import { notificationKindOf } from "./record.js";
import { decodeCursor, encodeCursor } from "./store.js";

describe("notificationKindOf", () => {
  it("maps each terminal status of a scheduled run to the contract's kinds", () => {
    expect(notificationKindOf("completed", 0)).toBe("schedule.run.succeeded");
    expect(notificationKindOf("completed", 2)).toBe("schedule.run.skipped_actions");
    expect(notificationKindOf("failed", 2)).toBe("schedule.run.failed");
    expect(notificationKindOf("budget_stopped", 0)).toBe("schedule.run.failed");
    expect(notificationKindOf("interrupted", 0)).toBe("schedule.run.interrupted");
    // The owner's Stop, or the system cancelling a deactivated/removed owner's runs (KOBE-180).
    expect(notificationKindOf("cancelled", 0)).toBeNull();
    expect(notificationKindOf("running", 0)).toBeNull();
  });
});

describe("scheduleWhen", () => {
  it("describes the recurrence, never the prompt", () => {
    expect(scheduleWhen({ kind: "daily", at: "09:00" }, "UTC")).toBe("daily at 09:00 (UTC)");
    expect(scheduleWhen({ kind: "weekdays", at: "07:30" }, "Europe/Berlin")).toBe(
      "weekdays at 07:30 (Europe/Berlin)",
    );
    expect(scheduleWhen({ kind: "weekly", days: ["mon", "thu"], at: "18:00" }, "UTC")).toBe(
      "weekly on mon, thu at 18:00 (UTC)",
    );
    expect(scheduleWhen({ kind: "cron", expr: "0 9 * * 1" }, "UTC")).toBe("cron 0 9 * * 1 (UTC)");
  });
});

describe("scheduledRunMessage", () => {
  const base = {
    to: "a@x.test",
    teamName: "Finance",
    when: "daily at 09:00 (UTC)",
    skippedCount: null,
    threadLink: "http://kobe.test/?thread=t1",
    schedulesLink: "http://kobe.test/me/schedules",
  } as const;

  it("says the outcome, the skipped count and the links", () => {
    const m = scheduledRunMessage({ ...base, outcome: "skipped_actions", skippedCount: 3 });
    expect(m.subject).toBe("Your scheduled run finished with skipped actions in the Finance team");
    expect(m.text).toContain("3 tool calls were skipped");
    expect(m.text).toContain("http://kobe.test/?thread=t1");
    expect(scheduledRunMessage({ ...base, outcome: "failed" }).subject).toBe(
      "Your scheduled run failed in the Finance team",
    );
  });

  it("keeps names on one line", () => {
    const m = scheduledRunMessage({
      ...base,
      outcome: "succeeded",
      teamName: "Fin\r\nBcc: evil@x.test",
      when: "daily\nX-Evil: 1",
    });
    expect(m.subject).not.toMatch(/[\r\n]/);
    expect(m.text.split("\n")[0]).toContain("Fin Bcc: evil@x.test");
    expect(m.text).not.toMatch(/\nX-Evil/);
  });
});

describe("notification cursors", () => {
  it("round-trip and reject anything else", () => {
    const c = { t: "2026-10-11T09:00:00.123456Z", i: "0b6f8f6e-6f1e-4c1a-9f1e-2b7a3c4d5e6f" };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
    expect(decodeCursor("nope")).toBeNull();
    expect(decodeCursor(Buffer.from('{"t":"x","i":"y"}').toString("base64url"))).toBeNull();
  });
});
