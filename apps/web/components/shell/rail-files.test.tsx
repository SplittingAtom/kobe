// @vitest-environment happy-dom
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
import { ChatApp } from "../chat/chat-app";
import { must } from "../../lib/testing/must";
import { openRowMenu, pressModShift } from "../chat/testing";

interface Seen {
  readonly method: string;
  readonly url: string;
}

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

const TREE: Record<string, Entry[]> = {
  "": [
    entry("notes", "notes", "dir"),
    entry("uploads", "uploads", "dir", "uploads"),
    entry("report.csv", "report.csv", "file"),
  ],
  notes: [entry("todo.md", "notes/todo.md", "file")],
  uploads: [
    entry(
      "0b7f3c1e-2d4a-4e5b-8c6d-7e8f9a0b1c2d",
      "uploads/0b7f3c1e-2d4a-4e5b-8c6d-7e8f9a0b1c2d",
      "dir",
      "uploads",
    ), // a thread's attachments
    entry("brief.pdf", "uploads/brief.pdf", "file", "uploads"),
  ],
};

let seen: Seen[];
let overrides: Record<string, () => Response>;
let fake: FakeKobe;
let wakeGate: Promise<void>;

/** The workspace routes from TREE; everything else goes to the fake chat server. */
const fetchFn: typeof fetch = async (input, init = {}) => {
  const url = String(input);
  const method = init.method ?? "GET";
  if (!url.startsWith("/v1/workspace/")) return fake.fetch(input, init);
  seen.push({ method, url });
  const key = `${method} ${url.split("?")[0]}`;
  const override = overrides[key];
  if (override) return override();
  if (key === "POST /v1/workspace/wake") {
    await wakeGate;
    return Response.json({ status: "waking" }, { status: 202 });
  }
  if (key === "GET /v1/workspace/files") {
    const path = new URL(url, "http://x").searchParams.get("path") ?? "";
    const entries = TREE[path];
    if (!entries)
      return Response.json({ code: "not_found", message: "No such file." }, { status: 404 });
    return Response.json({ path, entries });
  }
  if (key === "GET /v1/workspace/file") return new Response("data");
  if (key === "DELETE /v1/workspace/files") return new Response(null, { status: 204 });
  if (key === "POST /v1/workspace/files") {
    return Response.json(entry("up.txt", "up.txt", "file"), { status: 201 });
  }
  return new Response(null, { status: 500 });
};

function mount() {
  window.history.replaceState(null, "", "/");
  return render(<ChatApp fetchFn={fetchFn} eventSource={fake.eventSource} />);
}

/** The rail's Files section, on screen and so listed (KOBE-461). */
async function open() {
  const user = userEvent.setup();
  mount();
  const panel = await screen.findByRole("region", { name: "Files" });
  await within(panel).findByText("report.csv");
  return { user, panel };
}

/** A row's ⋯ menu (KOBE-292): its item names, or chooses `action` in it. */
async function rowMenu(name: string): Promise<HTMLElement> {
  return openRowMenu(`Actions for ${name}`);
}
const menuNames = (menu: HTMLElement) =>
  within(menu)
    .getAllByRole("menuitem")
    .map((i) => i.textContent);
async function fileAction(user: ReturnType<typeof userEvent.setup>, name: string, action: string) {
  await user.click(within(await rowMenu(name)).getByRole("menuitem", { name: action }));
}

const wakes = () =>
  seen.filter((s) => s.method === "POST" && s.url === "/v1/workspace/wake").length;
const rootListings = () =>
  seen.filter((s) => s.method === "GET" && s.url === "/v1/workspace/files").length;

beforeEach(() => {
  seen = [];
  overrides = {};
  fake = new FakeKobe();
  wakeGate = Promise.resolve();
  sessionStorage.clear();
  localStorage.clear(); // the tree remembers expanded folders (KOBE-304)
  vi.stubGlobal("fetch", fetchFn);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Files in the workspace rail (KOBE-198, ac-3)", () => {
  it("lists /workspace and wakes once Files is on screen, without Open files (KOBE-461 ac-2)", async () => {
    mount();
    const panel = await screen.findByRole("region", { name: "Files" });
    await within(panel).findByText("report.csv");
    expect(within(panel).queryByRole("button", { name: "Open files" })).toBeNull();
    const folder = (name: string) => within(panel).getByRole("treeitem", { name });
    expect(folder("notes").getAttribute("aria-expanded")).toBe("false");
    expect(folder("uploads").getAttribute("aria-expanded")).toBe("false");
    expect(within(panel).getAllByText("2 KB").length).toBeGreaterThan(0);
    await waitFor(() => expect(wakes()).toBe(1));
    expect(rootListings()).toBe(1);
  });

  it("wakes and lists again on each Show files, Mod+Shift+F and Refresh", async () => {
    const { user } = await open();
    await waitFor(() => expect(wakes()).toBe(1));
    act(() => void pressModShift("F"));
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("region", { name: "Files" })),
    );
    await waitFor(() => expect(wakes()).toBe(2));
    expect(rootListings()).toBe(2);
    await user.click(screen.getByRole("button", { name: "Refresh files" }));
    await waitFor(() => expect(wakes()).toBe(3));
    expect(rootListings()).toBe(3);
    await user.click(screen.getByRole("button", { name: "Collapse the rail" }));
    await user.click(screen.getByRole("button", { name: "Show files" }));
    await waitFor(() => expect(wakes()).toBe(4));
  });

  it("keeps its folder through collapse and expand; collapsed it wakes nothing, shown again it lists once", async () => {
    const { user, panel } = await open();
    await waitFor(() => expect(wakes()).toBe(1));
    await user.click(within(panel).getByRole("treeitem", { name: "notes" }));
    await within(panel).findByText("todo.md");
    await user.click(screen.getByRole("button", { name: "Collapse the rail" }));
    expect(screen.getByText("todo.md").closest("[hidden]")).not.toBeNull(); // hidden, still mounted
    await new Promise((r) => setTimeout(r, 50));
    expect(wakes()).toBe(1);
    // The Threads panel leaves the rail collapsed: still nothing woken.
    await user.click(screen.getByRole("button", { name: "Show threads" }));
    await new Promise((r) => setTimeout(r, 50));
    expect(wakes()).toBe(1);
    await user.click(screen.getByRole("button", { name: "Show files" }));
    expect(await within(panel).findByText("todo.md")).toBeTruthy();
    expect(within(panel).getByText("todo.md").closest("[hidden]")).toBeNull();
    await waitFor(() => expect(wakes()).toBe(2));
    await new Promise((r) => setTimeout(r, 50));
    expect(wakes()).toBe(2);
  });

  it("wakes nothing on a load with the rail collapsed, and lists when it expands (KOBE-461 ac-2)", async () => {
    fake.preferences = { rail_collapsed: true };
    const user = userEvent.setup();
    mount();
    await screen.findByRole("heading", { name: "Finance" });
    await screen.findByRole("button", { name: "Show files" });
    await new Promise((r) => setTimeout(r, 50));
    expect(seen).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Show files" }));
    const panel = await screen.findByRole("region", { name: "Files" });
    await within(panel).findByText("report.csv");
    // The ask that brought Files on screen is its one listing.
    await waitFor(() => expect(wakes()).toBe(1));
    await new Promise((r) => setTimeout(r, 50));
    expect(wakes()).toBe(1);
    expect(rootListings()).toBe(1);
  });

  it("puts Refresh files in the file browser's top row beside Upload, not the section header (KOBE-461 ac-3)", async () => {
    const { user, panel } = await open();
    await waitFor(() => expect(wakes()).toBe(1));
    const upload = within(panel).getByLabelText("Upload a file to the workspace root");
    const row = must(upload.closest("[data-kobe-drop-folder]"));
    const refresh = within(row as HTMLElement).getByRole("button", { name: "Refresh files" });
    expect(within(panel).getAllByRole("button", { name: "Refresh files" })).toEqual([refresh]);
    await user.click(refresh);
    await waitFor(() => expect(wakes()).toBe(2));
    expect(rootListings()).toBe(2);
  });

  it("is gone from the artifact column: the old side panel is removed", async () => {
    await open();
    act(() => void pressModShift("F"));
    const artifact = document.querySelector('[data-shell-region="artifact"]');
    expect(artifact?.childElementCount).toBe(0);
    expect(screen.queryByRole("region", { name: "Workspace files" })).toBeNull();
  });

  it("shows the last synced listing while waking, then refreshes", async () => {
    let release: () => void = () => {};
    wakeGate = new Promise<void>((r) => (release = r));
    const { panel } = await open();
    act(() => void pressModShift("F"));
    expect(await within(panel).findByText(/last synced/i)).toBeTruthy();
    const before = seen.filter((s) => s.url.startsWith("/v1/workspace/files")).length;
    await act(async () => release());
    // The refresh is a timer after the wake (4 s): wait for its request rather than racing it.
    await waitFor(
      () =>
        expect(seen.filter((s) => s.url.startsWith("/v1/workspace/files")).length).toBeGreaterThan(
          before,
        ),
      { timeout: 6000 },
    );
    await waitFor(() => expect(within(panel).queryByText(/last synced/i)).toBeNull());
  }, 10000);

  it("opens a folder in place and closes it again (the tree replaced the breadcrumb, KOBE-304)", async () => {
    const { user, panel } = await open();
    await user.click(within(panel).getByRole("treeitem", { name: "notes" }));
    await within(panel).findByText("todo.md");
    expect(seen.some((s) => s.url === "/v1/workspace/files?path=notes")).toBe(true);
    expect(within(panel).getByText("report.csv")).toBeTruthy();
    await user.click(within(panel).getByRole("treeitem", { name: "notes" }));
    await waitFor(() => expect(within(panel).queryByText("todo.md")).toBeNull());
  });

  it("each row has one ⋯ menu: Open, Download, Copy path, Delete (KOBE-292, ac-3)", async () => {
    const { user, panel } = await open();
    // No loose row icons any more.
    expect(within(panel).queryByRole("button", { name: "Download report.csv" })).toBeNull();
    expect(within(panel).queryByRole("button", { name: "Delete report.csv" })).toBeNull();
    const button = within(panel).getByRole("button", { name: "Actions for report.csv" });
    expect(button.getAttribute("aria-haspopup")).toBe("menu");
    // KOBE-304's compact rows take the 24 px button (WCAG 2.5.8's minimum; was 32 px, KOBE-269).
    expect(button.className).toMatch(/\bsize-6\b/);
    const menu = await rowMenu("report.csv");
    expect(menu.closest("[data-kobe-chat]")).not.toBeNull();
    // Rename and Move to… since the move API (KOBE-304); Mention in message for files (KOBE-374).
    expect(menuNames(menu)).toEqual([
      "Open",
      "Mention in message",
      "Download",
      "Rename",
      "Move to…",
      "Copy path",
      "Delete",
    ]);
    await user.keyboard("{Escape}");
    expect(document.activeElement).toBe(button);
    expect(menuNames(await rowMenu("notes"))).toEqual([
      "Open",
      "Rename",
      "Move to…",
      "Copy path",
      "Delete",
    ]);
    await user.keyboard("{Escape}");

    await fileAction(user, "notes", "Open");
    expect(await within(panel).findByText("todo.md")).toBeTruthy();
    await fileAction(user, "todo.md", "Copy path");
    await waitFor(async () => expect(await navigator.clipboard.readText()).toBe("notes/todo.md"));
    expect(await within(panel).findByText("Copied the path of todo.md")).toBeTruthy();
  });

  it("opens a file from its menu in the artifact column", async () => {
    const { user } = await open();
    await fileAction(user, "report.csv", "Open");
    expect(await screen.findByRole("tab", { name: "report.csv", selected: true })).toBeTruthy();
  });

  it("downloads a file", async () => {
    const create = vi.fn(() => "blob:x");
    const revoke = vi.fn();
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const { user } = await open();
    await fileAction(user, "report.csv", "Download");
    await waitFor(() => expect(click).toHaveBeenCalled());
    expect(seen.some((s) => s.url === "/v1/workspace/file?path=report.csv")).toBe(true);
    expect(revoke).toHaveBeenCalled();
  });

  it("asks before deleting, and deletes on confirm", async () => {
    const { user, panel } = await open();
    await fileAction(user, "report.csv", "Delete");
    const confirm = within(panel).getByRole("alertdialog");
    expect(confirm.textContent).toMatch(/report\.csv/);
    // The confirm keeps the focus the menu would give back to its button.
    await waitFor(() =>
      expect(document.activeElement).toBe(within(confirm).getByRole("button", { name: "Cancel" })),
    );
    expect(seen.some((s) => s.method === "DELETE")).toBe(false);
    await user.click(within(confirm).getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(
        seen.some((s) => s.method === "DELETE" && s.url === "/v1/workspace/files?path=report.csv"),
      ).toBe(true),
    );
    await waitFor(() => expect(within(panel).queryByRole("alertdialog")).toBeNull());
  });

  it("cancelling the confirmation deletes nothing", async () => {
    const { user, panel } = await open();
    await fileAction(user, "report.csv", "Delete");
    await user.click(within(panel).getByRole("button", { name: "Cancel" }));
    expect(within(panel).queryByRole("alertdialog")).toBeNull();
    // The focus is back on the row (KOBE-304: the tree's row, which owns the tab stop).
    expect(document.activeElement).toBe(
      within(panel).getByRole("treeitem", { name: "report.csv" }),
    );
    expect(seen.some((s) => s.method === "DELETE")).toBe(false);
  });

  it("explains a legal hold on delete", async () => {
    overrides["DELETE /v1/workspace/files"] = () =>
      Response.json({ code: "legal_hold", message: "held" }, { status: 409 });
    const { user, panel } = await open();
    await fileAction(user, "report.csv", "Delete");
    await user.click(
      within(within(panel).getByRole("alertdialog")).getByRole("button", { name: "Delete" }),
    );
    const alert = await within(panel).findByRole("alert");
    expect(alert.textContent).toMatch(/legal hold/i);
  });

  it("treats the current 409 read_only as a legal hold", async () => {
    overrides["DELETE /v1/workspace/files"] = () =>
      Response.json({ code: "read_only", message: "under a legal hold" }, { status: 409 });
    const { user, panel } = await open();
    await fileAction(user, "report.csv", "Delete");
    await user.click(
      within(within(panel).getByRole("alertdialog")).getByRole("button", { name: "Delete" }),
    );
    expect((await within(panel).findByRole("alert")).textContent).toMatch(/legal hold/i);
  });

  it("marks uploads and projects read-only, with no upload there; rail drops can be deleted", async () => {
    const { user, panel } = await open();
    expect(within(panel).getAllByText("Read-only").length).toBeGreaterThan(0);
    // Read-only rows offer no Delete (KOBE-292: in their menus).
    expect(menuNames(await rowMenu("uploads"))).toEqual(["Open", "Copy path"]);
    await user.keyboard("{Escape}");
    await user.click(within(panel).getByRole("treeitem", { name: "uploads" }));
    await within(panel).findByText("brief.pdf");
    expect(menuNames(await rowMenu("0b7f3c1e-2d4a-4e5b-8c6d-7e8f9a0b1c2d"))).toEqual([
      "Open",
      "Copy path",
    ]);
    await user.keyboard("{Escape}");
    // A file directly in uploads/ is a rail drop (KOBE-199): its owner may delete it.
    expect(menuNames(await rowMenu("brief.pdf"))).toEqual([
      "Open",
      "Mention in message",
      "Download",
      "Rename",
      "Move to…",
      "Copy path",
      "Delete",
    ]);
    await user.keyboard("{Escape}");
    expect(within(panel).queryByLabelText(/Upload a file/)).toBeNull();
    expect(within(panel).getByText(/read-only/i, { selector: "p" })).toBeTruthy();
  });

  it("uploads into the current folder", async () => {
    const { user, panel } = await open();
    await user.click(within(panel).getByRole("treeitem", { name: "notes" }));
    await within(panel).findByText("todo.md");
    const input = within(panel).getByLabelText("Upload a file to notes");
    await user.upload(input, new File(["hello"], "up.txt", { type: "text/plain" }));
    await waitFor(() =>
      expect(seen.some((s) => s.method === "POST" && s.url === "/v1/workspace/files")).toBe(true),
    );
    await waitFor(() => expect(within(panel).getByText(/Uploaded up\.txt/)).toBeTruthy());
  });

  it("shows a read-only error from an upload", async () => {
    overrides["POST /v1/workspace/files"] = () =>
      Response.json({ code: "already_exists", message: "up.txt already exists." }, { status: 409 });
    const { user, panel } = await open();
    await user.upload(
      within(panel).getByLabelText("Upload a file to the workspace root"),
      new File(["x"], "up.txt"),
    );
    expect((await within(panel).findByRole("alert")).textContent).toMatch(/already exists/);
  });

  it("shows a listing error", async () => {
    overrides["GET /v1/workspace/files"] = () =>
      Response.json(
        { code: "sandbox_unavailable", message: "Workspace storage is not configured." },
        { status: 503 },
      );
    mount();
    const panel = await screen.findByRole("region", { name: "Files" });
    expect((await within(panel).findByRole("alert")).textContent).toMatch(/Workspace storage/);
  });
});
