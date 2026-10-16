// @vitest-environment happy-dom
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { must } from "../../lib/testing/must";
import { AuditForwardingPage } from "./site/audit-forwarding-page";
import { renderSite, stubApi, summary } from "./testing";

const URL_ = "GET /v1/site/audit/forwarding";
const AT = "2026-10-15T10:00:00.000Z";

const ok = {
  destination: "syslog",
  status: "ok",
  behind: 0,
  seq: 120,
  delivered: 118,
  failures: 0,
  nextAttemptAt: null,
  lastSuccessAt: AT,
  lastErrorAt: null,
  lastError: null,
};
const failing = {
  destination: "otlp",
  status: "failing",
  behind: 42,
  seq: 78,
  delivered: 70,
  failures: 6,
  nextAttemptAt: "2026-10-15T10:15:00.000Z",
  lastSuccessAt: "2026-10-15T09:00:00.000Z",
  lastErrorAt: AT,
  lastError: "OTLP collector answered HTTP 503",
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Audit forwarding (KOBE-182)", () => {
  it("says forwarding is off and how to turn it on", async () => {
    stubApi({ [URL_]: [200, { enabled: false, head: 9, destinations: [] }] });
    renderSite(<AuditForwardingPage />);
    expect(await screen.findByText(/Forwarding is off/)).toBeTruthy();
    expect(screen.getByText("auditForwarding")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("shows status, lag and the last error per destination", async () => {
    stubApi({ [URL_]: [200, { enabled: true, head: 120, destinations: [ok, failing] }] });
    renderSite(<AuditForwardingPage />);
    const table = await screen.findByRole("table", { name: "Forwarding destinations" });
    const rows = within(table).getAllByRole("row");
    expect(rows).toHaveLength(3);
    expect(must(rows[1]).textContent).toMatch(/Syslog.*Delivering.*0.*118/);
    expect(must(rows[2]).textContent).toMatch(/OTLP.*Failing \(6 failures in a row\).*42.*70/);
    const alert = screen.getByRole("alert", { name: /OTLP: last error/ });
    expect(alert.textContent).toContain("OTLP collector answered HTTP 503");
    expect(alert.textContent).toMatch(/42 events wait/);
    expect(screen.queryByRole("alert", { name: /Syslog/ })).toBeNull();
  });

  it("marks retrying as a warning and a not-yet-run destination as pending", async () => {
    stubApi({
      [URL_]: [
        200,
        {
          enabled: true,
          head: 5,
          destinations: [
            { ...failing, status: "retrying", failures: 1 },
            { destination: "syslog", status: "pending", behind: null },
          ],
        },
      ],
    });
    renderSite(<AuditForwardingPage />);
    const table = await screen.findByRole("table", { name: "Forwarding destinations" });
    const rows = within(table).getAllByRole("row");
    expect(must(rows[1]).textContent).toMatch(/Retrying \(1 failure\)/);
    expect(must(rows[2]).textContent).toMatch(/Waiting for the first run/);
    expect(screen.getByRole("status", { name: /OTLP: last error/ }).textContent).toContain(
      "HTTP 503",
    );
  });

  it("keeps an old error visible after recovery, marked as resolved", async () => {
    stubApi({
      [URL_]: [
        200,
        {
          enabled: true,
          head: 120,
          destinations: [
            { ...ok, lastErrorAt: "2026-10-14T08:00:00.000Z", lastError: "connect ECONNREFUSED" },
          ],
        },
      ],
    });
    renderSite(<AuditForwardingPage />);
    const note = await screen.findByRole("note", { name: /Syslog: last error/ });
    expect(note.textContent).toMatch(/resolved/i);
    expect(note.textContent).toContain("connect ECONNREFUSED");
  });

  it("never shows collector credentials, even if the server sent them", async () => {
    stubApi({
      [URL_]: [
        200,
        {
          enabled: true,
          head: 3,
          destinations: [
            {
              ...failing,
              lastError:
                "Request cannot be constructed from a URL that includes credentials: " +
                "https://siem-user:pa55word@collector.example.test/v1/logs?token=t0ken (Bearer abc.def)",
            },
          ],
        },
      ],
    });
    renderSite(<AuditForwardingPage />);
    const alert = await screen.findByRole("alert", { name: /OTLP: last error/ });
    for (const secret of ["siem-user", "pa55word", "t0ken", "abc.def"]) {
      expect(alert.textContent).not.toContain(secret);
    }
    expect(alert.textContent).toContain("https://[redacted]@collector.example.test/v1/logs");
  });

  it("refreshes on request and shows API errors", async () => {
    const calls = stubApi({
      [URL_]: [
        [200, { enabled: true, head: 120, destinations: [ok] }],
        [403, { code: "forbidden", message: "You don't have permission to do that." }],
      ],
    });
    renderSite(<AuditForwardingPage />);
    await screen.findByRole("table", { name: "Forwarding destinations" });
    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText("You don't have permission to do that.")).toBeTruthy();
    expect(summary(calls)).toEqual([URL_, URL_]);
  });
});
