// @vitest-environment happy-dom
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { must } from "../../lib/testing/must";
import { LegalHoldPage } from "./site/legal-hold-page";
import { SettingsPage } from "./site/settings-page";
import { forbidNativeConfirm, answerConfirm, ME, renderSite, stubApi } from "./testing";

const TEAMS = { teams: [{ id: "t-1", slug: "fin", name: "Finance" }] };
const ROSTER = {
  members: [{ userId: "u-bob", name: "Bob", email: "b@x.io", role: "member", joined_at: "" }],
};
const NO_ACTIONS = {
  approve: false,
  deny: false,
  withdraw: false,
  requestRelease: false,
  approveRelease: false,
  denyRelease: false,
  withdrawRelease: false,
};

const hold = (over: Record<string, unknown> = {}) => ({
  id: "h-1",
  team: { id: "t-1", slug: "fin", name: "Finance" },
  scope: "team",
  subject: null,
  reason: "Litigation matter 7",
  status: "pending",
  requestedBy: { id: "u-ivy", name: "Ivy", email: "i@x.io" },
  requestedAt: "2026-10-02T10:00:00Z",
  approvedBy: null,
  approvedAt: null,
  selfApproved: false,
  closedBy: null,
  closedAt: null,
  release: null,
  releasedBy: null,
  releasedAt: null,
  releaseSelfApproved: false,
  actions: { ...NO_ACTIONS, approve: true, deny: true },
  ...over,
});

const ACTIVE = hold({
  id: "h-2",
  scope: "user",
  subject: { id: "u-bob", name: "Bob", email: "b@x.io" },
  status: "active",
  approvedBy: { id: ME.id, name: ME.name, email: ME.email },
  approvedAt: "2026-10-02T11:00:00Z",
  selfApproved: true,
  actions: { ...NO_ACTIONS, requestRelease: true },
});

const RELEASING = hold({
  id: "h-3",
  status: "active",
  approvedBy: { id: "u-olive", name: "Olive", email: "o@x.io" },
  approvedAt: "2026-10-02T11:00:00Z",
  release: {
    requestedBy: { id: "u-ivy", name: "Ivy", email: "i@x.io" },
    requestedAt: "2026-10-03T09:00:00Z",
    reason: "Matter settled",
  },
  actions: { ...NO_ACTIONS, approveRelease: true, denyRelease: true },
});

// The console asks in its own dialog (useConfirm); the native one must never be used.
beforeEach(forbidNativeConfirm);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("site legal hold page", () => {
  it("requests a hold on one user's data with a reason", async () => {
    const calls = stubApi({
      "GET /v1/site/legal-hold": [200, { holds: [], selfApprovalAllowed: false }],
      "GET /v1/site/teams": [200, TEAMS],
      "GET /v1/site/teams/t-1/members": [200, ROSTER],
      "POST /v1/site/legal-hold": [201, { hold: hold({ scope: "user" }) }],
    });
    renderSite(<LegalHoldPage />);
    const form = await screen.findByRole("form", { name: "Request a legal hold" });
    await userEvent.selectOptions(within(form).getByLabelText("Team"), "t-1");
    await userEvent.click(within(form).getByLabelText("One user's data in this team"));
    await screen.findByRole("option", { name: /Bob/ });
    await userEvent.selectOptions(within(form).getByLabelText("User"), "u-bob");
    await userEvent.type(within(form).getByLabelText("Reason"), "Litigation matter 7");
    await userEvent.click(within(form).getByRole("button", { name: "Request hold" }));
    await screen.findByText(/A second site admin must place it/);
    const post = must(calls.find((c) => c.method === "POST"));
    expect(JSON.parse(String(post.body))).toEqual({
      teamId: "t-1",
      userId: "u-bob",
      reason: "Litigation matter 7",
    });
  });

  it("places a pending hold and shows self-approval flagged", async () => {
    const calls = stubApi({
      "GET /v1/site/legal-hold": [200, { holds: [hold(), ACTIVE], selfApprovalAllowed: false }],
      "GET /v1/site/teams": [200, TEAMS],
      "POST /v1/site/legal-hold/h-1/approve": [200, { hold: hold({ status: "active" }) }],
    });
    renderSite(<LegalHoldPage />);
    const table = await screen.findByRole("table", { name: "Holds and requests" });
    expect(within(table).getByText(/Placed by Ada alone \(self-approved, flagged\)/)).toBeTruthy();
    expect(within(table).getByText("Data of Bob")).toBeTruthy();
    await userEvent.click(within(table).getByRole("button", { name: "Place" }));
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    await answerConfirm(/^Place the legal hold on /, "Place");
    await screen.findByText(/purges of this data are suspended/);
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/h-1/approve"))).toBe(true);
  });

  it("asks to release with a reason, and approves another admin's release", async () => {
    const calls = stubApi({
      "GET /v1/site/legal-hold": [200, { holds: [ACTIVE, RELEASING], selfApprovalAllowed: false }],
      "GET /v1/site/teams": [200, TEAMS],
      "POST /v1/site/legal-hold/h-2/release": [200, { hold: ACTIVE }],
      "POST /v1/site/legal-hold/h-3/release/approve": [
        200,
        { hold: hold({ id: "h-3", status: "released" }) },
      ],
    });
    renderSite(<LegalHoldPage />);
    const table = await screen.findByRole("table", { name: "Holds and requests" });
    expect(within(table).getByText(/Matter settled/)).toBeTruthy();
    await userEvent.click(within(table).getByRole("button", { name: "Ask to release" }));
    const form = await screen.findByRole("form", { name: "Ask to release a legal hold" });
    await userEvent.type(within(form).getByLabelText("Why can it end?"), "The case was closed");
    await userEvent.click(within(form).getByRole("button", { name: "Ask to release" }));
    await screen.findByText(/stays in force until a second site admin approves/);
    const ask = must(calls.find((c) => c.url.endsWith("/h-2/release")));
    expect(JSON.parse(String(ask.body))).toEqual({ reason: "The case was closed" });

    await userEvent.click(
      within(await screen.findByRole("table", { name: "Holds and requests" })).getByRole("button", {
        name: "Approve release",
      }),
    );
    await answerConfirm(/^Release the legal hold on /, "Approve release");
    await screen.findByText(/purges of this data may resume/);
    expect(calls.some((c) => c.url.endsWith("/h-3/release/approve"))).toBe(true);
  });
});

describe("site legal hold confirmation", () => {
  it("sends nothing when the decision is cancelled", async () => {
    const calls = stubApi({
      "GET /v1/site/legal-hold": [200, { holds: [hold()], selfApprovalAllowed: false }],
      "GET /v1/site/teams": [200, TEAMS],
    });
    renderSite(<LegalHoldPage />);
    const table = await screen.findByRole("table", { name: "Holds and requests" });
    await userEvent.click(within(table).getByRole("button", { name: "Deny" }));
    await answerConfirm(/^Deny the legal hold on /, "Cancel");
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
  });
});

describe("audit log privacy setting", () => {
  it("saves how long audit events keep IP addresses", async () => {
    const calls = stubApi({
      "GET /v1/site/settings": [200, { requireTwoFactor: false, auditPiiRetentionHours: 12 }],
      "PUT /v1/site/settings": [200, { requireTwoFactor: false, auditPiiRetentionHours: 48 }],
    });
    renderSite(<SettingsPage />, "admin");
    const form = await screen.findByRole("form", { name: "Audit log privacy" });
    const input = within(form).getByRole("spinbutton");
    await userEvent.clear(input);
    await userEvent.type(input, "48");
    await userEvent.click(within(form).getByRole("button", { name: "Save retention" }));
    await screen.findByText(/for 48 hours/);
    const put = must(calls.find((c) => c.method === "PUT"));
    expect(JSON.parse(String(put.body))).toEqual({ auditPiiRetentionHours: 48 });
  });
});
