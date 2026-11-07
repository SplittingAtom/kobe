// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LAKEHOUSE_DRAG_TYPE, LAKEHOUSE_DROP_REFUSED } from "../../lib/apps/lakehouse-drop";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
import { must } from "../../lib/testing/must";
import { ChatApp } from "./chat-app";
import { composer } from "./testing";

/**
 * KOBE-551: a Lakehouse Picker item dragged out of its frame onto the composer. While hovering
 * the panel lights up as for a file row; on drop a valid item puts its backticked identifier at
 * the caret and the same chip a click on the picker adds (the send carries it in `references`);
 * an invalid one is refused with a note and nothing goes in, the `text/plain` copy neither.
 */
let fake: FakeKobe;

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  fake = new FakeKobe();
  vi.stubGlobal("fetch", fake.fetch);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function mount(threadId: string) {
  window.history.replaceState(null, "", `/?thread=${threadId}`);
  return render(<ChatApp fetchFn={fake.fetch} eventSource={fake.eventSource} />);
}

const panel = () => must(document.querySelector<HTMLElement>("[data-kobe-composer-panel]"));
const hint = () => document.getElementById("kobe-composer-hint")?.textContent;
const chips = () =>
  screen
    .queryByRole("list", { name: "Items sent with your next message" })
    ?.querySelectorAll("li button[aria-label]") ?? [];
const chipLabels = () => [...chips()].map((b) => b.getAttribute("aria-label"));
const posts = () =>
  fake.requests
    .filter((r) => r.method === "POST" && /\/v1\/threads\/[^/]+\/messages$/.test(r.path))
    .map((r) => r.body as { content?: string; references?: unknown[] });

/** The drag as a sandboxed picker starts it: both types, the JSON only on drop. */
function transfer(data: Record<string, string>) {
  return {
    types: Object.keys(data),
    getData: (t: string) => data[t] ?? "",
    setData: () => undefined,
    effectAllowed: "copy",
    dropEffect: "none",
    files: [],
    items: [],
  };
}
const item = (payload: unknown, plain = "`mlb.lahman.batting`") =>
  transfer({ "text/plain": plain, [LAKEHOUSE_DRAG_TYPE]: JSON.stringify(payload) });

const TABLE = {
  kind: "table",
  catalog: "mlb",
  namespace: "lahman",
  name: "batting",
  identifier: "mlb.lahman.batting",
  uri: "catalyst://lakehouse/mlb/lahman/batting",
};

/** Drags `dt` over the composer and drops it: whether each event was taken, and the hover. */
function dropOnComposer(dt: ReturnType<typeof transfer>) {
  const overDefault = fireEvent.dragOver(panel(), { dataTransfer: dt });
  const hover = { drop: panel().getAttribute("data-mention-drop"), hint: hint() };
  const dropDefault = fireEvent.drop(panel(), { dataTransfer: dt });
  return { overTaken: !overDefault, dropTaken: !dropDefault, hover };
}

describe("drop a Lakehouse Picker item into the composer (KOBE-551)", () => {
  it("hovers like a file row; the drop inserts the identifier at the caret and the chip; the send carries it (ac-1, ac-3)", async () => {
    const user = userEvent.setup();
    mount(fake.addThread("Work"));
    const input = await composer();
    await user.type(input, "Count rows in");

    const { overTaken, dropTaken, hover } = dropOnComposer(item(TABLE));
    expect(overTaken).toBe(true);
    expect(hover).toEqual({ drop: "item", hint: "Drop to insert this item" });
    // Taken, so the browser's own text/plain insertion never adds a second copy.
    expect(dropTaken).toBe(true);
    expect(panel().hasAttribute("data-mention-drop")).toBe(false);

    await waitFor(() => expect(input.value).toBe("Count rows in `mlb.lahman.batting` "));
    expect(chipLabels()).toEqual(["Table mlb.lahman.batting, from Lakehouse Picker; remove"]);
    expect(panel().querySelector('[data-kobe-app-item="table"]')).not.toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(input));
    expect(input.selectionStart).toBe(input.value.length);

    await user.keyboard("{Enter}");
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]).toMatchObject({
      content: "Count rows in `mlb.lahman.batting`",
      references: [{ name: "mlb.lahman.batting", kind: "table" }],
    });
  });

  it("inserts at the caret, between the member's words", async () => {
    const user = userEvent.setup();
    mount(fake.addThread("Work"));
    const input = await composer();
    await user.type(input, "Join with on id");
    input.setSelectionRange(9, 9);
    dropOnComposer(item(TABLE));
    await waitFor(() => expect(input.value).toBe("Join with `mlb.lahman.batting` on id"));
    await waitFor(() =>
      expect(input.selectionStart).toBe("Join with `mlb.lahman.batting` ".length),
    );
  });

  it.each([
    [
      "view",
      {
        ...TABLE,
        kind: "view",
        name: "v_war",
        identifier: "mlb.lahman.v_war",
        uri: "catalyst://lakehouse/mlb/lahman/v_war",
      },
      "View mlb.lahman.v_war",
    ],
    [
      "namespace",
      {
        kind: "namespace",
        catalog: "mlb",
        namespace: "lahman",
        identifier: "mlb.lahman",
        uri: "catalyst://lakehouse/mlb/lahman",
      },
      "Namespace mlb.lahman",
    ],
    [
      "catalog",
      { kind: "catalog", catalog: "mlb", identifier: "mlb", uri: "catalyst://lakehouse/mlb" },
      "Catalog mlb",
    ],
  ])("a %s gets its own chip", async (kind, payload, label) => {
    mount(fake.addThread("Work"));
    const input = await composer();
    dropOnComposer(item(payload));
    await waitFor(() => expect(input.value).toBe(`\`${payload.identifier}\` `));
    expect(chipLabels()).toEqual([`${label}, from Lakehouse Picker; remove`]);
    expect(panel().querySelector(`[data-kobe-app-item="${kind}"]`)).not.toBeNull();
  });

  it("the same item twice: one chip, as for two clicks", async () => {
    mount(fake.addThread("Work"));
    const input = await composer();
    dropOnComposer(item(TABLE));
    await waitFor(() => expect(chipLabels()).toHaveLength(1));
    dropOnComposer(item(TABLE));
    await waitFor(() => expect(input.value).toBe("`mlb.lahman.batting` `mlb.lahman.batting` "));
    expect(chipLabels()).toHaveLength(1);
  });

  it.each([
    ["a bad kind", { ...TABLE, kind: "column" }],
    [
      "a bad segment",
      {
        ...TABLE,
        name: "Bad Name`",
        identifier: "mlb.lahman.Bad Name`",
        uri: "catalyst://lakehouse/mlb/lahman/Bad Name`",
      },
    ],
    ["an identifier that is not the segments", { ...TABLE, identifier: "mlb.lahman.pitching" }],
    [
      "a uri that is not the segments",
      { ...TABLE, uri: "catalyst://lakehouse/mlb/lahman/pitching" },
    ],
    [
      "an oversized identifier",
      {
        ...TABLE,
        name: "a".repeat(600),
        identifier: `mlb.lahman.${"a".repeat(600)}`,
        uri: `catalyst://lakehouse/mlb/lahman/${"a".repeat(600)}`,
      },
    ],
  ])(
    "refuses %s with a note; nothing goes in, the text/plain copy neither (ac-2)",
    async (_l, payload) => {
      const user = userEvent.setup();
      mount(fake.addThread("Work"));
      const input = await composer();
      await user.type(input, "Hello");
      const { dropTaken } = dropOnComposer(item(payload));
      expect(dropTaken).toBe(true);
      await waitFor(() => expect(hint()).toBe(LAKEHOUSE_DROP_REFUSED));
      expect(
        within(must(document.getElementById("kobe-composer-hint"))).getByRole("status").textContent,
      ).toBe(LAKEHOUSE_DROP_REFUSED);
      expect(input.value).toBe("Hello");
      expect(chips()).toHaveLength(0);
      // The next key press clears the note.
      await user.type(input, "!");
      expect(hint()).not.toBe(LAKEHOUSE_DROP_REFUSED);
    },
  );

  it("a plain text drag is not ours: no hover, the browser keeps it (ac-1)", async () => {
    mount(fake.addThread("Work"));
    const input = await composer();
    const { overTaken, dropTaken, hover } = dropOnComposer(
      transfer({ "text/plain": "`mlb.lahman.batting`" }),
    );
    expect(overTaken).toBe(false);
    expect(dropTaken).toBe(false);
    expect(hover.drop).toBeNull();
    expect(input.value).toBe("");
    expect(chips()).toHaveLength(0);
  });

  it("a reader of a shared thread, or a thread in Trash, has no drop target (ac-4)", async () => {
    const shared = fake.addThread("Shared");
    Object.assign(must(fake.threads.get(shared)), { read_only: true, owner_name: "Alice" });
    fake.addEntry(shared, null, { role: "user", content: "from the author" });
    mount(shared);
    const note = await screen.findByText(/You are reading a shared conversation/);
    expect(document.querySelector("[data-kobe-composer-panel]")).toBeNull();
    expect(fireEvent.drop(note, { dataTransfer: item(TABLE) })).toBe(true);
    expect(screen.queryByRole("list", { name: "Items sent with your next message" })).toBeNull();
    cleanup();

    const trashed = fake.addThread("Old");
    must(fake.threads.get(trashed)).deleted_at = "2026-11-01T10:00:00.000Z";
    mount(trashed);
    const trash = await screen.findByText(/This conversation is in Trash/);
    expect(document.querySelector("[data-kobe-composer-panel]")).toBeNull();
    expect(fireEvent.drop(trash, { dataTransfer: item(TABLE) })).toBe(true);
    expect(within(document.body).queryByText("mlb.lahman.batting")).toBeNull();
  });
});
