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

/** KOBE-535 (TL3, TL4): the lineage strip above the conversation. */
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function view(lineage: ThreadLineageResponse, compact = false, onOpenThread = vi.fn()) {
  render(
    <div data-kobe-chat>
      <LineageStripView
        lineage={lineage}
        excerpt="Redo Q3 with the new rates"
        compact={compact}
        onOpenThread={onOpenThread}
      />
    </div>,
  );
  return onOpenThread;
}

const strip = () => screen.getByRole("navigation", { name: "Thread lineage" });
const rows = () => within(strip()).getAllByRole("listitem");

async function openMenu(name: string | RegExp) {
  await userEvent.setup().click(within(strip()).getByRole("button", { name }));
  return screen.findByRole("menu");
}

describe("the rows (ac-1)", () => {
  it("a plain fork: its source as a link, then the thread on screen with its fork point", () => {
    view(lineageOf({ ancestors: [ancestor(1, "Budget 2027")] }));
    const [root, self] = rows();
    expect(within(must(root)).getByRole("link", { name: "Budget 2027" }).getAttribute("href")).toBe(
      `/?thread=${tid(1)}`,
    );
    expect(rows()).toHaveLength(2);
    expect(within(must(self)).queryByRole("link")).toBeNull();
    expect(within(must(self)).getByText("Try the Q3 numbers").tagName).toBe("STRONG");
    expect(self?.textContent).toBe("Try the Q3 numbers at “Redo Q3 with the new rates”");
  });

  it("a family with siblings: '2 of 3', newest first, the one in the path checked", async () => {
    const sibs = [relative(3, "Sales cut"), relative(2, "Marketing cut"), relative(4, "Ops cut")];
    const open = view(
      lineageOf({ ancestors: [ancestor(1, "Budget 2027"), ancestor(2, "Marketing cut", sibs)] }),
    );
    expect(within(must(rows()[0])).queryByRole("button")).toBeNull();
    const menu = await openMenu("Marketing cut · 2 of 3");
    const items = within(menu).getAllByRole("menuitemradio");
    expect(items.map((i) => [i.textContent, i.getAttribute("aria-checked")])).toEqual([
      ["Sales cut", "false"],
      ["Marketing cut", "true"],
      ["Ops cut", "false"],
    ]);
    expect(menu.closest("[data-kobe-chat]")).not.toBeNull();
    await userEvent.setup().click(must(items[0]));
    expect(open).toHaveBeenCalledWith(tid(3));
  });

  it("counts a cut sibling list as 50+", () => {
    const sibs = [relative(2, "Mine"), relative(3, "Other")];
    view(
      lineageOf({
        ancestors: [ancestor(1, "Root")],
        selfSiblings: [relative(5, "x"), relative(99, "y")],
      }),
    );
    expect(within(strip()).getByRole("button").textContent).toContain("2 of 2");
    cleanup();
    view(
      lineageOf({ ancestors: [ancestor(1, "Root"), ancestor(2, "Mine", sibs, { more: true })] }),
    );
    expect(within(strip()).getByRole("button", { name: "Mine · 1 of 50+" })).toBeTruthy();
  });

  it("forks of the thread on screen: '2 forks' newest first; one fork is a plain link", async () => {
    const open = view(lineageOf({ forks: [relative(7, "Newer"), relative(6, "Older")] }));
    expect(rows()).toHaveLength(2);
    const menu = await openMenu("2 forks");
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((i) => i.textContent),
    ).toEqual(["Newer", "Older"]);
    await userEvent.setup().click(within(menu).getByRole("menuitem", { name: "Older" }));
    expect(open).toHaveBeenCalledWith(tid(6));
    cleanup();
    view(lineageOf({ forks: [relative(7, "Only child")] }));
    const last = must(rows().at(-1));
    expect(last.textContent).toBe("1 fork: Only child");
    expect(within(last).getByRole("link", { name: "Only child" })).toBeTruthy();
  });

  it("a hidden root: a first muted row that is not a link", () => {
    view(lineageOf({ rootHidden: true }));
    const [hidden, self] = rows();
    expect(hidden?.textContent).toBe("a thread you can't open");
    expect(within(strip()).queryByRole("link")).toBeNull();
    expect(self?.textContent).toContain("Try the Q3 numbers at “Redo Q3");
  });

  it("a purged root: nothing extra, the chain starts lower", () => {
    view(lineageOf({ ancestors: [ancestor(2, "Middle")] }));
    expect(rows().map((r) => r.textContent)).toEqual([
      "Middle",
      "Try the Q3 numbers at “Redo Q3 with the new rates”",
    ]);
    cleanup();
    // Its only source purged: an ordinary-looking thread, nothing shown.
    view(lineageOf({ forkedAt: "e-fork" }));
    expect(screen.queryByRole("navigation")).toBeNull();
  });

  it("folds at five generations: root, '… 3 more', parent, self", async () => {
    const open = view(
      lineageOf({ ancestors: [1, 2, 3, 4, 5].map((n) => ancestor(n, `Gen ${n}`)) }),
    );
    expect(rows().map((r) => r.textContent)).toEqual([
      "Gen 1",
      "… 3 more",
      "Gen 5",
      "Try the Q3 numbers at “Redo Q3 with the new rates”",
    ]);
    const menu = await openMenu("… 3 more");
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((i) => i.textContent),
    ).toEqual(["Gen 2", "Gen 3", "Gen 4"]);
    await userEvent.setup().click(within(menu).getByRole("menuitem", { name: "Gen 3" }));
    expect(open).toHaveBeenCalledWith(tid(3));
  });

  it("marks a thread in Trash, in a row and in a menu", async () => {
    view(
      lineageOf({
        ancestors: [ancestor(1, "Old budget", [], { inTrash: true })],
        forks: [relative(7, "Gone", true), relative(8, "Here")],
      }),
    );
    expect(rows()[0]?.textContent).toBe("Old budget · In Trash");
    const menu = await openMenu("2 forks");
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((i) => i.textContent),
    ).toEqual(["Gone · In Trash", "Here"]);
  });

  it("is one line under 820 px, its menu holding the whole family in order", async () => {
    const sibs = [relative(5, "Other"), relative(2, "Mid")];
    const open = view(
      lineageOf({
        ancestors: [ancestor(1, "Root"), ancestor(2, "Mid", sibs)],
        forks: [relative(8, "Child")],
      }),
      true,
    );
    expect(within(strip()).queryAllByRole("listitem")).toEqual([]);
    const menu = await openMenu("Forked thread · 4 related");
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

  it("renders titles as text, never HTML", () => {
    view(lineageOf({ ancestors: [ancestor(1, "<img src=x onerror=alert(1)>")] }));
    expect(strip().querySelector("img")).toBeNull();
    expect(rows()[0]?.textContent).toBe("<img src=x onerror=alert(1)>");
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
  it("opens a linked thread in place through OpenThreadContext", async () => {
    const { source } = fakeSource([lineageOf({ ancestors: [ancestor(1, "Budget 2027")] })]);
    const openThread = connected(source);
    const link = await screen.findByRole("link", { name: "Budget 2027" });
    await userEvent.setup().click(link);
    expect(openThread).toHaveBeenCalledWith(tid(1));
  });

  it("leaves a modified or middle click to the browser", async () => {
    const { source } = fakeSource([lineageOf({ ancestors: [ancestor(1, "Budget 2027")] })]);
    const openThread = connected(source);
    const link = await screen.findByRole("link", { name: "Budget 2027" });
    let prevented: boolean[] = [];
    const record = (e: Event) => {
      prevented = [...prevented, e.defaultPrevented];
      e.preventDefault();
    };
    window.addEventListener("click", record);
    try {
      for (const mods of [
        { metaKey: true },
        { ctrlKey: true },
        { shiftKey: true },
        { altKey: true },
      ]) {
        link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...mods }));
      }
      link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 1 }));
    } finally {
      window.removeEventListener("click", record);
    }
    expect(prevented).toEqual([false, false, false, false, false]);
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
    expect(await screen.findByRole("link", { name: "Quarterly plan" })).toBeTruthy();
  });
});

describe("accessibility (ac-5)", () => {
  it("is a navigation landmark the keyboard walks through, links and menus alike", async () => {
    const sibs = [relative(3, "Sales cut"), relative(2, "Marketing cut")];
    const open = view(
      lineageOf({
        ancestors: [ancestor(1, "Budget 2027"), ancestor(2, "Marketing cut", sibs)],
        forks: [relative(7, "A"), relative(8, "B")],
      }),
    );
    const user = userEvent.setup();
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("link", { name: "Budget 2027" }));
    await user.tab();
    const siblings = screen.getByRole("button", { name: "Marketing cut · 2 of 2" });
    expect(document.activeElement).toBe(siblings);
    expect(siblings.getAttribute("aria-haspopup")).toBe("menu");
    await user.tab();
    const forks = screen.getByRole("button", { name: "2 forks" });
    expect(document.activeElement).toBe(forks);
    await user.keyboard("{Enter}");
    const menu = await screen.findByRole("menu");
    expect(document.activeElement?.textContent).toBe("A");
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement?.textContent).toBe("B");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(forks);
    expect(menu.isConnected).toBe(false);
    await user.keyboard("{Enter}");
    await screen.findByRole("menu");
    await user.keyboard("{Enter}");
    expect(open).toHaveBeenCalledWith(tid(7));
  });
});
