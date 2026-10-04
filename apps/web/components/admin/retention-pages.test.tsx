// @vitest-environment happy-dom
import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { must } from "../../lib/testing/must";
import { RetentionMaximumPage } from "./install/retention-page";
import { TeamRetentionPage } from "./team/retention-page";
import { TEAM, renderInstall, renderTeam, stubApi } from "./testing";

const view = (
  period: string,
  maximum: string,
  effective: string,
  allowed: string[],
  pending: { period: string; effectiveAt: string } | null = null,
) => ({
  period,
  maximum,
  effective,
  allowed,
  pending,
  upcoming: pending,
});

const AT = "2026-10-11T03:00:00.000Z";

let confirm: ReturnType<typeof vi.fn>;

beforeEach(() => {
  confirm = vi.fn(() => true);
  vi.stubGlobal("confirm", confirm);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Team retention (KOBE-18)", () => {
  it("offers the periods within the maximum and saves a shorter one after confirming", async () => {
    const calls = stubApi({
      "GET /v1/team/retention": [
        [200, view("forever", "1y", "1y", ["30d", "90d", "1y"])],
        [200, view("90d", "1y", "1y", ["30d", "90d", "1y"], { period: "90d", effectiveAt: AT })],
      ],
      "PUT /v1/team/retention": [
        200,
        view("90d", "1y", "1y", ["30d", "90d", "1y"], { period: "90d", effectiveAt: AT }),
      ],
    });
    renderTeam(<TeamRetentionPage />);
    // The team chose forever, but the install caps it at a year.
    expect(await screen.findByText(/The install keeps conversations at most 1 year/)).toBeTruthy();
    expect(screen.queryByRole("radio", { name: "Forever" })).toBeNull();
    expect(screen.getByRole("radio", { name: "1 year" })).toHaveProperty("checked", true);
    await userEvent.click(screen.getByRole("radio", { name: "90 days" }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(confirm).toHaveBeenCalledOnce();
    await screen.findByText(/Scheduled: from .* keeps conversations for 90 days/);
    const put = must(calls.find((c) => c.method === "PUT"));
    expect(JSON.parse(String(put.body))).toEqual({ period: "90d" });
    expect(put.headers.get("x-kobe-team")).toBe(TEAM.id);
  });

  it("sends nothing when the confirmation is cancelled, and shows the server's refusal", async () => {
    confirm.mockReturnValue(false);
    const calls = stubApi({
      "GET /v1/team/retention": [200, view("1y", "forever", "1y", ["30d", "90d", "1y", "forever"])],
      "PUT /v1/team/retention": [
        409,
        { code: "exceeds_maximum", message: "The install keeps threads at most 90d." },
      ],
    });
    renderTeam(<TeamRetentionPage />);
    await userEvent.click(await screen.findByRole("radio", { name: "30 days" }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
    // Longer than what applies: no confirmation needed; the server refuses it.
    await userEvent.click(screen.getByRole("radio", { name: "Forever" }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/at most 90d/);
  });
});

describe("Install retention maximum (KOBE-18)", () => {
  it("lowers the maximum after confirming", async () => {
    const calls = stubApi({
      "GET /v1/install/retention": [
        [200, { maximum: "forever", applied: "forever", pending: null }],
        [200, { maximum: "1y", applied: "forever", pending: { maximum: "1y", effectiveAt: AT } }],
      ],
      "PUT /v1/install/retention": [
        200,
        { maximum: "1y", applied: "forever", pending: { maximum: "1y", effectiveAt: AT } },
      ],
      "DELETE /v1/install/retention/pending": [
        200,
        { maximum: "forever", applied: "forever", pending: null },
      ],
    });
    renderInstall(<RetentionMaximumPage />);
    expect(await screen.findByRole("radio", { name: "Forever" })).toHaveProperty("checked", true);
    await userEvent.click(screen.getByRole("radio", { name: "1 year" }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(confirm).toHaveBeenCalledOnce();
    await screen.findByText(/Scheduled: from .* the maximum is 1 year/);
    const put = must(calls.find((c) => c.method === "PUT"));
    expect(JSON.parse(String(put.body))).toEqual({ maximum: "1y" });
    await userEvent.click(await screen.findByRole("button", { name: "Cancel change" }));
    await screen.findByText("Cancelled: the maximum stays forever.");
    expect(calls.some((c) => c.method === "DELETE")).toBe(true);
  });
});

describe("Pending team change (7-day grace, KOBE-18)", () => {
  it("shows the pending shortening with its date and cancels it", async () => {
    const pending = { period: "30d", effectiveAt: AT };
    const calls = stubApi({
      "GET /v1/team/retention": [
        [200, view("30d", "forever", "forever", ["30d", "90d", "1y", "forever"], pending)],
        [200, view("forever", "forever", "forever", ["30d", "90d", "1y", "forever"])],
      ],
      "DELETE /v1/team/retention/pending": [
        200,
        view("forever", "forever", "forever", ["30d", "90d", "1y", "forever"]),
      ],
    });
    renderTeam(<TeamRetentionPage />);
    expect(await screen.findByText(/Pending change: 30 days/)).toBeTruthy();
    expect(screen.getByText(/older than 30 days will be deleted from/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Cancel change" }));
    await screen.findByText("Cancelled: the team keeps conversations forever.");
    const del = must(calls.find((c) => c.method === "DELETE"));
    expect(del.headers.get("x-kobe-team")).toBe(TEAM.id);
  });
});
