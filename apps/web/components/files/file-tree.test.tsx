// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFilesApi, type FileEntry } from "../../lib/files/api";
import { expandedKey, FOLDER_PAGE_ROWS } from "../../lib/files/tree";
import { must } from "../../lib/testing/must";
import { IconActionProvider } from "../shell/icon-action";
import { FileBrowser } from "./file-browser";
import { TREE_DRAG_TYPE } from "./file-tree";

/**
 * KOBE-304: the Files tree on its own (the rail and the artifact column are covered by
 * rail-files.test and file-viewer.test): lazy folders, remembered expansion, icons, the ARIA tree
 * keys, read-only project mounts, Show more, drag and drop, Move to…, Rename and computer drops.
 */
const TEAM = "00000000-0000-4000-8000-0000000000aa";
const THREAD_UPLOADS = "uploads/0b7f3c1e-2d4a-4e5b-8c6d-7e8f9a0b1c2d";

interface Seen {
  readonly method: string;
  readonly url: string;
  readonly body?: unknown;
}

/** An in-memory workspace behind the files API: path -> size. */
let files: Map<string, number>;
let seen: Seen[];
let pageSize: number;
let overrides: Record<string, () => Response>;

const areaOf = (path: string) =>
  path === "uploads" || path.startsWith("uploads/")
    ? "uploads"
    : path === "projects" || path.startsWith("projects/")
      ? "projects"
      : "workspace";

function children(dir: string) {
  const prefix = dir === "" ? "" : `${dir}/`;
  const out = new Map<string, "file" | "dir">();
  for (const path of files.keys()) {
    if (!path.startsWith(prefix)) continue;
    const [head, ...rest] = path.slice(prefix.length).split("/");
    out.set(`${prefix}${head}`, rest.length > 0 ? "dir" : "file");
  }
  return [...out]
    .sort(([a, ta], [b, tb]) => (ta === tb ? (a < b ? -1 : 1) : ta === "dir" ? -1 : 1))
    .map(([path, type]) => ({
      name: path.slice(path.lastIndexOf("/") + 1),
      path,
      type,
      size_bytes: type === "dir" ? null : (files.get(path) ?? 0),
      mtime: "2026-10-01T10:00:00Z",
      source: "synced",
      owner: areaOf(path) === "workspace" ? "sandbox" : "server",
      area: areaOf(path),
    }));
}

const readOnly = (path: string) =>
  areaOf(path) !== "workspace" && !/^uploads\/[^/]+$/.test(path.replace(THREAD_UPLOADS, "x/x"));
const taken = (path: string) =>
  [...files.keys()].some((p) => p === path || p.startsWith(`${path}/`));
const json = (body: unknown, status = 200) => Response.json(body, { status });

const fetchFn: typeof fetch = async (input, init = {}) => {
  const url = new URL(String(input), "http://kobe.test");
  const method = init.method ?? "GET";
  const body = typeof init.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
  seen.push({ method, url: `${url.pathname}${url.search}`, ...(body ? { body } : {}) });
  const override = overrides[`${method} ${url.pathname}`];
  if (override) return override();
  if (url.pathname === "/v1/workspace/wake") return json({ status: "waking" }, 202);
  if (method === "GET" && url.pathname === "/v1/workspace/files") {
    const path = url.searchParams.get("path") ?? "";
    const all = children(path);
    if (path !== "" && all.length === 0) return json({ code: "not_found", message: "No." }, 404);
    const at = Number(url.searchParams.get("cursor") ?? "0");
    const page = all.slice(at, at + pageSize);
    return json({
      path,
      entries: page,
      ...(at + pageSize < all.length ? { next_cursor: String(at + pageSize) } : {}),
    });
  }
  if (method === "POST" && url.pathname === "/v1/workspace/files/move") {
    const { from, to } = body as { from: string; to: string };
    if (!taken(from)) return json({ code: "not_found", message: "No such file or folder." }, 404);
    if (readOnly(from) || readOnly(to)) {
      return json({ code: "read_only", message: "Project files are read-only here." }, 403);
    }
    if (taken(to)) {
      const name = to.slice(to.lastIndexOf("/") + 1);
      return json(
        { code: "already_exists", message: `Something named ${name} is already there.` },
        409,
      );
    }
    const moved = [...files].filter(([p]) => p === from || p.startsWith(`${from}/`));
    for (const [p, size] of moved) {
      files.delete(p);
      files.set(`${to}${p.slice(from.length)}`, size);
    }
    const type = moved.length === 1 && moved[0]?.[0] === from ? "file" : "dir";
    return json({ from, to, type, files: moved.length });
  }
  if (method === "POST" && url.pathname === "/v1/workspace/files") {
    const form = init.body as FormData;
    const folder = String(form.get("path") ?? "");
    const file = form.get("file") as File;
    const path = folder === "" ? file.name : `${folder}/${file.name}`;
    files.set(path, file.size);
    return json(
      children(folder).find((e) => e.path === path),
      201,
    );
  }
  return new Response(null, { status: 500 });
};

function mount(props: Partial<Parameters<typeof FileBrowser>[0]> = {}) {
  return render(
    <div data-kobe-chat>
      <IconActionProvider>
        <FileBrowser api={createFilesApi(TEAM, fetchFn)} refreshAfterWakeMs={60_000} {...props} />
      </IconActionProvider>
    </div>,
  );
}

const tree = () => screen.getByRole("tree", { name: "Files in your workspace" });
const item = (name: string) => within(tree()).getByRole("treeitem", { name });
const findItem = (name: string) => within(tree()).findByRole("treeitem", { name });
const names = () =>
  within(tree())
    .queryAllByRole("treeitem")
    .map(
      (r) =>
        `${"  ".repeat(Number(r.getAttribute("aria-level")) - 1)}${r.getAttribute("aria-label")}`,
    );
const listed = (path: string) =>
  seen.filter(
    (s) => s.method === "GET" && s.url === `/v1/workspace/files?path=${encodeURIComponent(path)}`,
  ).length;
const moves = () => seen.filter((s) => s.url === "/v1/workspace/files/move").map((s) => s.body);

/** A DataTransfer good enough for happy-dom drag events. */
function transfer(types: string[] = [], filesList: File[] = []) {
  const data = new Map<string, string>();
  return {
    get types() {
      return [...types, ...data.keys()];
    },
    setData: (t: string, v: string) => data.set(t, v),
    getData: (t: string) => data.get(t) ?? "",
    effectAllowed: "all",
    dropEffect: "none",
    files: filesList,
    items: filesList.map((f) => ({
      kind: "file",
      getAsFile: () => f,
      webkitGetAsEntry: () => null,
    })),
  };
}

function drag(from: HTMLElement, to: HTMLElement) {
  const dt = transfer();
  fireEvent.dragStart(from, { dataTransfer: dt });
  fireEvent.dragOver(to, { dataTransfer: dt });
  // The folder that would take it lights up (a file row's own folder, or the top-level row).
  const highlighted = document.querySelector("[data-drop-target]") !== null;
  fireEvent.drop(to, { dataTransfer: dt });
  fireEvent.dragEnd(from, { dataTransfer: dt });
  return highlighted;
}

beforeEach(() => {
  localStorage.clear();
  files = new Map([
    ["notes/todo.md", 10],
    ["notes/2026/plan.md", 20],
    ["data/sales.csv", 2048],
    ["projects/plan/spec.md", 5],
    [`${THREAD_UPLOADS}/brief.pdf`, 7],
    ["uploads/drop.pdf", 9],
    ["report.csv", 2048],
    ["main.py", 30],
  ]);
  seen = [];
  pageSize = 5000;
  overrides = {};
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("the tree (ac-1, ac-5)", () => {
  it("is an ARIA tree: levels, sizes and positions; folders expand in place, lazily", async () => {
    mount();
    await findItem("report.csv");
    expect(names()).toEqual(["data", "notes", "projects", "uploads", "main.py", "report.csv"]);
    const notes = item("notes");
    expect(notes.getAttribute("aria-expanded")).toBe("false");
    expect(notes.getAttribute("aria-level")).toBe("1");
    expect([notes.getAttribute("aria-posinset"), notes.getAttribute("aria-setsize")]).toEqual([
      "2",
      "6",
    ]);
    expect(item("report.csv").hasAttribute("aria-expanded")).toBe(false);
    expect(listed("notes")).toBe(0); // nothing below is read until it opens
    await userEvent.setup().click(notes);
    await findItem("todo.md");
    expect(notes.getAttribute("aria-expanded")).toBe("true");
    expect(names()).toEqual([
      "data",
      "notes",
      "  2026",
      "  todo.md",
      "projects",
      "uploads",
      "main.py",
      "report.csv",
    ]);
    expect(item("todo.md").getAttribute("aria-level")).toBe("2");
    expect(listed("notes")).toBe(1);
    // Closing and opening again uses the listing it has.
    await userEvent.setup().click(notes);
    await userEvent.setup().click(notes);
    await findItem("todo.md");
    expect(listed("notes")).toBe(1);
  });

  it("remembers expanded folders per team across reloads, and forgets one that is gone", async () => {
    const first = mount();
    await userEvent.setup().click(await findItem("notes"));
    await userEvent.setup().click(await findItem("2026"));
    await findItem("plan.md");
    expect(JSON.parse(localStorage.getItem(expandedKey(TEAM)) ?? "[]")).toEqual([
      "notes",
      "notes/2026",
    ]);
    first.unmount();
    files.delete("notes/2026/plan.md"); // the folder went away meanwhile
    mount();
    await findItem("todo.md");
    await waitFor(() =>
      expect(JSON.parse(localStorage.getItem(expandedKey(TEAM)) ?? "[]")).toEqual(["notes"]),
    );
  });

  it("works without storage (blocked): nothing is remembered, nothing breaks", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    mount();
    await userEvent.setup().click(await findItem("notes"));
    expect(await findItem("todo.md")).toBeTruthy();
  });

  it("reveals the folder a drop landed in", async () => {
    const view = mount({ showFolder: { path: "uploads", seq: 0 } });
    expect(await findItem("drop.pdf")).toBeTruthy();
    files.set("uploads/new.pdf", 3);
    view.rerender(
      <div data-kobe-chat>
        <IconActionProvider>
          <FileBrowser
            api={createFilesApi(TEAM, fetchFn)}
            refreshAfterWakeMs={60_000}
            showFolder={{ path: "uploads", seq: 1 }}
          />
        </IconActionProvider>
      </div>,
    );
    expect(await findItem("new.pdf")).toBeTruthy();
  });
});

describe("compact rows and icons (ac-2, ac-3)", () => {
  it("shows a type icon, the size muted at the end, the path as tooltip and the kind in words", async () => {
    mount();
    const csv = await findItem("report.csv");
    expect(csv.className).toMatch(/\bh-6\.5\b/); // 26 px rows
    expect(csv.getAttribute("title")).toBe("report.csv");
    expect(csv.querySelector("svg.lucide-file-spreadsheet")).not.toBeNull();
    expect(item("main.py").querySelector("svg.lucide-file-code")).not.toBeNull();
    expect(item("data").querySelector("svg.lucide-folder")).not.toBeNull();
    const size = within(csv).getByText("2 KB");
    expect(size.className).toMatch(/text-muted-foreground/);
    expect(size.className).toMatch(/hidden/); // narrow panels hide it (container query)
    const described = must(document.getElementById(must(csv.getAttribute("aria-describedby"))));
    expect(described.textContent).toBe("Spreadsheet or table, 2 KB");
    // The menu shows on hover or focus only, and is no tab stop of its own.
    const menu = within(csv).getByRole("button", { name: "Actions for report.csv" });
    expect(menu.className).toMatch(/group-hover\/row:opacity-100/);
    expect(menu.getAttribute("tabindex")).toBe("-1");
  });
});

describe("special roots (ac-4)", () => {
  it("project mounts are read-only: a lock, a marker, no Rename, Move or Delete, not draggable", async () => {
    mount();
    const projects = await findItem("projects");
    expect(projects.querySelector("svg.lucide-folder-lock")).not.toBeNull();
    expect(within(projects).getByText("Read-only")).toBeTruthy();
    expect(projects.getAttribute("draggable")).toBe("false");
    await userEvent.setup().click(projects);
    const plan = await findItem("plan");
    expect(within(plan).getByText("Read-only")).toBeTruthy();
    await userEvent.setup().click(within(plan).getByRole("button", { name: "Actions for plan" }));
    const menu = await screen.findByRole("menu", { name: "Actions for plan" });
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((i) => i.textContent),
    ).toEqual(["Open", "Copy path"]);
  });

  it("uploads/ is marked; a member's drop in it moves like any file; .kobe never shows", async () => {
    files.set(".kobe/sessions/t.jsonl", 1);
    mount();
    const uploads = await findItem("uploads");
    expect(within(uploads).getByText("Read-only")).toBeTruthy();
    expect(within(tree()).queryByRole("treeitem", { name: ".kobe" })).toBeNull();
    await userEvent.setup().click(uploads);
    expect((await findItem("drop.pdf")).getAttribute("draggable")).toBe("true");
    expect(item("0b7f3c1e-2d4a-4e5b-8c6d-7e8f9a0b1c2d").getAttribute("draggable")).toBe("false");
  });

  it("a large folder shows its first rows, then Show more", async () => {
    for (let i = 0; i < 450; i += 1) files.set(`big/f${String(i).padStart(3, "0")}.txt`, 1);
    mount();
    await userEvent.setup().click(await findItem("big"));
    await findItem("f000.txt");
    const rows = () =>
      within(tree())
        .queryAllByRole("treeitem")
        .filter((r) => r.getAttribute("aria-level") === "2");
    expect(rows()).toHaveLength(FOLDER_PAGE_ROWS + 1); // and the Show more row
    await userEvent.setup().click(item("Show 250 more"));
    await waitFor(() => expect(rows()).toHaveLength(2 * FOLDER_PAGE_ROWS + 1));
    await userEvent.setup().click(item("Show 50 more"));
    await waitFor(() => expect(rows()).toHaveLength(450));
  });

  it("fetches the next page when every row it has is shown", async () => {
    pageSize = 3;
    mount();
    await findItem("data");
    expect(names()).toEqual(["data", "notes", "projects", "Show more"]);
    await userEvent.setup().click(item("Show more"));
    await findItem("report.csv");
    expect(names()).toEqual(["data", "notes", "projects", "uploads", "main.py", "report.csv"]);
  });
});

describe("keyboard (ac-5)", () => {
  async function focused() {
    mount();
    await findItem("report.csv");
    const user = userEvent.setup();
    await user.tab(); // Upload, in the top-level row
    await user.tab();
    expect(document.activeElement).toBe(item("data"));
    return user;
  }
  const active = () => document.activeElement?.getAttribute("aria-label");

  it("one tab stop; arrows move, right opens and enters, left closes and climbs; Home and End", async () => {
    const user = await focused();
    expect(
      within(tree())
        .getAllByRole("treeitem")
        .filter((r) => r.tabIndex === 0),
    ).toHaveLength(1);
    await user.keyboard("{ArrowDown}");
    expect(active()).toBe("notes");
    await user.keyboard("{ArrowRight}");
    await findItem("todo.md");
    expect(active()).toBe("notes");
    await user.keyboard("{ArrowRight}");
    expect(active()).toBe("2026");
    await user.keyboard("{ArrowDown}");
    expect(active()).toBe("todo.md");
    await user.keyboard("{ArrowLeft}");
    expect(active()).toBe("notes");
    await user.keyboard("{ArrowLeft}");
    await waitFor(() =>
      expect(within(tree()).queryByRole("treeitem", { name: "todo.md" })).toBeNull(),
    );
    await user.keyboard("{End}");
    expect(active()).toBe("report.csv");
    await user.keyboard("{Home}");
    expect(active()).toBe("data");
    await user.keyboard("{ArrowUp}");
    expect(active()).toBe("data");
  });

  it("Enter opens a file and toggles a folder; type-ahead finds a name", async () => {
    const opened: FileEntry[] = [];
    mount({ onOpenFile: (e) => opened.push(e) });
    await findItem("report.csv");
    const user = userEvent.setup();
    await user.tab();
    await user.tab();
    await user.keyboard("r");
    expect(active()).toBe("report.csv");
    await user.keyboard("{Enter}");
    expect(opened.map((e) => e.path)).toEqual(["report.csv"]);
    await user.keyboard("ma");
    expect(active()).toBe("main.py");
    await user.keyboard("{Home}{Enter}");
    await findItem("sales.csv");
  });

  it("F2 renames, Delete asks, Shift+F10 opens the menu; modified keys are left to the shortcuts", async () => {
    const user = await focused();
    await user.keyboard("{F2}");
    const rename = await screen.findByRole("dialog", { name: "Rename data" });
    expect(document.activeElement).toBe(within(rename).getByRole("textbox"));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(active()).toBe("data"));
    await user.keyboard("{Delete}");
    expect(await screen.findByRole("alertdialog")).toBeTruthy();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(active()).toBe("data"));
    await user.keyboard("{Shift>}{F10}{/Shift}");
    expect(await screen.findByRole("menu", { name: "Actions for data" })).toBeTruthy();
    await user.keyboard("{Escape}");
    const k = new KeyboardEvent("keydown", {
      key: "k",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    item("data").dispatchEvent(k);
    expect(k.defaultPrevented).toBe(false);
    const down = new KeyboardEvent("keydown", {
      key: "ArrowDown",
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      document.activeElement?.dispatchEvent(down);
    });
    expect(down.defaultPrevented).toBe(true); // so the CE23 shortcuts never see it
  });

  it("read-only rows take no F2 or Delete", async () => {
    const user = await focused();
    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(active()).toBe("projects");
    await user.keyboard("{F2}{Delete}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});

describe("moving (ac-7)", () => {
  it("drags a file onto a folder: the folder lights up, the server moves it, the tree follows", async () => {
    const onMoved = vi.fn();
    mount({ onMoved });
    const csv = await findItem("report.csv");
    expect(drag(csv, item("notes"))).toBe(true);
    await waitFor(() => expect(moves()).toEqual([{ from: "report.csv", to: "notes/report.csv" }]));
    await findItem("todo.md"); // the destination opened
    expect(item("report.csv").getAttribute("aria-level")).toBe("2");
    await waitFor(() => expect(document.activeElement).toBe(item("report.csv")));
    expect(onMoved).toHaveBeenCalledWith("report.csv", "notes/report.csv");
    expect(screen.getByText("Moved report.csv to notes")).toBeTruthy();
  });

  it("a folder moves with its contents; expanded folders inside it stay open where it went", async () => {
    mount();
    await userEvent.setup().click(await findItem("notes"));
    await userEvent.setup().click(await findItem("2026"));
    await findItem("plan.md");
    expect(drag(item("2026"), item("data"))).toBe(true);
    await waitFor(() => expect(moves()).toEqual([{ from: "notes/2026", to: "data/2026" }]));
    await waitFor(() =>
      expect(names()).toEqual([
        "data",
        "  2026",
        "    plan.md",
        "  sales.csv",
        "notes",
        "  todo.md",
        "projects",
        "uploads",
        "main.py",
        "report.csv",
      ]),
    );
  });

  it("dropping onto a file moves into its folder; the top level takes drops too", async () => {
    mount();
    await userEvent.setup().click(await findItem("notes"));
    await findItem("todo.md");
    expect(drag(item("main.py"), item("todo.md"))).toBe(true);
    await waitFor(() => expect(moves()).toEqual([{ from: "main.py", to: "notes/main.py" }]));
    const root = must(screen.getByText("Workspace").parentElement);
    await findItem("main.py");
    expect(drag(item("todo.md"), root)).toBe(true);
    await waitFor(() => expect(moves()).toHaveLength(2));
    expect(moves()[1]).toEqual({ from: "notes/todo.md", to: "todo.md" });
  });

  it("refuses into itself or a child, into a read-only folder, and where it already is", async () => {
    mount();
    await userEvent.setup().click(await findItem("notes"));
    await findItem("2026");
    expect(drag(item("notes"), item("2026"))).toBe(false);
    expect(drag(item("notes"), item("notes"))).toBe(false);
    expect(drag(item("todo.md"), item("notes"))).toBe(false); // already there
    expect(drag(item("report.csv"), item("projects"))).toBe(false);
    expect(drag(item("notes"), item("uploads"))).toBe(false); // only files become drops
    expect(drag(item("projects"), item("data"))).toBe(false); // not draggable at all
    expect(moves()).toEqual([]);
  });

  it("a name clash is refused with a clear message; nothing is overwritten", async () => {
    files.set("notes/report.csv", 1);
    mount();
    expect(drag(await findItem("report.csv"), item("notes"))).toBe(true);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/Something named report\.csv is already there/);
    expect(files.get("report.csv")).toBe(2048);
    expect(item("report.csv").getAttribute("aria-level")).toBe("1");
  });

  it("Move to… is the keyboard way: choose a folder, Move here", async () => {
    mount();
    const user = userEvent.setup();
    await user.click(
      within(await findItem("main.py")).getByRole("button", { name: "Actions for main.py" }),
    );
    await user.click(await screen.findByRole("menuitem", { name: "Move to…" }));
    const dialog = await screen.findByRole("dialog", { name: "Move main.py to" });
    const options = within(dialog)
      .getAllByRole("radio")
      .map((r) => r.parentElement?.textContent);
    // Listed folders that can take it; not projects/ (read-only) nor uploads/ thread folders.
    expect(options).toEqual(["data", "notes", "uploads"]);
    await user.type(within(dialog).getByRole("searchbox", { name: "Filter folders" }), "no");
    await user.click(within(dialog).getByRole("radio", { name: "notes" }));
    await user.click(within(dialog).getByRole("button", { name: "Move here" }));
    await waitFor(() => expect(moves()).toEqual([{ from: "main.py", to: "notes/main.py" }]));
    await waitFor(() => expect(document.activeElement).toBe(item("main.py")));
  });

  it("Rename (menu or F2) uses the same API; a bad name is refused before asking", async () => {
    const onMoved = vi.fn();
    mount({ onMoved });
    const user = userEvent.setup();
    await user.click(await findItem("report.csv"));
    await user.keyboard("{F2}");
    const dialog = await screen.findByRole("dialog", { name: "Rename report.csv" });
    const input = within(dialog).getByRole("textbox");
    expect([
      (input as HTMLInputElement).selectionStart,
      (input as HTMLInputElement).selectionEnd,
    ]).toEqual([0, 6]); // the name without its extension
    await user.clear(input);
    await user.type(input, "a/b.csv{Enter}");
    expect((await within(dialog).findByRole("alert")).textContent).toMatch(/can't contain \//);
    await user.clear(input);
    await user.type(input, "bad​.csv{Enter}");
    expect((await within(dialog).findByRole("alert")).textContent).toMatch(/invisible/);
    expect(moves()).toEqual([]);
    await user.clear(input);
    await user.type(input, "summary.csv{Enter}");
    await waitFor(() => expect(moves()).toEqual([{ from: "report.csv", to: "summary.csv" }]));
    await findItem("summary.csv");
    expect(onMoved).toHaveBeenCalledWith("report.csv", "summary.csv");
    expect(screen.getByText("Renamed report.csv to summary.csv")).toBeTruthy();
  });

  it("files from the computer dropped on a folder upload into it", async () => {
    mount();
    const notes = await findItem("notes");
    expect(notes.hasAttribute("data-kobe-drop-folder")).toBe(true);
    expect(item("report.csv").hasAttribute("data-kobe-drop-folder")).toBe(false);
    expect(item("projects").hasAttribute("data-kobe-drop-folder")).toBe(false);
    const file = new File(["hello"], "up.txt", { type: "text/plain" });
    const dt = transfer(["Files"], [file]);
    fireEvent.dragOver(notes, { dataTransfer: dt });
    expect(notes.hasAttribute("data-drop-target")).toBe(true);
    fireEvent.drop(notes, { dataTransfer: dt });
    await waitFor(() => expect(files.get("notes/up.txt")).toBe(5));
    expect(await findItem("up.txt")).toBeTruthy();
    // An internal drag never counts as files.
    expect(seen.some((s) => s.method === "POST" && s.url === "/v1/workspace/files")).toBe(true);
    expect(TREE_DRAG_TYPE).not.toBe("Files");
  });
});
