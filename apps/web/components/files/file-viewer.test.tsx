// @vitest-environment happy-dom
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tabsKey } from "../../lib/chat/artifact-tabs";
import { ARTIFACT_FRAME_SANDBOX } from "../../lib/chat/artifacts";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
import { workspaceFrameUrl } from "../../lib/files/preview";
import { must } from "../../lib/testing/must";
import { DESKTOP_WIDTH, resizeWindow } from "../../lib/testing/viewport";
import { ChatApp } from "../chat/chat-app";
import { browserSpaced, composer, crushedIconButtons, openRowMenu } from "../chat/testing";

/** KOBE-268: workspace files open as tabs of the artifact column. */
let fake: FakeKobe;
/** The synced workspace: path -> content. */
let files: Map<string, Uint8Array>;
/** Requests for a file's content, and the bytes of it the page actually pulled. */
let reads: string[];
let pulled: Map<string, number>;
/** Files whose saved copy is missing from storage (KOBE-475): listed, but reads answer 503. */
let contentMissing: Set<string>;
const CHUNK = 64 * 1024;

const enc = (s: string) => new TextEncoder().encode(s);

function entry(path: string, type: "file" | "dir") {
  const bytes = files.get(path);
  return {
    name: path.slice(path.lastIndexOf("/") + 1),
    path,
    type,
    size_bytes: type === "dir" ? null : (bytes?.length ?? 0),
    mtime: "2026-10-01T10:00:00.000Z",
    source: "synced",
    owner: "sandbox",
    area: "workspace",
  };
}

function listing(dir: string) {
  const prefix = dir === "" ? "" : `${dir}/`;
  const children = new Map<string, "file" | "dir">();
  for (const path of files.keys()) {
    if (!path.startsWith(prefix)) continue;
    const [head, ...rest] = path.slice(prefix.length).split("/");
    children.set(`${prefix}${head}`, rest.length > 0 ? "dir" : "file");
  }
  return [...children].map(([path, type]) => entry(path, type));
}

const fetchFn: typeof fetch = async (input, init = {}) => {
  const url = new URL(String(input), "http://kobe.test");
  const method = init.method ?? "GET";
  if (!url.pathname.startsWith("/v1/workspace/")) return fake.fetch(input, init);
  if (method === "POST" && url.pathname === "/v1/workspace/wake") {
    return Response.json({ status: "waking" }, { status: 202 });
  }
  const path = url.searchParams.get("path") ?? "";
  if (method === "POST" && url.pathname === "/v1/workspace/files/move") {
    const { from, to } = JSON.parse(String(init.body)) as { from: string; to: string };
    for (const [p, bytes] of [...files]) {
      if (p !== from && !p.startsWith(`${from}/`)) continue;
      files.delete(p);
      files.set(`${to}${p.slice(from.length)}`, bytes);
    }
    return Response.json({ from, to, type: "file", files: 1 });
  }
  if (url.pathname === "/v1/workspace/files") {
    const entries = listing(path);
    if (path !== "" && entries.length === 0) {
      return Response.json({ code: "not_found", message: "No such file." }, { status: 404 });
    }
    return Response.json({ path, entries });
  }
  if (url.pathname === "/v1/workspace/file") {
    reads.push(path);
    const bytes = files.get(path);
    if (!bytes) return Response.json({ code: "not_found", message: "Gone." }, { status: 404 });
    if (contentMissing.has(path)) {
      return Response.json({ code: "content_missing", message: "Missing." }, { status: 503 });
    }
    let at = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (at >= bytes.length) return controller.close();
        const chunk = bytes.subarray(at, at + CHUNK);
        at += chunk.length;
        pulled.set(path, at);
        controller.enqueue(chunk);
      },
    });
    return new Response(bytes.length === 0 ? null : body, {
      headers: { "content-length": String(bytes.length) },
    });
  }
  return new Response(null, { status: 500 });
};

function thread(title: string) {
  const t = fake.addThread(title);
  const u = fake.addEntry(t, null, { role: "user", content: "hi" });
  fake.addEntry(t, u, { role: "assistant", content: [{ type: "text", text: "done" }] });
  return t;
}

function mount(threadId?: string) {
  window.history.replaceState(null, "", threadId ? `/?thread=${threadId}` : "/");
  return render(<ChatApp fetchFn={fetchFn} eventSource={fake.eventSource} />);
}

/** The rail's Files section, listed once on screen (KOBE-461). */
async function openFiles() {
  const section = await screen.findByRole("region", { name: "Files" });
  return section;
}

async function view(user: ReturnType<typeof userEvent.setup>, section: HTMLElement, name: string) {
  await user.click(await within(section).findByRole("treeitem", { name }));
  await screen.findByRole("tab", { name, selected: true });
  return screen.getByRole("tabpanel");
}

const tabNames = () =>
  screen
    .queryAllByRole("tab")
    .map((t) => `${t.textContent}${t.getAttribute("aria-selected") === "true" ? "*" : ""}`);

beforeEach(() => {
  contentMissing = new Set();
  localStorage.clear();
  sessionStorage.clear();
  // The frame route is the server's: don't let happy-dom fetch it from localhost.
  const settings = (window as unknown as { happyDOM?: { settings: Record<string, boolean> } })
    .happyDOM?.settings;
  if (settings) {
    settings.disableIframePageLoading = true;
    settings.handleDisabledFileLoadingAsSuccess = true;
  }
  fake = new FakeKobe();
  files = new Map();
  reads = [];
  pulled = new Map();
  vi.stubGlobal("fetch", fetchFn);
});

afterEach(() => {
  cleanup();
  resizeWindow(DESKTOP_WIDTH);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("opening files (ac-1)", () => {
  it("a file opens as the active tab; folders expand in place; Download works in row and tab", async () => {
    files.set("notes/todo.md", enc("# Todo"));
    files.set("report.csv", enc("a,b\n1,2"));
    mount(thread("Work"));
    const user = userEvent.setup();
    const section = await openFiles();
    await user.click(await within(section).findByRole("treeitem", { name: "notes" }));
    const panel = await view(user, section, "todo.md");
    expect(await within(panel).findByRole("heading", { name: "Todo" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "todo.md" })).toBeTruthy();

    // The tree keeps notes/ open beside the top level (KOBE-304: no breadcrumb).
    await view(user, section, "report.csv");
    expect(tabNames()).toEqual(["todo.md", "report.csv*"]);
    // Opening an open file again only activates it.
    await view(user, section, "todo.md");
    expect(tabNames()).toEqual(["todo.md*", "report.csv"]);
    // KOBE-269: the rows' icons (since KOBE-292 one ⋯ menu button) and the tab's keep their
    // size. KOBE-304's compact rows (26 px) take the 24 px button (WCAG 2.5.8's minimum target).
    expect(crushedIconButtons()).toEqual([]);
    const actions = within(section).getByRole("button", { name: "Actions for todo.md" });
    expect(actions.className).toMatch(/\bsize-6\b/);
    // KOBE-269: the Files list sits flush, without the browser's list indent and margins.
    expect(browserSpaced(section)).toEqual([]);

    Object.assign(URL, { createObjectURL: vi.fn(() => "blob:x"), revokeObjectURL: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    await user.click(within(panel).getByRole("button", { name: "Download todo.md" }));
    await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
    const menu = await openRowMenu("Actions for todo.md");
    await user.click(within(menu).getByRole("menuitem", { name: "Download" }));
    await waitFor(() => expect(click).toHaveBeenCalledTimes(2));
  });
});

describe("opening again (ac-1, ac-3)", () => {
  it("re-reads the file: new content shows; a deleted one drops, focus back on Files", async () => {
    files.set("a.md", enc("# One"));
    mount(thread("Work"));
    const user = userEvent.setup();
    const section = await openFiles();
    const panel = await view(user, section, "a.md");
    expect(await within(panel).findByRole("heading", { name: "One" })).toBeTruthy();

    files.set("a.md", enc("# Two"));
    await view(user, section, "a.md");
    expect(await within(panel).findByRole("heading", { name: "Two" })).toBeTruthy();

    files.delete("a.md");
    const opener = within(section).getByRole("treeitem", { name: "a.md" });
    await user.click(opener);
    expect(await screen.findByText(/a\.md is no longer in your workspace/)).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("tablist")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it("a file whose saved copy is missing stays open and says it will be restored (KOBE-475)", async () => {
    files.set("mortgage.py", enc("print(1)"));
    contentMissing.add("mortgage.py");
    mount(thread("Work"));
    const user = userEvent.setup();
    const panel = await view(user, await openFiles(), "mortgage.py");
    expect(
      await within(panel).findByText(
        "The saved copy of mortgage.py is missing; it will be restored from your sandbox at its next sync.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/no longer in your workspace/)).toBeNull();
    expect(tabNames()).toEqual(["mortgage.py*"]);
  });

  it("a file opened on a new conversation stays open once its first message makes the thread", async () => {
    files.set("brief.md", enc("# Brief"));
    mount();
    const user = userEvent.setup();
    await view(user, await openFiles(), "brief.md");
    await user.type(await composer(), "summarise it{Enter}");
    await waitFor(() => expect(fake.threads.size).toBe(1));
    const id = must([...fake.threads.values()][0]).thread_id;
    await waitFor(() => expect(window.location.search).toBe(`?thread=${id}`));
    expect(tabNames()).toEqual(["brief.md*"]);
    await waitFor(() =>
      expect(localStorage.getItem(tabsKey(fake.teamId, id))).toContain("file:brief.md"),
    );
  });
});

describe("moved files (KOBE-304, ac-9)", () => {
  it("an open file's tab follows a rename and a move of its folder", async () => {
    files.set("notes/a.md", enc("# Kept"));
    const threadId = thread("Work");
    mount(threadId);
    const user = userEvent.setup();
    const section = await openFiles();
    await user.click(await within(section).findByRole("treeitem", { name: "notes" }));
    const panel = await view(user, section, "a.md");
    expect(await within(panel).findByRole("heading", { name: "Kept" })).toBeTruthy();
    // Rename with F2 from the row.
    within(section).getByRole("treeitem", { name: "a.md" }).focus();
    await user.keyboard("{F2}");
    const input = within(
      await within(section).findByRole("dialog", { name: "Rename a.md" }),
    ).getByRole("textbox");
    await user.clear(input);
    await user.type(input, "b.md{Enter}");
    await waitFor(() => expect(tabNames()).toEqual(["b.md*"]));
    expect(
      await within(screen.getByRole("tabpanel")).findByRole("heading", { name: "Kept" }),
    ).toBeTruthy();
    // The folder moves (drag and drop is the pointer's way; Move to… the keyboard's).
    await user.click(
      within(within(section).getByRole("treeitem", { name: "notes" })).getByRole("button", {
        name: "Actions for notes",
      }),
    );
    await user.click(await screen.findByRole("menuitem", { name: "Rename" }));
    const folderInput = within(
      await within(section).findByRole("dialog", { name: "Rename notes" }),
    ).getByRole("textbox");
    await user.clear(folderInput);
    await user.type(folderInput, "archive{Enter}");
    await waitFor(() =>
      expect(localStorage.getItem(tabsKey(fake.teamId, threadId))).toContain("file:archive/b.md"),
    );
    expect(screen.queryByText(/is no longer in your workspace/)).toBeNull();
  });
});

describe("narrow screens (KOBE-201)", () => {
  it("390: a file from the drawer opens as a full-screen sheet; the drawer makes way", async () => {
    resizeWindow(390);
    files.set("a.md", enc("# On a phone"));
    mount(thread("Work"));
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Show the workspace" }));
    const drawer = await screen.findByRole("dialog", { name: "Workspace" });
    const section = within(drawer).getByRole("region", { name: "Files" });
    await user.click(await within(section).findByRole("treeitem", { name: "a.md" }));
    const sheet = await screen.findByRole("dialog", { name: "a.md" });
    expect(sheet.getAttribute("aria-modal")).toBe("true");
    expect(await within(sheet).findByRole("heading", { name: "On a phone" })).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "Workspace" })).toBeNull();
    await user.click(within(sheet).getByRole("button", { name: "Back to the conversation" }));
    const column = must(document.querySelector('[data-shell-region="artifact"]'));
    await waitFor(() => expect(column.hasAttribute("data-sheet-open")).toBe(false));
  });
});

describe("renderers (ac-2)", () => {
  async function shown(name: string, content: Uint8Array | string) {
    files.set(name, typeof content === "string" ? enc(content) : content);
    mount(thread("Work"));
    const user = userEvent.setup();
    return view(user, await openFiles(), name);
  }

  it("Markdown", async () => {
    const panel = await shown("a.md", "# Title\n\n<b>raw</b>");
    expect(await within(panel).findByRole("heading", { name: "Title" })).toBeTruthy();
    expect(panel.querySelector("b")).toBeNull(); // raw HTML stays text
  });

  it("CSV and TSV as tables", async () => {
    const csv = await shown("d.csv", 'h1,h2\n"x, y",2');
    expect(await within(csv).findByRole("columnheader", { name: "h2" })).toBeTruthy();
    expect(within(csv).getByRole("cell", { name: "x, y" })).toBeTruthy();
    cleanup();
    const tsv = await shown("d.tsv", "h1\th2\na,b\tc");
    expect(await within(tsv).findByRole("cell", { name: "a,b" })).toBeTruthy();
  });

  it("JSON pretty-printed, code and plain text as blocks", async () => {
    const json = await shown("x.json", '{"a":[1,2]}');
    await waitFor(() => expect(json.querySelector("pre")?.textContent).toContain('"a": [\n'));
    cleanup();
    const code = await shown("main.py", "print('hi')");
    await waitFor(() => expect(code.querySelector("code")?.className).toContain("python"));
    cleanup();
    const text = await shown("run.log", "line 1");
    await waitFor(() => expect(text.querySelector("pre")?.textContent).toContain("line 1"));
  });

  it("images and SVG as <img> data URLs, never inline SVG markup", async () => {
    const png = await shown("p.png", new Uint8Array([137, 80, 78, 71]));
    const img = await within(png).findByRole("img", { name: "p.png" });
    expect(img.getAttribute("src")).toBe("data:image/png;base64,iVBORw==");
    cleanup();
    const svg = await shown("logo.svg", '<svg xmlns="http://www.w3.org/2000/svg" onload="x()"/>');
    const pic = await within(svg).findByRole("img", { name: "logo.svg" });
    expect(pic.getAttribute("src")).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(svg.querySelector("svg[onload]")).toBeNull();
  });

  it("HTML only in the sandboxed frame from the workspace frame route", async () => {
    const panel = await shown("index.html", "<script>alert(1)</script>");
    const frame = await waitFor(() => must(panel.querySelector("iframe")));
    expect(frame.getAttribute("src")).toBe(workspaceFrameUrl("index.html", fake.teamId));
    expect(frame.getAttribute("sandbox")).toBe(ARTIFACT_FRAME_SANDBOX);
    expect(frame.hasAttribute("srcdoc")).toBe(false);
    // The page only asks whether it exists and how large it is: none of the HTML is read.
    expect(reads).toEqual(["index.html"]);
    expect(pulled.get("index.html") ?? 0).toBeLessThanOrEqual(CHUNK);
    expect(panel.querySelector("script")).toBeNull();
  });

  it("PDFs, unknown and binary files: Cannot preview, with Download", async () => {
    for (const [name, content] of [
      ["doc.pdf", "%PDF-1.7"],
      ["blob.bin", "x"],
      ["bad.txt", new Uint8Array([104, 0, 105])],
    ] as const) {
      const panel = await shown(name, content);
      expect(await within(panel).findByText(/Cannot preview this file/)).toBeTruthy();
      expect(within(panel).getByRole("button", { name: `Download ${name}` })).toBeTruthy();
      cleanup();
    }
    // Each was checked (it exists); only the text file's content was read, to find it binary.
    expect(reads).toEqual(["doc.pdf", "blob.bin", "bad.txt"]);
  });
});

describe("memory, deleted files and caps (ac-3)", () => {
  it("file tabs are remembered per thread with artifact tabs", async () => {
    files.set("a.md", enc("# A file"));
    const t = thread("One");
    const other = thread("Two");
    fake.addArtifact(t, { kind: "markdown", title: "Plan", versions: ["plan body"] });
    mount(t);
    const user = userEvent.setup();
    const list = await screen.findByRole("navigation", {
      name: "Artifacts and files in this conversation",
    });
    await user.click(within(list).getByRole("button", { name: "Open artifact Plan" }));
    await view(user, await openFiles(), "a.md");
    expect(tabNames()).toEqual(["Plan", "a.md*"]);
    const stored = JSON.parse(must(localStorage.getItem(tabsKey(fake.teamId, t)))) as {
      open: string[];
    };
    expect(stored.open.at(-1)).toBe("file:a.md");

    act(() => {
      window.history.pushState(null, "", `/?thread=${other}`);
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await waitFor(() => expect(screen.queryByRole("tablist")).toBeNull());
    act(() => {
      window.history.pushState(null, "", `/?thread=${t}`);
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await waitFor(() => expect(tabNames()).toEqual(["Plan", "a.md*"]));
    expect(await within(screen.getByRole("tabpanel")).findByText("A file")).toBeTruthy();
  });

  it("a file that is gone is dropped with a notice", async () => {
    files.set("kept.md", enc("# Kept"));
    const t = thread("One");
    localStorage.setItem(
      tabsKey(fake.teamId, t),
      JSON.stringify({
        open: ["file:kept.md", "file:old.pdf", "file:old/gone.md"],
        active: "file:old/gone.md",
      }),
    );
    mount(t);
    // The active tab's file is gone; its neighbour (a PDF, checked too once shown) is gone too.
    await waitFor(() => expect(tabNames()).toEqual(["kept.md*"]));
    expect(await screen.findByText(/old\.pdf is no longer in your workspace/)).toBeTruthy();
    expect(await within(screen.getByRole("tabpanel")).findByText("Kept")).toBeTruthy();
    expect(reads.sort()).toEqual(["kept.md", "old.pdf", "old/gone.md"]);
    expect(crushedIconButtons()).toEqual([]); // KOBE-269: the close icon keeps its size
    await userEvent.setup().click(screen.getByRole("button", { name: "Dismiss file notice" }));
    expect(screen.queryByText(/no longer in your workspace/)).toBeNull();
  });

  it("the notice belongs to its thread: another thread on screen clears it", async () => {
    const t = thread("One");
    const other = thread("Two");
    localStorage.setItem(
      tabsKey(fake.teamId, t),
      JSON.stringify({ open: ["file:gone.md"], active: "file:gone.md" }),
    );
    mount(t);
    expect(await screen.findByText(/gone\.md is no longer in your workspace/)).toBeTruthy();
    act(() => {
      window.history.pushState(null, "", `/?thread=${other}`);
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await waitFor(() => expect(screen.queryByText(/no longer in your workspace/)).toBeNull());
  });

  it("text previews stop at 1 MB with a notice; large images are not fetched", async () => {
    files.set("big.txt", enc("x".repeat(1024 * 1024 + 10)));
    files.set("huge.png", new Uint8Array(10 * 1024 * 1024 + 1));
    mount(thread("Work"));
    const user = userEvent.setup();
    const section = await openFiles();
    const big = await view(user, section, "big.txt");
    expect(await within(big).findByText(/Showing the first 1 MB of 1\.0 MB/)).toBeTruthy();
    const shownText = must(big.querySelector("pre")).textContent;
    expect(shownText.length).toBeLessThanOrEqual(1024 * 1024 + 1);
    const huge = await view(user, section, "huge.png");
    expect(await within(huge).findByText(/too large to preview \(10 MB\)/)).toBeTruthy();
    // The text stopped at the cap; the image's Content-Length was enough to read none of it.
    expect(must(pulled.get("big.txt"))).toBeLessThanOrEqual(1024 * 1024 + CHUNK);
    expect(pulled.get("huge.png") ?? 0).toBeLessThanOrEqual(CHUNK);
  });
});
