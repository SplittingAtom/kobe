// @vitest-environment happy-dom
import { act, cleanup, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ThreadLineageResponse } from "@kobe/protocol";
import type { ChatSession } from "../../lib/chat/session";
import { initialThreadState } from "../../lib/chat/thread-state";
import type { Projection } from "../../lib/chat/tree";
import { LINEAGE_REREAD_MS } from "../../lib/chat/lineage";
import { useLineage, type LineageSource } from "../../lib/chat/use-lineage";
import { SELF, ancestor, lineageOf, relative, tid } from "../../lib/chat/testing/lineage-fixtures";
import { must } from "../../lib/testing/must";
import { OpenThreadContext } from "./fork-dialog";
import { ChatSessionContext, type KobeThreadExtras } from "./kobe-runtime";
import { LineageStrip, LineageStripView } from "./lineage-strip";

/** KOBE-535 (TL3, TL4): the lineage chip above the conversation (TL3 as amended 2026-11-06). */
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function view(lineage: ThreadLineageResponse, onOpenThread = vi.fn()) {
  render(
    <div data-kobe-chat>
      <LineageStripView lineage={lineage} onOpenThread={onOpenThread} />
    </div>,
  );
  return onOpenThread;
}

const strip = () => screen.getByRole("navigation", { name: "Thread lineage" });
/** The one chip: a menu button. */
const chip = () => within(strip()).getByRole("button");

async function openMenu() {
  await userEvent.setup().click(chip());
  return screen.findByRole("menu");
}

/** The menu's choices as [text, checked]. */
const choices = (menu: HTMLElement) =>
  within(menu)
    .getAllByRole("menuitemcheckbox")
    .map((i) => [i.textContent, i.getAttribute("aria-checked")]);

/** TL3 as amended by Chris (2026-11-06): one chip, the fork icon first, its menu the family. */
describe("the chip (ac-1)", () => {
  it("a plain fork: one chip naming the parent, fork icon first, inverted and sharp", async () => {
    const open = view(lineageOf({ ancestors: [ancestor(1, "Budget 2027")] }));
    expect(within(strip()).queryAllByRole("listitem")).toEqual([]);
    expect(within(strip()).queryByRole("link")).toBeNull();
    const button = chip();
    expect(button).toBe(within(strip()).getByRole("button", { name: "Forked from Budget 2027" }));
    expect(button.getAttribute("aria-haspopup")).toBe("menu");
    expect(button.firstElementChild?.tagName.toLowerCase()).toBe("svg");
    for (const cls of ["rounded-none", "bg-foreground", "text-background"]) {
      expect(button.className).toContain(cls);
    }
    const menu = await openMenu();
    expect(choices(menu)).toEqual([
      ["Budget 2027", "true"],
      ["Try the Q3 numbers", "true"],
    ]);
    expect(menu.closest("[data-kobe-chat]")).not.toBeNull();
    await userEvent
      .setup()
      .click(within(menu).getByRole("menuitemcheckbox", { name: "Budget 2027" }));
    expect(open).toHaveBeenCalledWith(tid(1));
  });

  it("a family with siblings: every generation with its siblings, the path checked", async () => {
    const sibs = [relative(5, "Other"), relative(2, "Mid")];
    const open = view(
      lineageOf({
        ancestors: [ancestor(1, "Root"), ancestor(2, "Mid", sibs)],
        forks: [relative(8, "Child")],
      }),
    );
    expect(chip().textContent).toBe("Forked from Mid");
    const menu = await openMenu();
    const items = within(menu).getAllByRole("menuitemcheckbox");
    expect(items.map((i) => [i.textContent, i.getAttribute("aria-checked")])).toEqual([
      ["Root", "true"],
      ["Other", "false"],
      ["Mid", "true"],
      ["Try the Q3 numbers", "true"],
      ["Child", "false"],
    ]);
    // Indented one step per generation.
    expect(items.map((i) => i.style.paddingInlineStart)).toEqual([
      "0.5rem",
      "1.5rem",
      "1.5rem",
      "2.5rem",
      "3.5rem",
    ]);
    await userEvent.setup().click(must(items[1]));
    expect(open).toHaveBeenCalledWith(tid(5));
  });

  it("forks of a root: the chip counts them; the thread on screen stays a checked item", async () => {
    const open = view(lineageOf({ forks: [relative(7, "Newer"), relative(6, "Older")] }));
    expect(within(strip()).getByRole("button", { name: "2 forks" })).toBeTruthy();
    const menu = await openMenu();
    expect(choices(menu)).toEqual([
      ["Try the Q3 numbers", "true"],
      ["Newer", "false"],
      ["Older", "false"],
    ]);
    await userEvent.setup().click(within(menu).getByRole("menuitemcheckbox", { name: "Older" }));
    expect(open).toHaveBeenCalledWith(tid(6));
    cleanup();
    view(lineageOf({ forks: [relative(7, "Only child")] }));
    expect(within(strip()).getByRole("button", { name: "1 fork" })).toBeTruthy();
  });

  it("a hidden root: the chip says so; the menu's first item is muted and not a choice", async () => {
    view(lineageOf({ rootHidden: true }));
    expect(chip().textContent).toBe("Forked from a thread you can't open");
    const menu = await openMenu();
    const hidden = within(menu).getByRole("menuitem", { name: "a thread you can't open" });
    expect(hidden.getAttribute("aria-disabled")).toBe("true");
    expect(choices(menu)).toEqual([["Try the Q3 numbers", "true"]]);
  });

  it("a purged root: the chip names the next ancestor; a thread whose only source is gone shows nothing", () => {
    view(lineageOf({ ancestors: [ancestor(2, "Middle")] }));
    expect(chip().textContent).toBe("Forked from Middle");
    cleanup();
    view(lineageOf({ forkedAt: "e-fork" }));
    expect(screen.queryByRole("navigation")).toBeNull();
  });

  it("a deep family is not folded: the menu lists every generation in order", async () => {
    const open = view(
      lineageOf({ ancestors: [1, 2, 3, 4, 5].map((n) => ancestor(n, `Gen ${n}`)) }),
    );
    expect(chip().textContent).toBe("Forked from Gen 5");
    const menu = await openMenu();
    expect(choices(menu).map(([text]) => text)).toEqual([
      "Gen 1",
      "Gen 2",
      "Gen 3",
      "Gen 4",
      "Gen 5",
      "Try the Q3 numbers",
    ]);
    await userEvent.setup().click(within(menu).getByRole("menuitemcheckbox", { name: "Gen 3" }));
    expect(open).toHaveBeenCalledWith(tid(3));
  });

  it("marks a thread in Trash, on the chip and in the menu", async () => {
    view(
      lineageOf({
        ancestors: [ancestor(1, "Old budget", [], { inTrash: true })],
        forks: [relative(7, "Gone", true), relative(8, "Here")],
      }),
    );
    expect(chip().textContent).toBe("Forked from Old budget · In Trash");
    const menu = await openMenu();
    expect(choices(menu).map(([text]) => text)).toEqual([
      "Old budget · In Trash",
      "Try the Q3 numbers",
      "Gone · In Trash",
      "Here",
    ]);
  });

  it("renders titles as text, never HTML", () => {
    view(lineageOf({ ancestors: [ancestor(1, "<img src=x onerror=alert(1)>")] }));
    expect(strip().querySelector("img")).toBeNull();
    expect(chip().textContent).toBe("Forked from <img src=x onerror=alert(1)>");
  });
});

/** A chat session stand-in: answers the reads in turn, and fires the TL4 signals. */
function fakeSource(answers: readonly (ThreadLineageResponse | null)[]) {
  const queue = [...answers];
  const created = new Set<() => void>();
  const trash = new Set<() => void>();
  const reads: string[] = [];
  const source = {
    api: {
      threadLineage: async (id: string) => {
        reads.push(id);
        return (queue.length > 1 ? queue.shift() : queue[0]) ?? null;
      },
    },
    onThreadCreated: (l: () => void) => {
      created.add(l);
      return () => created.delete(l);
    },
    onThreadTrashChanged: (l: () => void) => {
      trash.add(l);
      return () => trash.delete(l);
    },
  } satisfies LineageSource;
  return {
    source,
    reads,
    forked: () => act(() => created.forEach((l) => l())),
    trashed: () => act(() => trash.forEach((l) => l())),
  };
}

const EMPTY: Projection = {
  items: [],
  headId: null,
  nodeOfEntry: new Map(),
  lastEntryOfNode: new Map(),
  loaded: new Set(),
};

function connected(source: LineageSource, openThread = vi.fn(), threadId = SELF) {
  const extras: KobeThreadExtras = {
    controller: null,
    state: initialThreadState(threadId),
    projection: EMPTY,
  };
  render(
    <div data-kobe-chat>
      <ChatSessionContext.Provider value={source as unknown as ChatSession}>
        <OpenThreadContext.Provider value={openThread}>
          <LineageStrip extras={extras} />
        </OpenThreadContext.Provider>
      </ChatSessionContext.Provider>
    </div>,
  );
  return openThread;
}

describe("opening threads (ac-2)", () => {
  it("opens a thread chosen in the chip's menu in place through OpenThreadContext", async () => {
    const { source } = fakeSource([lineageOf({ ancestors: [ancestor(1, "Budget 2027")] })]);
    const openThread = connected(source);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Forked from Budget 2027" }));
    await user.click(await screen.findByRole("menuitemcheckbox", { name: "Budget 2027" }));
    expect(openThread).toHaveBeenCalledWith(tid(1));
  });

  it("choosing the thread on screen opens nothing", async () => {
    const { source } = fakeSource([lineageOf({ ancestors: [ancestor(1, "Budget 2027")] })]);
    const openThread = connected(source);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Forked from Budget 2027" }));
    await user.click(await screen.findByRole("menuitemcheckbox", { name: "Try the Q3 numbers" }));
    expect(openThread).not.toHaveBeenCalled();
  });
});

describe("when there is nothing to show (ac-3)", () => {
  it("renders nothing for an ordinary thread", async () => {
    const { source, reads } = fakeSource([lineageOf()]);
    connected(source);
    await waitFor(() => expect(reads).toEqual([SELF]));
    expect(screen.queryByRole("navigation")).toBeNull();
  });

  it("renders nothing for a failed read, and reads again on focus", async () => {
    const { source, reads } = fakeSource([null, lineageOf({ ancestors: [ancestor(1, "Budget")] })]);
    connected(source);
    await waitFor(() => expect(reads).toHaveLength(1));
    expect(screen.queryByRole("navigation")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(await screen.findByRole("navigation", { name: "Thread lineage" })).toBeTruthy();
    expect(reads).toHaveLength(2);
  });
});

describe("when it reads (ac-4, TL4)", () => {
  it("reads on open, after a fork, after a trash or restore, and on a stale focus", async () => {
    const { source, reads, forked, trashed } = fakeSource([lineageOf()]);
    let clock = 1_000;
    const { rerender } = renderHook(({ id }) => useLineage(id, source, () => clock), {
      initialProps: { id: SELF as string | null },
    });
    await waitFor(() => expect(reads).toEqual([SELF]));
    forked();
    trashed();
    await waitFor(() => expect(reads).toHaveLength(3));
    // Focus re-reads only once the last read is a minute old.
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    clock += LINEAGE_REREAD_MS;
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(reads).toHaveLength(4));
    // Opening another thread reads its lineage; no thread, no read.
    rerender({ id: tid(5) });
    await waitFor(() => expect(reads.at(-1)).toBe(tid(5)));
    rerender({ id: null });
    forked();
    expect(reads).toHaveLength(5);
  });

  it("shows the new source after a fork without a reload", async () => {
    const before = lineageOf();
    const after = lineageOf({ ancestors: [ancestor(1, "Quarterly plan")] });
    const { source, forked } = fakeSource([before, after]);
    connected(source);
    await waitFor(() => expect(screen.queryByRole("navigation")).toBeNull());
    forked();
    expect(await screen.findByRole("button", { name: "Forked from Quarterly plan" })).toBeTruthy();
  });
});

describe("accessibility (ac-5)", () => {
  it("is a navigation landmark: the chip takes focus, its menu walks with the keys", async () => {
    const sibs = [relative(3, "Sales cut"), relative(2, "Marketing cut")];
    const open = view(
      lineageOf({
        ancestors: [ancestor(1, "Budget 2027"), ancestor(2, "Marketing cut", sibs)],
        forks: [relative(7, "A"), relative(8, "B")],
      }),
    );
    const user = userEvent.setup();
    await user.tab();
    const button = screen.getByRole("button", { name: "Forked from Marketing cut" });
    expect(document.activeElement).toBe(button);
    expect(button.getAttribute("aria-haspopup")).toBe("menu");
    await user.keyboard("{Enter}");
    const menu = await screen.findByRole("menu");
    expect(document.activeElement?.textContent).toBe("Budget 2027");
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement?.textContent).toBe("Sales cut");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(button);
    expect(menu.isConnected).toBe(false);
    await user.keyboard("{Enter}");
    await screen.findByRole("menu");
    await user.keyboard("{End}");
    expect(document.activeElement?.textContent).toBe("B");
    await user.keyboard("{Enter}");
    expect(open).toHaveBeenCalledWith(tid(8));
  });
});
