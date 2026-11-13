// @vitest-environment happy-dom
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { must } from "../../lib/testing/must";
import { forbidNativeConfirm, answerConfirm, renderTeam, stubApi } from "../admin/testing";
import { MyMemoryPage } from "./my-memory-page";

/** The Memory page's Memories tab: the Me editor (KOBE-384, ac-2, ac-3). */
const MEMBER = { role: "member", permissions: ["team.chat"] } as const;
const ID = "00000000-0000-4000-8000-00000000a001";
const ID2 = "00000000-0000-4000-8000-00000000a002";
const BASE = "/v1/memory/semantic/items";
const LIST = (scope: string, status = "active") =>
  `GET ${BASE}?scope=${scope}&status=${status}&limit=100`;

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
const list = (scope: string, items: unknown[], usage = { count: items.length, max: 1000 }) => [
  200,
  { scope, items, next_cursor: null, usage },
];
const empty = (scope: string) => list(scope, []);

const bodyOf = (
  calls: { method: string; url: string; body: unknown }[],
  method: string,
  url: string,
) =>
  JSON.parse(String(must(calls.filter((c) => c.method === method && c.url === url).at(-1)).body));

beforeEach(() => {
  forbidNativeConfirm();
  window.history.replaceState(null, "", "/me/memory");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

describe("Memory page tabs (ac-3)", () => {
  it("opens on Memories, and Notes holds the memory files; the address follows", async () => {
    stubApi({
      [LIST("user")]: empty("user") as never,
      [LIST("portable")]: empty("portable") as never,
      "GET /v1/memory?scope=user": [200, { docs: [] }],
    });
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
    expect(await screen.findByRole("heading", { name: "This workspace" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "All my workspaces" })).toBeTruthy();
    await userEvent.click(screen.getByRole("tab", { name: "Notes" }));
    await screen.findByText(/No memory files yet/);
    expect(window.location.search).toBe("?tab=notes");
    await userEvent.click(screen.getByRole("tab", { name: "Memories" }));
    expect(window.location.search).toBe("");
  });

  it("no wording says team: groups read This workspace and All my workspaces", async () => {
    stubApi({
      [LIST("user")]: list("user", [item()]) as never,
      [LIST("portable")]: list("portable", [
        item({ id: ID2, scope: "portable", tags: [] }),
      ]) as never,
    });
    const { container } = renderTeam(<MyMemoryPage />, MEMBER);
    await screen.findByRole("list", { name: "This workspace" });
    expect(container.textContent).not.toMatch(/\bteam\b/i);
  });
});

describe("Me editor (ac-2)", () => {
  it("lists both groups with kind, tags and pins, and says how full each is", async () => {
    stubApi({
      [LIST("user")]: list("user", [item({ pinned: true })], { count: 800, max: 1000 }) as never,
      [LIST("portable")]: list("portable", [], { count: 1000, max: 1000 }) as never,
    });
    renderTeam(<MyMemoryPage />, MEMBER);
    const row = await screen.findByRole("listitem", { name: "Prefers answers in euros" });
    expect(row.textContent).toContain("Preference");
    expect(row.textContent).toContain("Pinned");
    expect(row.textContent).toContain("money");
    expect(screen.getByText(/1 of 10 pinned/)).toBeTruthy();
    expect(screen.getByText(/800 of 1000 memories used/)).toBeTruthy();
    expect(screen.getByText(/1000 of 1000 memories\. Archive one/)).toBeTruthy();
  });

  it("adds a memory to this workspace and Undo archives it", async () => {
    const calls = stubApi({
      [LIST("user")]: [empty("user"), list("user", [item()])] as never,
      [LIST("portable")]: empty("portable") as never,
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
    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    await screen.findByText("Undone.");
    expect(bodyOf(calls, "POST", `${BASE}/user/${ID}/archive`)).toEqual({ expected_version: 1 });
  });

  it("asks 'Use in all my workspaces?' with the text before saving a portable preference", async () => {
    const calls = stubApi({
      [LIST("user")]: empty("user") as never,
      [LIST("portable")]: empty("portable") as never,
      [`POST ${BASE}`]: [201, item({ scope: "portable", tags: [] })],
    });
    renderTeam(<MyMemoryPage />, MEMBER);
    await userEvent.type(await screen.findByLabelText("New memory"), "Use metric units");
    await userEvent.click(screen.getByRole("checkbox", { name: /Use in all my workspaces/ }));
    await userEvent.click(screen.getByRole("button", { name: "Save memory" }));
    // Cancel: nothing is sent.
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
    stubApi({
      [LIST("user")]: empty("user") as never,
      [LIST("portable")]: empty("portable") as never,
    });
    renderTeam(<MyMemoryPage />, MEMBER);
    await screen.findByLabelText("New memory");
    expect(screen.getByRole("checkbox", { name: /Use in all my workspaces/ })).toBeTruthy();
    await userEvent.selectOptions(screen.getByLabelText("Kind"), "fact");
    expect(screen.queryByRole("checkbox", { name: /Use in all my workspaces/ })).toBeNull();
  });

  it("shows check warnings and a near-duplicate link inline, then saves anyway with the override", async () => {
    const calls = stubApi({
      [LIST("user")]: list("user", [item()]) as never,
      [LIST("portable")]: empty("portable") as never,
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

  it("never offers Save anyway for a secret", async () => {
    stubApi({
      [LIST("user")]: empty("user") as never,
      [LIST("portable")]: empty("portable") as never,
      [`POST ${BASE}`]: [422, { code: "memory_secret", message: "secret" }],
    });
    renderTeam(<MyMemoryPage />, MEMBER);
    await userEvent.type(await screen.findByLabelText("New memory"), "token abc");
    await userEvent.click(screen.getByRole("button", { name: "Save memory" }));
    await screen.findByText(/Memories never hold secrets/);
    expect(screen.queryByRole("button", { name: "Save anyway" })).toBeNull();
  });

  it("keeps the lint override when a Policy conflict follows", async () => {
    const calls = stubApi({
      [LIST("user")]: empty("user") as never,
      [LIST("portable")]: empty("portable") as never,
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

  it("edits with the version it saw, and Undo copies the version before", async () => {
    const calls = stubApi({
      [LIST("user")]: list("user", [item({ version: 3 })]) as never,
      [LIST("portable")]: empty("portable") as never,
      [`PATCH ${BASE}/user/${ID}`]: [200, item({ version: 4, statement: "Prefers euros" })],
      [`POST ${BASE}/user/${ID}/revert`]: [200, item({ version: 5 })],
    });
    renderTeam(<MyMemoryPage />, MEMBER);
    await userEvent.click(
      await screen.findByRole("button", { name: "Edit: Prefers answers in euros" }),
    );
    const box = screen.getByLabelText("Memory text");
    await userEvent.clear(box);
    await userEvent.type(box, "Prefers euros");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Memory saved.");
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
  });

  it("explains a conflicting edit and reloads", async () => {
    const calls = stubApi({
      [LIST("user")]: list("user", [item()]) as never,
      [LIST("portable")]: empty("portable") as never,
      [`PATCH ${BASE}/user/${ID}`]: [
        409,
        { code: "memory_version_conflict", message: "moved", current_version: 2 },
      ],
    });
    renderTeam(<MyMemoryPage />, MEMBER);
    await userEvent.click(
      await screen.findByRole("button", { name: "Edit: Prefers answers in euros" }),
    );
    await userEvent.type(screen.getByLabelText("Memory text"), "!");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText(/changed since you opened it/);
    const before = calls.filter((c) => c.url.includes("scope=user")).length;
    await userEvent.click(screen.getByRole("button", { name: "Reload" }));
    await waitFor(() =>
      expect(calls.filter((c) => c.url.includes("scope=user")).length).toBeGreaterThan(before),
    );
  });

  it("pins, archives (focus to the group) and restores from the archive, each undoable", async () => {
    const archived = item({ status: "archived" });
    const calls = stubApi({
      [LIST("user")]: list("user", [item()]) as never,
      [LIST("portable")]: empty("portable") as never,
      [LIST("user", "archived")]: list("user", [archived]) as never,
      [`POST ${BASE}/user/${ID}/pin`]: [200, item({ pinned: true })],
      [`POST ${BASE}/user/${ID}/archive`]: [200, archived],
      [`POST ${BASE}/user/${ID}/restore`]: [200, item()],
    });
    renderTeam(<MyMemoryPage />, MEMBER);
    await userEvent.click(
      await screen.findByRole("button", { name: "Pin: Prefers answers in euros" }),
    );
    await screen.findByText("Pinned.");
    expect(bodyOf(calls, "POST", `${BASE}/user/${ID}/pin`)).toEqual({
      pinned: true,
      expected_version: 1,
    });
    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    await screen.findByText("Undone.");
    expect(bodyOf(calls, "POST", `${BASE}/user/${ID}/pin`)).toEqual({
      pinned: false,
      expected_version: 1,
    });

    await userEvent.click(
      screen.getByRole("button", { name: "Archive: Prefers answers in euros" }),
    );
    await screen.findByText("Archived.");
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("heading", { name: "This workspace" })),
    );

    await userEvent.click(screen.getByRole("button", { name: "Show archived (This workspace)" }));
    const archive = await screen.findByRole("list", { name: "Archived: This workspace" });
    await userEvent.click(
      within(archive).getByRole("button", { name: "Restore: Prefers answers in euros" }),
    );
    await screen.findByText("Restored.");
    expect(bodyOf(calls, "POST", `${BASE}/user/${ID}/restore`)).toEqual({ expected_version: 1 });
  });

  it("names a full place and an off switch in Workspace words", async () => {
    stubApi({
      [LIST("user")]: [403, { code: "memory_disabled", message: "off" }],
      [LIST("portable")]: empty("portable") as never,
      [`POST ${BASE}`]: [
        409,
        {
          code: "memory_scope_full",
          message: "full",
          capacity: { count: 1000, max: 1000, needed: 1 },
        },
      ],
    });
    renderTeam(<MyMemoryPage />, MEMBER);
    await screen.findByText("Memories are turned off for this workspace.");
    await userEvent.type(screen.getByLabelText("New memory"), "x");
    await userEvent.click(screen.getByRole("button", { name: "Save memory" }));
    await screen.findByText(/This place is full \(1000 of 1000 memories\)/);
  });

  it("refuses an over-long memory before sending it", async () => {
    const calls = stubApi({
      [LIST("user")]: empty("user") as never,
      [LIST("portable")]: empty("portable") as never,
    });
    renderTeam(<MyMemoryPage />, MEMBER);
    const box = await screen.findByLabelText("New memory");
    await userEvent.click(box);
    await userEvent.paste("a".repeat(501));
    await userEvent.click(screen.getByRole("button", { name: "Save memory" }));
    await screen.findByText(/at most 500 characters/);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });
});
