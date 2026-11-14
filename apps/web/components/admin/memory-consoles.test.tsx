// @vitest-environment happy-dom
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SiteMemoryPage } from "./site/memory-page";
import { TeamMemoryPage } from "./team/memory-page";
import { TEAM, forbidNativeConfirm, renderSite, renderTeam, stubApi } from "./testing";

/**
 * KOBE-385 (SMA10): the Workspace and Site console Memory pages. ac-1 curators act, others read,
 * Team admins read Policy; ac-2 import preview classes and clean-rows commit; ac-3 export and the
 * Site admins' Policy toggle.
 */
const ITEMS = "/v1/memory/semantic/items";
const list = (scope: string, extra = "") =>
  `GET ${ITEMS}?scope=${scope}&status=active${extra}&limit=100`;

let n = 0;
const item = (scope: string, statement: string, extra: Record<string, unknown> = {}) => ({
  id: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
  scope,
  kind: "fact",
  status: "active",
  statement,
  tags: ["ops"],
  pinned: false,
  policy: false,
  as_of: null,
  owner_user_id: null,
  superseded_by: null,
  version: 1,
  created_at: "2026-11-12T09:00:00Z",
  updated_at: "2026-11-12T09:00:00Z",
  updated_by: null,
  ...extra,
});
const page = (scope: string, items: unknown[], usage: Record<string, number> = {}) =>
  [
    200,
    { scope, items, next_cursor: null, usage: { count: items.length, max: 1000, ...usage } },
  ] as const;

const WS = item("team", "Invoices are approved by the finance lead.");
const SITE = item("site", "The wiki lives on the intranet.");
const POLICY = item("site", "Customer data stays in the EU.", { policy: true });

const CURATOR = ["team.memory.curate"];
const ADMIN = ["team.memory.curate", "team.memory.manage"];

beforeEach(forbidNativeConfirm);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Workspace console Memory page (ac-1)", () => {
  const routes = {
    [list("team")]: page("team", [WS]),
    [list("site")]: page("site", [SITE, POLICY], { policy_count: 1, policy_bytes: 31 }),
    [list("site", "&policy=true")]: page("site", [POLICY]),
  };

  it("lets a curator act on Workspace memories and reads Site memories and Policy", async () => {
    const calls = stubApi({
      ...routes,
      [`POST ${ITEMS}/team/${WS.id}/archive`]: [200, { ...WS, status: "archived", version: 1 }],
    });
    renderTeam(<TeamMemoryPage />, { permissions: CURATOR });
    // A steward: Memories and Import and export, no Settings.
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual([
      "Memories",
      "Import and export",
    ]);
    const ws = await screen.findByRole("list", { name: "Workspace memories" });
    const row = within(ws).getByRole("listitem");
    for (const action of ["Edit", "Pin", "Archive"])
      expect(within(row).getByRole("button", { name: new RegExp(`^${action}:`) })).toBeTruthy();
    await userEvent.click(within(row).getByRole("button", { name: /^Archive:/ }));
    expect(await screen.findByText("Archived.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Undo" })).toBeTruthy();
    const archive = calls.find((c) => c.url.endsWith("/archive"));
    expect(archive?.headers.get("x-kobe-team")).toBe(TEAM.id);

    // Site Policy, read-only, as text.
    const policy = await screen.findByRole("list", { name: "Site Policy" });
    expect(within(policy).getByText(POLICY.statement)).toBeTruthy();
    expect(within(policy).queryByRole("button")).toBeNull();

    // Site memories from the Workspace console: read-only.
    await userEvent.selectOptions(
      within(screen.getByRole("form", { name: "Filter memories" })).getByLabelText("Scope"),
      "site",
    );
    const site = await screen.findByRole("list", { name: "Site memories" });
    expect(within(site).getAllByRole("listitem")).toHaveLength(2);
    expect(within(site).queryByRole("button")).toBeNull();
    expect(screen.getByText(/Only their curators change them/)).toBeTruthy();
  });

  it("shows Team admins the Settings tab too", async () => {
    stubApi({ ...routes, "GET /v1/memory/settings?level=team": [200, {}] });
    renderTeam(<TeamMemoryPage />, { permissions: ADMIN });
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual([
      "Memories",
      "Import and export",
      "Settings",
    ]);
    await screen.findByRole("list", { name: "Workspace memories" });
  });

  it("is read-only for anyone who doesn't curate", async () => {
    stubApi(routes);
    renderTeam(<TeamMemoryPage />, { role: "member", permissions: [] });
    const ws = await screen.findByRole("list", { name: "Workspace memories" });
    expect(within(ws).queryByRole("button")).toBeNull();
    expect(screen.queryByRole("form", { name: /^Add to/ })).toBeNull();
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["Memories"]);
  });

  it("filters by kind on the server and by tag in the list", async () => {
    const other = item("team", "Deploys are on Tuesdays.", {
      tags: ["release"],
      kind: "convention",
    });
    const calls = stubApi({
      ...routes,
      [list("team")]: page("team", [WS, other]),
      [list("team", "&kind=convention")]: page("team", [other]),
    });
    renderTeam(<TeamMemoryPage />, { permissions: CURATOR });
    const ws = await screen.findByRole("list", { name: "Workspace memories" });
    expect(within(ws).getAllByRole("listitem")).toHaveLength(2);
    const filters = within(screen.getByRole("form", { name: "Filter memories" }));
    await userEvent.type(filters.getByLabelText("Tag"), "rel");
    expect(within(ws).getAllByRole("listitem")).toHaveLength(1);
    await userEvent.clear(filters.getByLabelText("Tag"));
    await userEvent.selectOptions(filters.getByLabelText("Kind"), "convention");
    await screen.findByText("1 memory shown.");
    expect(calls.some((c) => c.url.includes("kind=convention"))).toBe(true);
  });
});

describe("Import (ac-2)", () => {
  const PREVIEW = "/v1/memory/semantic/import/preview";
  const COMMIT = "/v1/memory/semantic/import/commit";
  const row = (index: number, status: string, codes: string[] = []) => ({
    index,
    status,
    kind: "fact",
    statement: `Row ${index}`,
    tags: [],
    pinned: false,
    policy: false,
    as_of: null,
    issues: codes.map((code) => ({ code, message: `Issue ${code}` })),
  });
  const ROWS = [
    row(0, "new"),
    row(1, "duplicate", ["near_duplicate"]),
    row(2, "warning", ["policy_conflict"]),
    row(3, "invalid", ["policy_off_site"]),
    row(4, "blocked", ["secret"]),
    row(5, "warning", ["instruction_imperative"]),
    row(6, "new"),
  ];
  const MARKDOWN = Array.from({ length: 7 }, (_, i) => `- [fact] Row ${i} #t`).join("\n");

  it("previews with the save checks, names each row's class and imports only the clean rows", async () => {
    const calls = stubApi({
      [list("team")]: page("team", [WS]),
      [list("site", "&policy=true")]: page("site", []),
      [`POST ${PREVIEW}`]: [200, { scope: "team", rows: ROWS, counts: {} }],
      [`POST ${COMMIT}`]: [200, { scope: "team", created: 2, item_ids: [WS.id, SITE.id] }],
    });
    renderTeam(<TeamMemoryPage />, { permissions: CURATOR });
    await userEvent.click(screen.getByRole("tab", { name: "Import and export" }));
    const form = await screen.findByRole("form", { name: "Import into Workspace memories" });
    await userEvent.click(within(form).getByLabelText("Memories to import"));
    await userEvent.paste(MARKDOWN);
    await userEvent.click(within(form).getByRole("button", { name: "Preview" }));

    const heading = await screen.findByRole("heading", { name: "Preview: 7 rows, 2 to import" });
    expect(document.activeElement).toBe(heading);
    const sent = JSON.parse(String(calls.find((c) => c.url === PREVIEW)?.body)) as {
      format: string;
      content: string;
    };
    expect(sent.format).toBe("json");
    expect(JSON.parse(sent.content).items[0]).toEqual({
      kind: "fact",
      statement: "Row 0",
      tags: ["t"],
    });

    const table = screen.getByRole("table", { name: "Import preview" });
    const results = within(table)
      .getAllByRole("row")
      .slice(1)
      .map((r) => within(r).getAllByRole("cell")[3]?.textContent ?? "");
    expect(results.map((r) => r.split("Issue")[0])).toEqual([
      "New",
      "Near-duplicate",
      "Conflicts with Policy",
      "Blocked by Policy rules",
      "Secret: never saved",
      "Flagged by checks",
      "New",
    ]);
    await userEvent.click(screen.getByRole("button", { name: "Import 2 new rows" }));
    expect(await screen.findByText("Imported 2 memories.")).toBeTruthy();
    const commit = JSON.parse(String(calls.find((c) => c.url === COMMIT)?.body)) as {
      accept: number[];
    };
    expect(commit.accept).toEqual([0, 6]);
    // No learning model is asked: only preview and commit were sent.
    expect(calls.filter((c) => c.method === "POST").map((c) => c.url)).toEqual([PREVIEW, COMMIT]);
  });

  it("refuses a file over 200 rows before sending it", async () => {
    const calls = stubApi({
      [list("team")]: page("team", []),
      [list("site", "&policy=true")]: page("site", []),
    });
    renderTeam(<TeamMemoryPage />, { permissions: CURATOR });
    await userEvent.click(screen.getByRole("tab", { name: "Import and export" }));
    const box = await screen.findByLabelText("Memories to import");
    await userEvent.click(box);
    await userEvent.paste(Array.from({ length: 201 }, (_, i) => `- [fact] R${i}`).join("\n"));
    await userEvent.click(screen.getByRole("button", { name: "Preview" }));
    expect((await screen.findByRole("alert")).textContent).toContain("at most 200");
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });
});

describe("Site console Memory page (ac-1, ac-3)", () => {
  const routes = {
    "GET /v1/me/teams": [200, { activeTeamId: null, lastTeamId: null, teams: [] }],
    [list("site")]: page("site", [SITE, POLICY], { policy_count: 1, policy_bytes: 31 }),
  } as const;

  it("gives Site admins the Policy toggle and the Policy budget", async () => {
    const calls = stubApi({
      ...routes,
      [`PATCH ${ITEMS}/site/${SITE.id}`]: [200, { ...SITE, policy: true }],
    });
    renderSite(<SiteMemoryPage />, "admin");
    const site = await screen.findByRole("list", { name: "Site memories" });
    expect(screen.getByRole("group", { name: "Policy budget" }).textContent).toContain(
      "Policy items: 1 of 25 items",
    );
    const toggle = within(site).getByRole("button", { name: `Policy: ${SITE.statement}` });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    await userEvent.click(toggle);
    expect(await screen.findByText("Made Policy.")).toBeTruthy();
    const patch = calls.find((c) => c.method === "PATCH");
    expect(JSON.parse(String(patch?.body))).toEqual({ expected_version: 1, policy: true });
    // Policy items can be changed by Site admins.
    const policyRow = within(site).getByRole("listitem", { name: POLICY.statement });
    expect(within(policyRow).getByRole("button", { name: /^Edit:/ })).toBeTruthy();
  });

  it("gives Site stewards everything but Policy", async () => {
    stubApi(routes);
    renderSite(<SiteMemoryPage />, "user", ["memory_steward"]);
    const site = await screen.findByRole("list", { name: "Site memories" });
    expect(within(site).queryByRole("button", { name: /^Policy:/ })).toBeNull();
    const plain = within(site).getByRole("listitem", { name: SITE.statement });
    expect(within(plain).getByRole("button", { name: /^Edit:/ })).toBeTruthy();
    const policyRow = within(site).getByRole("listitem", { name: POLICY.statement });
    expect(within(policyRow).queryByRole("button")).toBeNull();
    expect(screen.queryByRole("checkbox", { name: /Policy/ })).toBeNull();
  });

  it("exports a scope (audited by the server)", async () => {
    const calls = stubApi({
      ...routes,
      "POST /v1/memory/semantic/export": [200, new Uint8Array([97])],
    });
    renderSite(<SiteMemoryPage />, "admin");
    await userEvent.click(await screen.findByRole("tab", { name: "Import and export" }));
    await userEvent.click(await screen.findByRole("button", { name: "Export CSV" }));
    expect(await screen.findByText("Exported Site memories as CSV.")).toBeTruthy();
    const sent = calls.find((c) => c.url === "/v1/memory/semantic/export");
    expect(sent?.method).toBe("POST");
    expect(JSON.parse(String(sent?.body))).toEqual({ scope: "site", format: "csv" });
  });
});
