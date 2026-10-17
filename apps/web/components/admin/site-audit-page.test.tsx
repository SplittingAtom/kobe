// @vitest-environment happy-dom
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canSee, findSection } from "../../lib/admin/nav/registry";
import { must } from "../../lib/testing/must";
import { SiteAuditPage } from "./site/audit-page";
import { clientDetailsVisible, plainValue } from "./site/audit-events";
import { localToIso } from "./site/audit-filters";
import { forbidNativeConfirm, ME, renderSite, stubApi, summary } from "./testing";

beforeEach(forbidNativeConfirm);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const LIST = "GET /v1/site/audit?limit=50";
const INTEGRITY = "GET /v1/site/audit/integrity";
const TEAM_ID = "00000000-0000-4000-8000-0000000000aa";
const BOB_ID = "00000000-0000-4000-8000-0000000000bb";
const HOUR = 3_600_000;
const ago = (hours: number) => new Date(Date.now() - hours * HOUR).toISOString();

const event = (over: Record<string, unknown>) => ({
  id: "e-1",
  seq: 10,
  at: ago(1),
  teamId: null,
  actor: { kind: "user", id: BOB_ID, name: "Bob", email: "bob@x.io" },
  action: "identity.member.removed",
  target: { userId: BOB_ID },
  ip: "203.0.113.7",
  userAgent: "Firefox/140",
  prevHash: "a".repeat(64),
  hash: "b".repeat(64),
  ...over,
});

const VERIFIED = {
  ok: true,
  checked: 10,
  head: { seq: 10, hash: "c".repeat(64) },
  anchor: { seq: 10, hash: "c".repeat(64), at: ago(0), mac: "d".repeat(64) },
};

function stubPage(routes: Record<string, unknown> = {}) {
  return stubApi({
    "GET /v1/site/users": [
      200,
      {
        users: [
          { ...ME, siteRole: "admin" },
          { id: BOB_ID, name: "Bob", email: "bob@x.io" },
        ],
      },
    ],
    "GET /v1/site/teams": [200, { teams: [{ id: TEAM_ID, slug: "fin", name: "Finance" }] }],
    "GET /v1/site/settings": [200, { requireTwoFactor: false, auditPiiRetentionHours: 12 }],
    [INTEGRITY]: [200, VERIFIED],
    [LIST]: [200, { events: [event({})], nextCursor: null }],
    ...(routes as Record<string, readonly [number, unknown?]>),
  });
}

const table = () => screen.findByRole("table", { name: "Audit events, newest first" });

describe("Site audit log (KOBE-291)", () => {
  it("is a site admin section", () => {
    const section = must(findSection("site", "audit"));
    expect(section.status.kind).toBe("ready");
    const access = (siteRole: "owner" | "admin" | "user") =>
      ({ console: "site", user: ME, siteRole }) as const;
    expect(canSee(section, access("admin"))).toBe(true);
    expect(canSee(section, access("owner"))).toBe(true);
    expect(canSee(section, access("user"))).toBe(false);
  });

  it("lists events with actor, team, action, details and client, and only reads", async () => {
    const calls = stubPage({
      [LIST]: [
        200,
        {
          events: [
            event({}),
            event({
              id: "e-2",
              seq: 9,
              teamId: TEAM_ID,
              actor: { kind: "system", id: null, name: null, email: null },
              action: "sandbox.runtime_tampered",
              target: { sandboxId: "sb-1", runKind: "message" },
              ip: null,
              userAgent: null,
            }),
          ],
          nextCursor: null,
        },
      ],
    });
    renderSite(<SiteAuditPage />);
    const rows = within(await table()).getAllByRole("row");
    expect(rows).toHaveLength(3);
    expect(must(rows[1]).textContent).toMatch(
      /10.*Bob.*bob@x\.io.*Site.*identity\.member\.removed.*userId:.*203\.0\.113\.7.*Firefox\/140/,
    );
    expect(must(rows[2]).textContent).toMatch(
      /9.*Kobe \(system\).*Finance.*sandbox\.runtime_tampered.*sandboxId: sb-1.*runKind: message/,
    );
    expect(within(must(rows[2])).getByText("Not shown")).toBeTruthy();
    expect(screen.getByText(/shown for 12 hours after each event/)).toBeTruthy();
    expect(calls.every((c) => c.method === "GET")).toBe(true);
    expect(screen.queryByRole("button", { name: /delete|edit|remove/i })).toBeNull();
  });

  it("doesn't verify the chain on open: it says so until Verify chain is pressed", async () => {
    const calls = stubPage();
    renderSite(<SiteAuditPage />);
    await table();
    const region = screen.getByRole("region", { name: "Chain integrity" });
    expect(within(region).getByText("Not verified yet.")).toBeTruthy();
    expect(summary(calls)).not.toContain(INTEGRITY);

    await userEvent.click(within(region).getByRole("button", { name: "Verify chain" }));
    expect(await within(region).findByText("Chain verified")).toBeTruthy();
    // Announced politely, with the count.
    expect(within(region).getByRole("status").textContent).toMatch(
      /^Chain verified at .*: 10 events\.$/,
    );
    expect(
      within(region)
        .getByText(/Last checked/)
        .querySelector("time")
        ?.getAttribute("datetime"),
    ).toBe(VERIFIED.anchor.at);
    expect(region.textContent).toMatch(/All 10 events chain correctly, up to event #10/);
    expect(region.textContent).toContain(`10:${"c".repeat(64)}`);
    expect(region.textContent).toContain("d".repeat(64));
    expect(within(region).queryByText("Not verified yet.")).toBeNull();
    expect(summary(calls).filter((c) => c === INTEGRITY)).toHaveLength(1);
  });

  it("names the first broken event, and keeps it when the rate limit refuses a new check", async () => {
    const calls = stubPage({
      [INTEGRITY]: [
        [
          200,
          {
            ok: false,
            checked: 4,
            head: null,
            problem: { seq: 4, kind: "hash_mismatch" },
            anchor: null,
          },
        ],
        [429, { code: "rate_limited", message: "Try the check again in a minute." }],
      ],
    });
    renderSite(<SiteAuditPage />);
    await table();
    const region = screen.getByRole("region", { name: "Chain integrity" });
    const verify = within(region).getByRole("button", { name: "Verify chain" });
    await userEvent.click(verify);
    const note = await within(region).findByRole("note");
    expect(note.textContent).toMatch(/The chain is broken/);
    expect(note.textContent).toMatch(/Event #4: its contents do not match its hash/);
    const live = within(region).getByRole("status");
    expect(live.textContent).toMatch(
      /^Chain verification failed at .*: the chain is broken at event #4\.$/,
    );
    expect(region.textContent).toMatch(/Last checked/);

    await userEvent.click(verify);
    expect(await within(region).findAllByText(/^Try again in a minute/)).toHaveLength(2);
    expect(live.textContent).toMatch(/^Try again in a minute/);
    // The refusal is a warning, not an error, and the previous result stays, marked as such.
    expect(within(region).queryByRole("alert")).toBeNull();
    expect(region.textContent).toMatch(/Previous result, checked/);
    expect(region.textContent).toMatch(/Event #4/);
    expect(summary(calls).filter((c) => c === INTEGRITY)).toHaveLength(2);
  });

  it("filters by action, category, actor, team and time on the server, and clears", async () => {
    const since = "2026-10-01T09:00";
    const until = "2026-10-02T18:30";
    const query = new URLSearchParams({
      limit: "50",
      action: "sandbox.runtime_tampered",
      category: "sandbox",
      actorId: BOB_ID,
      teamId: TEAM_ID,
      since: must(localToIso(since)),
      until: must(localToIso(until, { endOfMinute: true })),
    });
    const filtered = `GET /v1/site/audit?${query.toString()}`;
    const calls = stubPage({ [filtered]: [200, { events: [], nextCursor: null }] });
    renderSite(<SiteAuditPage />);
    await table();
    await userEvent.type(screen.getByLabelText("Action"), "sandbox.runtime_tampered");
    await userEvent.selectOptions(screen.getByLabelText("Category"), "sandbox");
    await userEvent.selectOptions(screen.getByLabelText("Actor"), "Bob (bob@x.io)");
    await userEvent.selectOptions(screen.getByLabelText("Team"), "Finance");
    await userEvent.type(screen.getByLabelText("From"), since);
    await userEvent.type(screen.getByLabelText("To"), until);
    await userEvent.click(screen.getByRole("button", { name: "Apply filters" }));
    expect(
      await screen.findByText("No events match these filters.", { selector: "p.font-medium" }),
    ).toBeTruthy();
    expect(summary(calls)).toContain(filtered);

    await userEvent.click(screen.getByRole("button", { name: "Clear" }));
    await table();
    expect(summary(calls).filter((c) => c === LIST)).toHaveLength(2);
    expect((screen.getByLabelText("Action") as HTMLInputElement).value).toBe("");
  });

  it("refuses a malformed action or a reversed time range before asking the server", async () => {
    const calls = stubPage();
    renderSite(<SiteAuditPage />);
    await table();
    await userEvent.type(screen.getByLabelText("Action"), "not an action");
    await userEvent.type(screen.getByLabelText("From"), "2026-10-02T10:00");
    await userEvent.type(screen.getByLabelText("To"), "2026-10-01T10:00");
    await userEvent.click(screen.getByRole("button", { name: "Apply filters" }));
    expect(screen.getByLabelText("Action").getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByText(/Enter an action name such as/)).toBeTruthy();
    expect(screen.getByText("Choose a time after the start.")).toBeTruthy();
    expect(summary(calls).filter((c) => c.startsWith("GET /v1/site/audit?"))).toEqual([LIST]);
  });

  it("pages with the same filters and shows a failed page as an error", async () => {
    const filtered = "GET /v1/site/audit?limit=50&category=auth";
    const calls = stubPage({
      [filtered]: [200, { events: [event({})], nextCursor: "10" }],
      "GET /v1/site/audit?limit=50&category=auth&before=10": [
        [200, { events: [event({ id: "e-0", seq: 3, action: "auth.sign_out" })], nextCursor: "3" }],
        [500, { code: "boom", message: "relation audit_log does not exist" }],
      ],
      "GET /v1/site/audit?limit=50&category=auth&before=3": [
        500,
        { code: "boom", message: "relation audit_log does not exist" },
      ],
    });
    renderSite(<SiteAuditPage />);
    await table();
    await userEvent.selectOptions(screen.getByLabelText("Category"), "auth");
    await userEvent.click(screen.getByRole("button", { name: "Apply filters" }));
    await userEvent.click(await screen.findByRole("button", { name: "Load more" }));
    expect(await screen.findByText("auth.sign_out")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Load more" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/HTTP 500/);
    expect(alert.textContent).not.toMatch(/relation/);
    expect(summary(calls)).toContain("GET /v1/site/audit?limit=50&category=auth&before=10");
  });
});

describe("what the audit page never shows", () => {
  it("hides the IP and user agent once the erasure period has passed, even if sent", async () => {
    stubPage({
      [LIST]: [
        200,
        {
          events: [
            event({ id: "new", seq: 2, at: ago(1), ip: "198.51.100.1", userAgent: "New/1" }),
            event({ id: "old", seq: 1, at: ago(13), ip: "198.51.100.2", userAgent: "Old/1" }),
          ],
          nextCursor: null,
        },
      ],
    });
    renderSite(<SiteAuditPage />);
    const rows = within(await table()).getAllByRole("row");
    await waitFor(() => expect(must(rows[1]).textContent).toContain("198.51.100.1"));
    expect(must(rows[2]).textContent).not.toContain("198.51.100.2");
    expect(must(rows[2]).textContent).not.toContain("Old/1");
  });

  it("hides every IP and user agent when the erasure period can't be read", async () => {
    stubPage({ "GET /v1/site/settings": [403, { code: "forbidden", message: "No." }] });
    renderSite(<SiteAuditPage />);
    await table();
    expect(await screen.findByText(/hidden: the erasure period could not be read/)).toBeTruthy();
    expect(screen.queryByText("203.0.113.7")).toBeNull();
  });

  it("renders event fields as plain text and leaves out fields it does not show", async () => {
    stubPage({
      [LIST]: [
        200,
        {
          events: [
            event({
              target: {
                name: '<img src=x onerror="alert(1)">',
                url: "javascript:alert(1)",
                nested: { b: "<b>bold</b>" },
              },
              piiSalt: "SALT-SHOULD-NOT-SHOW",
              piiCommitment: "COMMIT-SHOULD-NOT-SHOW",
            }),
          ],
          nextCursor: null,
        },
      ],
    });
    const { container } = renderSite(<SiteAuditPage />);
    const t = await table();
    expect(t.textContent).toContain('name: <img src=x onerror="alert(1)">');
    expect(t.textContent).toContain('nested: {"b":"<b>bold</b>"}');
    expect(container.querySelector("img, b, script")).toBeNull();
    expect(within(t).queryByRole("link")).toBeNull();
    for (const hidden of [
      "SALT-SHOULD-NOT-SHOW",
      "COMMIT-SHOULD-NOT-SHOW",
      "a".repeat(64),
      "b".repeat(64),
    ]) {
      expect(container.textContent).not.toContain(hidden);
    }
  });
});

describe("audit page helpers", () => {
  it("shows client details only inside the erasure period", () => {
    const now = Date.parse("2026-10-15T12:00:00Z");
    expect(clientDetailsVisible("2026-10-15T01:00:00Z", 12, now)).toBe(true);
    expect(clientDetailsVisible("2026-10-15T00:00:00Z", 12, now)).toBe(false);
    expect(clientDetailsVisible("2026-10-15T11:00:00Z", null, now)).toBe(false);
    expect(clientDetailsVisible("not a date", 12, now)).toBe(false);
  });

  it("turns values into text", () => {
    expect(plainValue("x")).toBe("x");
    expect(plainValue(3)).toBe("3");
    expect(plainValue(null)).toBe("null");
    expect(plainValue({ a: [1] })).toBe('{"a":[1]}');
  });
});

describe("audit paging and filtering (KOBE-291 review)", () => {
  it("drops a Load more page that answers after the filters changed", async () => {
    let release: (r: Response) => void = () => undefined;
    const late = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const calls = stubPage({
      [LIST]: [200, { events: [event({ id: "first", seq: 50 })], nextCursor: "50" }],
      "GET /v1/site/audit?limit=50&category=auth": [
        200,
        { events: [event({ id: "auth-1", seq: 7, action: "auth.sign_out" })], nextCursor: null },
      ],
    });
    const api = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: RequestInit) =>
        url === "/v1/site/audit?limit=50&before=50" ? late : api(url, init),
      ),
    );
    renderSite(<SiteAuditPage />);
    await table();
    await userEvent.click(screen.getByRole("button", { name: "Load more" }));
    await userEvent.selectOptions(screen.getByLabelText("Category"), "auth");
    await userEvent.click(screen.getByRole("button", { name: "Apply filters" }));
    expect(await screen.findByText("auth.sign_out")).toBeTruthy();
    // The unfiltered page arrives late: it must not join the auth view.
    release(
      new Response(
        JSON.stringify({
          events: [event({ id: "stale", seq: 49, action: "models.provider.added" })],
          nextCursor: "49",
        }),
        { status: 200 },
      ),
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText("models.provider.added")).toBeNull();
    expect(within(await table()).getAllByRole("row")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
    expect(summary(calls)).toContain("GET /v1/site/audit?limit=50&category=auth");
  });

  it("disables the filter buttons and hides the old rows while a view loads", async () => {
    let release: (r: Response) => void = () => undefined;
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    stubPage();
    const api = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: RequestInit) =>
        url === "/v1/site/audit?limit=50&category=auth" ? pending : api(url, init),
      ),
    );
    renderSite(<SiteAuditPage />);
    await table();
    await userEvent.selectOptions(screen.getByLabelText("Category"), "auth");
    await userEvent.click(screen.getByRole("button", { name: "Apply filters" }));
    expect(screen.getByRole("button", { name: "Apply filters" }).hasAttribute("disabled")).toBe(
      true,
    );
    expect(screen.getByRole("button", { name: "Clear" }).hasAttribute("disabled")).toBe(true);
    expect(screen.queryByRole("table", { name: "Audit events, newest first" })).toBeNull();
    const events = screen.getByRole("region", { name: "Events" });
    expect(within(events).getByRole("status").textContent).toBe("Loading audit events…");
    release(new Response(JSON.stringify({ events: [], nextCursor: null }), { status: 200 }));
    await waitFor(() =>
      expect(within(events).getByRole("status").textContent).toBe("No events match these filters."),
    );
    expect(screen.getByRole("button", { name: "Apply filters" }).hasAttribute("disabled")).toBe(
      false,
    );
  });

  it("announces each page and moves focus to the heading when the last page is in", async () => {
    stubPage({
      [LIST]: [200, { events: [event({ id: "a", seq: 3 })], nextCursor: "3" }],
      "GET /v1/site/audit?limit=50&before=3": [
        200,
        { events: [event({ id: "b", seq: 2 }), event({ id: "c", seq: 1 })], nextCursor: null },
      ],
    });
    renderSite(<SiteAuditPage />);
    await table();
    const events = screen.getByRole("region", { name: "Events" });
    const live = within(events).getByRole("status");
    expect(live.textContent).toBe("Showing 1 event; more can be loaded.");
    await userEvent.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() =>
      expect(live.textContent).toBe(
        "Loaded 2 events more: 3 events shown, the whole log for these filters.",
      ),
    );
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Events" })),
    );
  });

  it("shows times with seconds and the time zone", async () => {
    stubPage({
      [LIST]: [200, { events: [event({ at: "2026-10-15T10:30:45.000Z" })], nextCursor: null }],
    });
    renderSite(<SiteAuditPage />);
    const time = must(
      within(await table())
        .getByRole("row", { name: /identity/ })
        .querySelector("time"),
    );
    expect(time.getAttribute("datetime")).toBe("2026-10-15T10:30:45.000Z");
    expect(time.textContent).toMatch(/\d{1,2}:\d{2}:45/);
    expect(time.textContent).toMatch(/[A-Z]{2,5}|GMT|UTC/);
  });

  it("explains a refused action name, and shows other refusals as they come", async () => {
    stubPage({
      "GET /v1/site/audit?limit=50&action=sandbox.runtime_tamperd": [
        400,
        { code: "invalid_request", message: "Check the filters: limit 1-200, …" },
      ],
    });
    renderSite(<SiteAuditPage />);
    await table();
    await userEvent.type(screen.getByLabelText("Action"), "sandbox.runtime_tamperd");
    await userEvent.click(screen.getByRole("button", { name: "Apply filters" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/No action is called sandbox\.runtime_tamperd/);
    cleanup();

    stubPage({
      [LIST]: [403, { code: "forbidden", message: "You don't have permission to do that." }],
    });
    renderSite(<SiteAuditPage />);
    expect((await screen.findByRole("alert")).textContent).toMatch(/don't have permission/);
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("makes To include its whole minute, and leaves From at its start", () => {
    const to = must(localToIso("2026-10-15T10:30", { endOfMinute: true }));
    const from = must(localToIso("2026-10-15T10:30"));
    expect(Date.parse(to) - Date.parse(from)).toBe(59_999);
    expect(localToIso("2026-10-15T10:30:15", { endOfMinute: true })).toBe(
      localToIso("2026-10-15T10:30:15"),
    );
    expect(localToIso("")).toBeUndefined();
  });
});
