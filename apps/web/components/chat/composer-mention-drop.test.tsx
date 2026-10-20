// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mentionMarker } from "@kobe/protocol";
import {
  MENTION_FOLDER_REFUSED,
  MENTION_NAME_REFUSED,
  MENTION_NO_COMPOSER,
} from "../../lib/chat/mention-insert";
import type { UploadTransport } from "../../lib/chat/uploads";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
import { must } from "../../lib/testing/must";
import { ChatApp } from "./chat-app";
import { composer, openRowMenu } from "./testing";

/**
 * KOBE-374 ac-4: a file row dragged from the Files tree (KOBE-304) onto the composer, or its
 * menu's "Mention in message", becomes an @file mention exactly like a pick (KOBE-223: the chip,
 * `mentions[]` on send). Folders are refused, project files mentioned; files from the computer
 * still attach; a drag that ends on the composer never moves the file.
 */
type Entry = Record<string, unknown>;
const entry = (name: string, path: string, type: "file" | "dir", area = "workspace"): Entry => ({
  name,
  path,
  type,
  size_bytes: type === "dir" ? null : 2048,
  mtime: "2026-10-01T10:00:00.000Z",
  source: "synced",
  owner: "sandbox",
  area,
});
const PROJECT = "0b7f3c1e-2d4a-4e5b-8c6d-7e8f9a0b1c2d";
/** A name that is markup: it must show as text, never as an element. */
const MARKUP = '<img src=x onerror="alert(1)">.csv';
/** A zero-width space: the KOBE-223 rules refuse it. */
const INVISIBLE = "a\u200bb.txt";
const TREE: Record<string, Entry[]> = {
  "": [
    entry("notes", "notes", "dir"),
    entry("projects", "projects", "dir", "projects"),
    entry("report.csv", "report.csv", "file"),
    entry(MARKUP, MARKUP, "file"),
    entry(INVISIBLE, INVISIBLE, "file"),
  ],
  notes: [entry("todo.md", "notes/todo.md", "file")],
  projects: [entry(PROJECT, `projects/${PROJECT}`, "dir", "projects")],
  [`projects/${PROJECT}`]: [entry("plan.md", `projects/${PROJECT}/plan.md`, "file", "projects")],
};

let fake: FakeKobe;
let moves: number;
let uploads: string[];

const fetchFn: typeof fetch = async (input, init = {}) => {
  const url = String(input);
  if (!url.startsWith("/v1/workspace/") || url.startsWith("/v1/workspace/files/search")) {
    return fake.fetch(input, init);
  }
  const key = `${init.method ?? "GET"} ${url.split("?")[0]}`;
  if (key === "POST /v1/workspace/wake") return Response.json({ status: "ready" }, { status: 202 });
  if (key === "POST /v1/workspace/files/move") {
    moves += 1;
    return Response.json({ moved: 1 });
  }
  if (key === "GET /v1/workspace/files") {
    const path = new URL(url, "http://x").searchParams.get("path") ?? "";
    return Response.json({ path, entries: TREE[path] ?? [] });
  }
  return new Response(null, { status: 500 });
};

const transport: UploadTransport = (request) => {
  uploads.push(request.file.name);
  return new Promise(() => undefined);
};

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  fake = new FakeKobe();
  moves = 0;
  uploads = [];
  vi.stubGlobal("fetch", fake.fetch);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function mount(threadId: string) {
  window.history.replaceState(null, "", `/?thread=${threadId}`);
  return render(
    <ChatApp fetchFn={fetchFn} eventSource={fake.eventSource} uploadTransport={transport} />,
  );
}

async function openFiles(threadId: string) {
  const user = userEvent.setup();
  mount(threadId);
  const files = await screen.findByRole("region", { name: "Files" });
  await within(files).findByText("report.csv");
  return { user, files };
}

const row = (name: string) => screen.getByRole("treeitem", { name });
const panel = () => must(document.querySelector<HTMLElement>("[data-kobe-composer-panel]"));
const chips = () =>
  within(screen.getByRole("list", { name: "Mentioned files" }))
    .getAllByRole("listitem")
    .map((li) => li.textContent);
const posts = () =>
  fake.requests
    .filter((r) => r.method === "POST" && /\/v1\/threads\/[^/]+\/messages$/.test(r.path))
    .map((r) => r.body as { content?: string; mentions?: string[] });

/**
 * A DataTransfer good enough for happy-dom drag events (Testing Library copies its properties
 * per event, so a handler's `dropEffect` is not seen here; lib/chat/mention-insert.test.ts covers the types).
 */
function transfer(types: string[] = [], files: File[] = []) {
  const data = new Map<string, string>();
  return {
    get types() {
      return [...types, ...data.keys()];
    },
    setData: (t: string, v: string) => data.set(t, v),
    getData: (t: string) => data.get(t) ?? "",
    effectAllowed: "all",
    dropEffect: "none",
    files,
    items: [],
  };
}

/** Drags `from` (a tree row) onto the composer; what the panel showed while hovering. */
function dragToComposer(from: HTMLElement) {
  const dt = transfer();
  fireEvent.dragStart(from, { dataTransfer: dt });
  fireEvent.dragOver(panel(), { dataTransfer: dt });
  const hover = {
    drop: panel().getAttribute("data-mention-drop"),
    hint: document.getElementById("kobe-composer-hint")?.textContent,
  };
  fireEvent.drop(panel(), { dataTransfer: dt });
  fireEvent.dragEnd(from, { dataTransfer: dt });
  return hover;
}

describe("drag a workspace file into the composer (KOBE-374 ac-4)", () => {
  it("a file row dropped on the composer is an @file chip and goes in mentions[]", async () => {
    const t = fake.addThread("Work");
    const { user } = await openFiles(t);
    const input = await composer();
    await user.type(input, "Summarise");

    const hover = dragToComposer(row("report.csv"));
    expect(hover).toEqual({ drop: "file", hint: "Drop to mention this file" });
    expect(panel().hasAttribute("data-mention-drop")).toBe(false);
    await waitFor(() => expect(chips()).toEqual(["@report.csv"]));
    expect(input.value).toBe(`Summarise ${mentionMarker("report.csv")} `);
    // A drag that ends on the composer is a mention, never a move.
    expect(moves).toBe(0);
    await waitFor(() => expect(document.activeElement).toBe(input));

    await user.keyboard("{Enter}");
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]?.mentions).toEqual(["report.csv"]);
    expect(posts()[0]?.content).toBe(`Summarise ${mentionMarker("report.csv")}`);
  });

  it("a project file is mentioned (read-only, never moved); a folder is refused", async () => {
    const t = fake.addThread("Work");
    const { user } = await openFiles(t);
    await user.click(row("projects"));
    await user.click(await screen.findByRole("treeitem", { name: PROJECT }));
    const plan = await screen.findByRole("treeitem", { name: "plan.md" });
    expect(plan.getAttribute("draggable")).toBe("true");
    expect(row(PROJECT).getAttribute("draggable")).toBe("false");
    dragToComposer(plan);
    await waitFor(() => expect(chips()).toEqual([`@projects/${PROJECT}/plan.md`]));

    const hover = dragToComposer(row("notes"));
    expect(hover).toEqual({ drop: "folder", hint: MENTION_FOLDER_REFUSED });
    expect(document.getElementById("kobe-composer-hint")?.textContent).toBe(MENTION_FOLDER_REFUSED);
    expect(chips()).toEqual([`@projects/${PROJECT}/plan.md`]);
    expect(moves).toBe(0);
  });

  it("files from the computer still attach, and are no mention", async () => {
    const t = fake.addThread("Work");
    await openFiles(t);
    await composer();
    const dt = transfer(["Files"], [new File(["abc"], "dropped.csv", { type: "text/csv" })]);
    fireEvent.dragOver(panel(), { dataTransfer: dt });
    expect(panel().hasAttribute("data-dragging")).toBe(true);
    expect(panel().hasAttribute("data-mention-drop")).toBe(false);
    fireEvent.drop(panel(), { dataTransfer: dt });
    await waitFor(() => expect(uploads).toEqual(["dropped.csv"]));
    expect(screen.queryByRole("list", { name: "Mentioned files" })).toBeNull();
  });

  it("the tree still moves a row dropped on a folder (the composer is not in the way)", async () => {
    const t = fake.addThread("Work");
    await openFiles(t);
    const dt = transfer();
    fireEvent.dragStart(row("report.csv"), { dataTransfer: dt });
    fireEvent.dragOver(row("notes"), { dataTransfer: dt });
    fireEvent.drop(row("notes"), { dataTransfer: dt });
    fireEvent.dragEnd(row("report.csv"), { dataTransfer: dt });
    await waitFor(() => expect(moves).toBe(1));
    expect(screen.queryByRole("list", { name: "Mentioned files" })).toBeNull();
  });
});

describe("Mention in message, the keyboard way (KOBE-374 ac-4)", () => {
  it("the row menu mentions the file in the composer and moves the focus there", async () => {
    const t = fake.addThread("Work");
    const { user } = await openFiles(t);
    const menu = await openRowMenu("Actions for report.csv");
    await user.click(within(menu).getByRole("menuitem", { name: "Mention in message" }));
    await waitFor(() => expect(chips()).toEqual(["@report.csv"]));
    const input = await composer();
    await waitFor(() => expect(document.activeElement).toBe(input));
    expect(input.selectionStart).toBe(input.value.length);
  });

  it("folders have no such item", async () => {
    const t = fake.addThread("Work");
    await openFiles(t);
    const menu = await openRowMenu("Actions for notes");
    expect(within(menu).queryByRole("menuitem", { name: "Mention in message" })).toBeNull();
  });

  it("a reader of a shared thread has no composer: the menu says why", async () => {
    const t = fake.addThread("Shared");
    Object.assign(must(fake.threads.get(t)), { read_only: true, owner_name: "Alice" });
    fake.addEntry(t, null, { role: "user", content: "from the author" });
    const { user, files } = await openFiles(t);
    await screen.findByText(/You are reading a shared conversation/);
    const menu = await openRowMenu("Actions for report.csv");
    await user.click(within(menu).getByRole("menuitem", { name: "Mention in message" }));
    expect(await within(files).findByText(MENTION_NO_COMPOSER)).toBeTruthy();
  });
});

describe("names (KOBE-374 review)", () => {
  const byPath = (path: string) =>
    must(
      [...document.querySelectorAll<HTMLElement>('[role="treeitem"]')].find(
        (el) => el.dataset.path === path,
      ),
    );

  it("a name that is markup shows as text in the chip, never as an element", async () => {
    const t = fake.addThread("Work");
    await openFiles(t);
    await composer();
    dragToComposer(byPath(MARKUP));
    await waitFor(() => expect(chips()).toEqual([`@${MARKUP}`]));
    expect(panel().querySelector("img")).toBeNull();
  });

  it("Mention in message refuses a name the rules refuse, and says why", async () => {
    const t = fake.addThread("Work");
    const { user, files } = await openFiles(t);
    const input = await composer();
    await user.click(within(byPath(INVISIBLE)).getByRole("button", { name: /^Actions for / }));
    const menu = await screen.findByRole("menu");
    await user.click(within(menu).getByRole("menuitem", { name: "Mention in message" }));
    expect(await within(files).findByText(MENTION_NAME_REFUSED)).toBeTruthy();
    expect(input.value).toBe("");
    expect(screen.queryByRole("list", { name: "Mentioned files" })).toBeNull();
  });
});
