// @vitest-environment happy-dom
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { must } from "../../lib/testing/must";
import { forbidNativeConfirm, answerConfirm, renderTeam, stubApi } from "../admin/testing";
import { MyMemoryPage } from "./my-memory-page";

/** The My memory page's Memories tab: the Me editor (KOBE-384, ac-2, ac-3, review fixes). */
const MEMBER = { role: "member", permissions: ["team.chat"] } as const;
const ID = "00000000-0000-4000-8000-00000000a001";
const ID2 = "00000000-0000-4000-8000-00000000a002";
const ID3 = "00000000-0000-4000-8000-00000000a003";
const BASE = "/v1/memory/semantic/items";
const ONLY_HERE = "Only in this workspace";
const EVERYWHERE = "All my workspaces";

type Reply = readonly [number, unknown?];
const url = (scope: string, status: string, pinned?: boolean, cursor?: string) =>
  `${BASE}?scope=${scope}&status=${status}${pinned === undefined ? "" : `&pinned=${pinned}`}&limit=100${cursor ? `&cursor=${cursor}` : ""}`;
const LIST = (scope: string, pinned = false) => `GET ${url(scope, "active", pinned)}`;
const ARCHIVED = (scope: string) => `GET ${url(scope, "archived")}`;

const item = (over: Record<string, unknown> = {}) => ({
  id: ID,
  scope: "user",
  kind: "preference",
  status: "active",
  statement: "Prefers answers in euros",
  tags: ["money"],
  pinned: false,
  policy: false,
  as_of: null,
  owner_user_id: "u-me",
  superseded_by: null,
  version: 1,
  created_at: "2026-11-10T10:00:00Z",
  updated_at: "2026-11-10T10:00:00Z",
  updated_by: "u-me",
  ...over,
});
const page = (
  scope: string,
  items: unknown[],
  usage = { count: items.length, max: 300 },
  next: string | null = null,
): Reply => [200, { scope, items, next_cursor: next, usage }];

/** Both lists of a group: pinned (own request) and the rest. */
function group(
  scope: string,
  others: unknown[] | Reply | Reply[] = [],
  pinned: unknown[] = [],
): Record<string, Reply | Reply[]> {
  return {
    [LIST(scope, true)]: page(scope, pinned),
    [LIST(scope)]:
      Array.isArray(others) && (others.length === 0 || !Array.isArray(others[0]))
        ? page(scope, others as unknown[])
        : (others as Reply | Reply[]),
  };
}
const groups = (user: Parameters<typeof group>[1] = [], portable: unknown[] = []) => ({
  ...group("user", user),
  ...group("portable", portable),
});

const bodyOf = (
  calls: { method: string; url: string; body: unknown }[],
  method: string,
  path: string,
) =>
  JSON.parse(String(must(calls.filter((c) => c.method === method && c.url === path).at(-1)).body));

beforeEach(() => {
  forbidNativeConfirm();
  window.history.replaceState(null, "", "/me/memory");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

describe("My memory page (ac-3, review M5, L4)", () => {
  it("opens on Memories, and Notes holds the memory files; the address follows", async () => {
    stubApi({ ...groups(), "GET /v1/memory?scope=user": [200, { docs: [] }] });
    renderTeam(<MyMemoryPage />, MEMBER);
    const tabs = screen.getByRole("tablist", { name: "Memory" });
    expect(
      within(tabs)
        .getAllByRole("tab")
        .map((t) => t.textContent),
    ).toEqual(["Memories", "Notes"]);
    expect(screen.getByRole("tab", { name: "Memories" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(await screen.findByRole("heading", { name: ONLY_HERE })).toBeTruthy();
    expect(screen.getByRole("heading", { name: EVERYWHERE })).toBeTruthy();
    await userEvent.click(screen.getByRole("tab", { name: "Notes" }));
    await screen.findByText(/No memory files yet/);
    expect(window.location.search).toBe("?tab=notes");
    await userEvent.click(screen.getByRole("tab", { name: "Memories" }));
    expect(window.location.search).toBe("");
  });

  it("has one title, My memory: no second label in either tab", async () => {
    stubApi({ ...groups(), "GET /v1/memory?scope=user": [200, { docs: [] }] });
    renderTeam(<MyMemoryPage />, MEMBER);
    await screen.findByRole("heading", { name: ONLY_HERE });
    expect(screen.getAllByRole("heading", { level: 1 }).map((h) => h.textContent)).toEqual([
      "My memory",
    ]);
    expect(screen.queryByRole("heading", { name: /My memories|My notes/ })).toBeNull();
    await userEvent.click(screen.getByRole("tab", { name: "Notes" }));
    await screen.findByText(/No memory files yet/);
    expect(screen.getAllByRole("heading", { level: 1 }).map((h) => h.textContent)).toEqual([
      "My memory",
    ]);
  });

  it("keeps an unsent memory when you look at Notes and come back", async () => {
    stubApi({ ...groups(), "GET /v1/memory?scope=user": [200, { docs: [] }] });
    renderTeam(<MyMemoryPage />, MEMBER);
    await userEvent.type(await screen.findByLabelText("New memory"), "Half written");
    await userEvent.click(screen.getByRole("tab", { name: "Notes" }));
    await screen.findByText(/No memory files yet/);
    await userEvent.click(screen.getByRole("tab", { name: "Memories" }));
    expect((screen.getByLabelText("New memory") as HTMLTextAreaElement).value).toBe("Half written");
  });

  it("uses the one scope label map: never 'team', never 'This workspace' for my own", async () => {
    stubApi(groups([item()], [item({ id: ID2, scope: "portable", tags: [] })]));
    const { container } = renderTeam(<MyMemoryPage />, MEMBER);
    await screen.findByRole("list", { name: ONLY_HERE });
    expect(container.textContent).not.toMatch(/\bteam\b/i);
    expect(container.textContent).not.toMatch(/This workspace/);
  });
});

describe("Me editor (ac-2)", () => {
  it("lists pinned first, counts pins from their own list, and says how full each group is", async () => {
    stubApi({
      [LIST("user", true)]: page("user", [
        item({ id: ID2, pinned: true, statement: "Pinned one" }),
      ]),
      [LIST("user")]: page("user", [item()], { count: 240, max: 300 }),
      ...group("portable"),
      [LIST("portable")]: page("portable", [], { count: 50, max: 50 }),
    });
    renderTeam(<MyMemoryPage />, MEMBER);
    const listEl = await screen.findByRole("list", { name: ONLY_HERE });
    expect(
      within(listEl)
        .getAllByRole("listitem")
        .map((li) => li.getAttribute("aria-label")),
    ).toEqual(["Pinned one", "Prefers answers in euros"]);
    const row = screen.getByRole("listitem", { name: "Prefers answers in euros" });
    expect(row.textContent).toContain("Preference");
    expect(row.textContent).toContain("money");
    expect(screen.getByText(/1 of 10 pinned/)).toBeTruthy();
    expect(screen.getByText(/240 of 300 memories used/)).toBeTruthy();
    expect(screen.getByText(/50 of 50 memories\. Archive one/)).toBeTruthy();
  });

  it("pages with Show more and the API's cursor", async () => {
    const calls = stubApi({
      ...groups(),
      [LIST("user")]: page("user", [item()], { count: 2, max: 300 }, "c1"),
      [`GET ${url("user", "active", false, "c1")}`]: page("user", [
        item({ id: ID2, statement: "Older one" }),
      ]),
    });
    renderTeam(<MyMemoryPage />, MEMBER);
    await userEvent.click(await screen.findByRole("button", { name: `Show more (${ONLY_HERE})` }));
    expect(await screen.findByRole("listitem", { name: "Older one" })).toBeTruthy();
    expect(screen.getByRole("listitem", { name: "Prefers answers in euros" })).toBeTruthy();
    expect(calls.some((c) => c.url.endsWith("&cursor=c1"))).toBe(true);
    expect(screen.queryByRole("button", { name: `Show more (${ONLY_HERE})` })).toBeNull();
  });

  it("adds a memory to this workspace and Undo archives it", async () => {
    const calls = stubApi({
      ...groups(),
      [`POST ${BASE}`]: [201, item()],
      [`POST ${BASE}/user/${ID}/archive`]: [200, item({ status: "archived" })],
    });
    renderTeam(<MyMemoryPage />, MEMBER);
    await userEvent.type(await screen.findByLabelText("New memory"), "Prefers answers in euros");
    await userEvent.type(screen.getByLabelText("Tags"), "Money, money");
    await userEvent.click(screen.getByRole("button", { name: "Save memory" }));
    await screen.findByText("Memory saved.");
    expect(bodyOf(calls, "POST", BASE)).toEqual({
      scope: "user",
      kind: "preference",
      statement: "Prefers answers in euros",
      tags: ["money"],
    });
    expect(await screen.findByRole("listitem", { name: "Prefers answers in euros" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    await screen.findByText("Undone.");
    expect(bodyOf(calls, "POST", `${BASE}/user/${ID}/archive`)).toEqual({ expected_version: 1 });
    await waitFor(() =>
      expect(screen.queryByRole("listitem", { name: "Prefers answers in euros" })).toBeNull(),
    );
  });

  it("asks 'Use in all my workspaces?' with the text before saving a portable preference", async () => {
    const calls = stubApi({
      ...groups(),
      [`POST ${BASE}`]: [201, item({ scope: "portable", tags: [] })],
    });
    renderTeam(<MyMemoryPage />, MEMBER);
    await userEvent.type(await screen.findByLabelText("New memory"), "Use metric units");
    await userEvent.click(screen.getByRole("checkbox", { name: /Use in all my workspaces/ }));
    await userEvent.click(screen.getByRole("button", { name: "Save memory" }));
    expect(await answerConfirm("Use in all my workspaces?", "Cancel")).toContain(
      "Use metric units",
    );
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: "Save memory" }));
    await answerConfirm("Use in all my workspaces?", "Use in all my workspaces");
    await screen.findByText("Memory saved.");
    expect(bodyOf(calls, "POST", BASE)).toMatchObject({
      scope: "portable",
      kind: "preference",
      confirm_portable: true,
    });
  });

  it("offers the portable choice for preferences only", async () => {
    stubApi(groups());
    renderTeam(<MyMemoryPage />, MEMBER);
    await screen.findByLabelText("New memory");
    expect(screen.getByRole("checkbox", { name: /Use in all my workspaces/ })).toBeTruthy();
    await userEvent.selectOptions(screen.getByLabelText("Kind"), "fact");
    expect(screen.queryByRole("checkbox", { name: /Use in all my workspaces/ })).toBeNull();
  });

  it("shows check warnings and a near-duplicate link inline, then saves anyway with the override", async () => {
    const calls = stubApi({
      ...groups([item()]),
      [`POST ${BASE}`]: [
        [
          409,
          {
            code: "memory_lint_warning",
            message: "warnings",
            warnings: [
              { code: "near_duplicate", message: "A similar memory exists." },
              { code: "instruction_imperative", message: "This reads like an order to the agent." },
            ],
            duplicates: [{ id: ID, version: 1, similarity: 0.9 }],
          },
        ],
        [201, item({ id: ID2, statement: "You must answer in euros" })],
      ],
    });
    renderTeam(<MyMemoryPage />, MEMBER);
    await userEvent.type(await screen.findByLabelText("New memory"), "You must answer in euros");
    await userEvent.click(screen.getByRole("button", { name: "Save memory" }));
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("This reads like an order to the agent.")).toBeTruthy();
    const link = within(within(alert).getByRole("list", { name: "Similar memories" })).getByRole(
      "link",
      { name: "Prefers answers in euros" },
    );
    expect(link.getAttribute("href")).toBe(`#memory-item-${ID}`);
    await userEvent.click(within(alert).getByRole("button", { name: "Save anyway" }));
    await screen.findByText("Memory saved.");
    expect(bodyOf(calls, "POST", BASE).overrides).toEqual({ lint: true });
  });

  it("names a near-duplicate in the server's words when the answer lists no items", async () => {
    stubApi({
      ...groups(),
      [`POST ${BASE}`]: [
        409,
        {
          code: "memory_lint_warning",
          message: "w",
          warnings: [{ code: "near_duplicate", message: "A similar memory exists." }],
        },
      ],
    });
    renderTeam(<MyMemoryPage />, MEMBER);
    await userEvent.type(await screen.findByLabelText("New memory"), "Again");
    await userEvent.click(screen.getByRole("button", { name: "Save memory" }));
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("A similar memory exists.")).toBeTruthy();
  });

  it("drops a pending Save anyway when Use in all my workspaces changes", async () => {
    const calls = stubApi({
      ...groups(),
      [`POST ${BASE}`]: [
        409,
        {
          code: "memory_lint_warning",
          message: "w",
          warnings: [{ code: "link_blocked", message: "Blocked link." }],
        },
      ],
    });
    renderTeam(<MyMemoryPage />, MEMBER);
    await userEvent.type(await screen.findByLabelText("New memory"), "See example.com");
    await userEvent.click(screen.getByRole("button", { name: "Save memory" }));
    await screen.findByRole("button", { name: "Save anyway" });
    await userEvent.click(screen.getByRole("checkbox", { name: /Use in all my workspaces/ }));
    expect(screen.queryByRole("button", { name: "Save anyway" })).toBeNull();
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("never offers Save anyway for a secret", async () => {
    stubApi({ ...groups(), [`POST ${BASE}`]: [422, { code: "memory_secret", message: "secret" }] });
    renderTeam(<MyMemoryPage />, MEMBER);
    await userEvent.type(await screen.findByLabelText("New memory"), "token abc");
    await userEvent.click(screen.getByRole("button", { name: "Save memory" }));
    await screen.findByText(/Memories never hold secrets/);
    expect(screen.queryByRole("button", { name: "Save anyway" })).toBeNull();
  });

  it("keeps the lint override when a Policy conflict follows", async () => {
    const calls = stubApi({
      ...groups(),
      [`POST ${BASE}`]: [
        [
          409,
          {
            code: "memory_lint_warning",
            message: "w",
            warnings: [{ code: "link_blocked", message: "Blocked link." }],
          },
        ],
        [
          409,
          {
            code: "memory_policy_conflict",
            message: "p",
            policy_conflicts: [{ id: ID2, version: 1 }],
          },
        ],
        [201, item()],
      ],
    });
    renderTeam(<MyMemoryPage />, MEMBER);
    await userEvent.type(await screen.findByLabelText("New memory"), "See example.com");
    await userEvent.click(screen.getByRole("button", { name: "Save memory" }));
    await userEvent.click(await screen.findByRole("button", { name: "Save anyway" }));
    await screen.findByText("This may contradict Site Policy");
    await userEvent.click(screen.getByRole("button", { name: "Save anyway" }));
    await screen.findByText("Memory saved.");
    expect(bodyOf(calls, "POST", BASE).overrides).toEqual({ lint: true, policy_conflict: true });
  });

  it("edits with the version it saw, focus follows, and Undo copies the version before", async () => {
    const calls = stubApi({
      ...groups([item({ version: 3 })]),
      [`PATCH ${BASE}/user/${ID}`]: [200, item({ version: 4, statement: "Prefers euros" })],
      [`POST ${BASE}/user/${ID}/revert`]: [200, item({ version: 5 })],
    });
    renderTeam(<MyMemoryPage />, MEMBER);
    await userEvent.click(
      await screen.findByRole("button", { name: "Edit: Prefers answers in euros" }),
    );
    const box = screen.getByLabelText("Memory text");
    await waitFor(() => expect(document.activeElement).toBe(box));
    await userEvent.clear(box);
    await userEvent.type(box, "Prefers euros");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Memory saved.");
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "Edit: Prefers euros" }),
      ),
    );
    expect(bodyOf(calls, "PATCH", `${BASE}/user/${ID}`)).toEqual({
      expected_version: 3,
      statement: "Prefers euros",
    });
    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    await screen.findByText("Undone.");
    expect(bodyOf(calls, "POST", `${BASE}/user/${ID}/revert`)).toEqual({
      version: 3,
      expected_version: 4,
    });
    expect(await screen.findByRole("listitem", { name: "Prefers answers in euros" })).toBeTruthy();
  });

  it("Cancel returns focus to Edit", async () => {
    stubApi(groups([item()]));
    renderTeam(<MyMemoryPage />, MEMBER);
    await userEvent.click(
      await screen.findByRole("button", { name: "Edit: Prefers answers in euros" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Edit: Prefers answers in euros" }),
    );
  });

  it("a conflict keeps the draft; Reload shows the saved text and saves over that version", async () => {
    const calls = stubApi({
      ...groups([item()]),
      [`PATCH ${BASE}/user/${ID}`]: [
        [409, { code: "memory_version_conflict", message: "moved", current_version: 2 }],
        [200, item({ version: 3, statement: "Mine!" })],
      ],
      [`GET ${BASE}/user/${ID}`]: [200, item({ version: 2, statement: "Theirs" })],
    });
    renderTeam(<MyMemoryPage />, MEMBER);
    await userEvent.click(
      await screen.findByRole("button", { name: "Edit: Prefers answers in euros" }),
    );
    const box = screen.getByLabelText("Memory text");
    await userEvent.clear(box);
    await userEvent.type(box, "Mine!");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText(/changed since you opened it/);
    await userEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect((await screen.findByTestId("saved-now")).textContent).toBe("Theirs");
    expect((screen.getByLabelText("Memory text") as HTMLTextAreaElement).value).toBe("Mine!");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Memory saved.");
    expect(bodyOf(calls, "PATCH", `${BASE}/user/${ID}`)).toEqual({
      expected_version: 2,
      statement: "Mine!",
    });
  });

  it("pins with a fixed name and aria-pressed; focus stays on Pin; pinned moves first", async () => {
    const calls = stubApi({
      ...groups([item({ id: ID3, statement: "Other" }), item()]),
      [`POST ${BASE}/user/${ID}/pin`]: [200, item({ pinned: true })],
    });
    renderTeam(<MyMemoryPage />, MEMBER);
    const pin = await screen.findByRole("button", { name: "Pin: Prefers answers in euros" });
    expect(pin.getAttribute("aria-pressed")).toBe("false");
    await userEvent.click(pin);
    await screen.findByText("Pinned.");
    const after = screen.getByRole("button", { name: "Pin: Prefers answers in euros" });
    expect(after.getAttribute("aria-pressed")).toBe("true");
    await waitFor(() => expect(document.activeElement).toBe(after));
    const rows = within(screen.getByRole("list", { name: ONLY_HERE })).getAllByRole("listitem");
    expect(rows[0]?.getAttribute("aria-label")).toBe("Prefers answers in euros");
    expect(screen.getByText(/1 of 10 pinned/)).toBeTruthy();
    expect(bodyOf(calls, "POST", `${BASE}/user/${ID}/pin`)).toEqual({
      pinned: true,
      expected_version: 1,
    });
  });

  it("a new change clears an earlier Undo's warning", async () => {
    stubApi({
      ...groups([item(), item({ id: ID3, statement: "Other" })]),
      [`POST ${BASE}/user/${ID}/archive`]: [200, item({ status: "archived" })],
      [`POST ${BASE}/user/${ID}/restore`]: [
        409,
        {
          code: "memory_lint_warning",
          message: "w",
          warnings: [{ code: "link_blocked", message: "Blocked link." }],
        },
      ],
      [`POST ${BASE}/user/${ID3}/pin`]: [200, item({ id: ID3, statement: "Other", pinned: true })],
    });
    renderTeam(<MyMemoryPage />, MEMBER);
    await userEvent.click(
      await screen.findByRole("button", { name: "Archive: Prefers answers in euros" }),
    );
    await userEvent.click(await screen.findByRole("button", { name: "Undo" }));
    await screen.findByText("Blocked link.");
    await userEvent.click(screen.getByRole("button", { name: "Pin: Other" }));
    await screen.findByText("Pinned.");
    expect(screen.queryByText("Blocked link.")).toBeNull();
    expect(screen.queryByRole("button", { name: "Save anyway" })).toBeNull();
  });

  it("withdraws Undo when the memory changed since", async () => {
    stubApi({
      ...groups([item()]),
      [`POST ${BASE}/user/${ID}/pin`]: [
        [200, item({ pinned: true })],
        [409, { code: "memory_version_conflict", message: "moved", current_version: 2 }],
      ],
    });
    renderTeam(<MyMemoryPage />, MEMBER);
    await userEvent.click(
      await screen.findByRole("button", { name: "Pin: Prefers answers in euros" }),
    );
    await userEvent.click(await screen.findByRole("button", { name: "Undo" }));
    await screen.findByText(/can no longer be undone/);
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("archives (focus to the group) and restores from the archive (focus to Archived)", async () => {
    const archived = item({ status: "archived" });
    const calls = stubApi({
      ...groups([item()]),
      [ARCHIVED("user")]: page("user", []),
      [`POST ${BASE}/user/${ID}/archive`]: [200, archived],
      [`POST ${BASE}/user/${ID}/restore`]: [200, item()],
    });
    renderTeam(<MyMemoryPage />, MEMBER);
    await userEvent.click(
      await screen.findByRole("button", { name: `Show archived (${ONLY_HERE})` }),
    );
    await screen.findByText("Nothing archived.");
    await userEvent.click(
      screen.getByRole("button", { name: "Archive: Prefers answers in euros" }),
    );
    await screen.findByText("Archived.");
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("heading", { name: ONLY_HERE })),
    );
    // Placed in the open archive without reloading it.
    const archive = await screen.findByRole("list", { name: `Archived: ${ONLY_HERE}` });
    await userEvent.click(
      within(archive).getByRole("button", { name: "Restore: Prefers answers in euros" }),
    );
    await screen.findByText("Restored.");
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Archived" })),
    );
    expect(bodyOf(calls, "POST", `${BASE}/user/${ID}/restore`)).toEqual({ expected_version: 1 });
    expect(calls.filter((c) => c.url === url("user", "archived"))).toHaveLength(1);
    expect(screen.getByRole("listitem", { name: "Prefers answers in euros" })).toBeTruthy();
  });

  it("names a full place and an off switch in Workspace words", async () => {
    stubApi({
      ...groups(),
      [LIST("user", true)]: [403, { code: "memory_disabled", message: "off" }],
      [`POST ${BASE}`]: [
        409,
        {
          code: "memory_scope_full",
          message: "full",
          capacity: { count: 300, max: 300, needed: 1 },
        },
      ],
    });
    renderTeam(<MyMemoryPage />, MEMBER);
    await screen.findByText("Memories are turned off for this workspace.");
    await userEvent.type(screen.getByLabelText("New memory"), "x");
    await userEvent.click(screen.getByRole("button", { name: "Save memory" }));
    await screen.findByText(/This place is full \(300 of 300 memories\)/);
  });

  it("refuses an over-long memory before sending it", async () => {
    const calls = stubApi(groups());
    renderTeam(<MyMemoryPage />, MEMBER);
    const box = await screen.findByLabelText("New memory");
    await userEvent.click(box);
    await userEvent.paste("a".repeat(501));
    await userEvent.click(screen.getByRole("button", { name: "Save memory" }));
    await screen.findByText(/at most 500 characters/);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });
});
