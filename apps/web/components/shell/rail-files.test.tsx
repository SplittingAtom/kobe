// @vitest-environment happy-dom
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
import { ChatApp } from "../chat/chat-app";

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
  uploads: [entry("brief.pdf", "uploads/brief.pdf", "file", "uploads")],
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

/** The rail's Files section, once the root is listed. */
async function open() {
  const user = userEvent.setup();
  mount();
  const panel = await screen.findByRole("region", { name: "Files" });
  await within(panel).findByText("report.csv");
  return { user, panel };
}

const woken = () => seen.some((s) => s.method === "POST" && s.url === "/v1/workspace/wake");

beforeEach(() => {
  seen = [];
  overrides = {};
  fake = new FakeKobe();
  wakeGate = Promise.resolve();
  sessionStorage.clear();
  vi.stubGlobal("fetch", fetchFn);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Files in the workspace rail (KOBE-198, ac-3)", () => {
  it("lists /workspace with its folders, and wakes the sandbox only once Files is used", async () => {
    const { user, panel } = await open();
    expect(within(panel).getByRole("button", { name: "Open folder notes" })).toBeTruthy();
    expect(within(panel).getByRole("button", { name: "Open folder uploads" })).toBeTruthy();
    expect(within(panel).getAllByText("2 KB").length).toBeGreaterThan(0);
    expect(woken()).toBe(false);
    await user.click(within(panel).getByRole("button", { name: "Open folder notes" }));
    await waitFor(() => expect(woken()).toBe(true));
  });

  it("shows Files from the bar: the section takes focus and the sandbox wakes", async () => {
    const { user } = await open();
    await user.click(screen.getByRole("button", { name: "Files" }));
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("region", { name: "Files" })),
    );
    await waitFor(() => expect(woken()).toBe(true));
  });

  it("is gone from the artifact column: the old side panel is removed", async () => {
    const { user } = await open();
    await user.click(screen.getByRole("button", { name: "Files" }));
    const artifact = document.querySelector('[data-shell-region="artifact"]');
    expect(artifact?.childElementCount).toBe(0);
    expect(screen.queryByRole("region", { name: "Workspace files" })).toBeNull();
  });

  it("shows the last synced listing while waking, then refreshes", async () => {
    let release: () => void = () => {};
    wakeGate = new Promise<void>((r) => (release = r));
    const { user, panel } = await open();
    await user.click(screen.getByRole("button", { name: "Files" }));
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

  it("navigates into a folder and back with the breadcrumb", async () => {
    const { user, panel } = await open();
    await user.click(within(panel).getByRole("button", { name: "Open folder notes" }));
    await within(panel).findByText("todo.md");
    expect(seen.some((s) => s.url === "/v1/workspace/files?path=notes")).toBe(true);
    const crumbs = within(panel).getByRole("navigation", { name: "Folder path" });
    await user.click(within(crumbs).getByRole("button", { name: "Workspace" }));
    await within(panel).findByText("report.csv");
  });

  it("downloads a file", async () => {
    const create = vi.fn(() => "blob:x");
    const revoke = vi.fn();
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const { user, panel } = await open();
    await user.click(within(panel).getByRole("button", { name: "Download report.csv" }));
    await waitFor(() => expect(click).toHaveBeenCalled());
    expect(seen.some((s) => s.url === "/v1/workspace/file?path=report.csv")).toBe(true);
    expect(revoke).toHaveBeenCalled();
  });

  it("asks before deleting, and deletes on confirm", async () => {
    const { user, panel } = await open();
    await user.click(within(panel).getByRole("button", { name: "Delete report.csv" }));
    const confirm = within(panel).getByRole("alertdialog");
    expect(confirm.textContent).toMatch(/report\.csv/);
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
    await user.click(within(panel).getByRole("button", { name: "Delete report.csv" }));
    await user.click(within(panel).getByRole("button", { name: "Cancel" }));
    expect(within(panel).queryByRole("alertdialog")).toBeNull();
    expect(seen.some((s) => s.method === "DELETE")).toBe(false);
  });

  it("explains a legal hold on delete", async () => {
    overrides["DELETE /v1/workspace/files"] = () =>
      Response.json({ code: "legal_hold", message: "held" }, { status: 409 });
    const { user, panel } = await open();
    await user.click(within(panel).getByRole("button", { name: "Delete report.csv" }));
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
    await user.click(within(panel).getByRole("button", { name: "Delete report.csv" }));
    await user.click(
      within(within(panel).getByRole("alertdialog")).getByRole("button", { name: "Delete" }),
    );
    expect((await within(panel).findByRole("alert")).textContent).toMatch(/legal hold/i);
  });

  it("marks uploads and projects read-only, with no upload or delete there", async () => {
    const { user, panel } = await open();
    expect(within(panel).getAllByText("Read-only").length).toBeGreaterThan(0);
    expect(within(panel).queryByRole("button", { name: "Delete uploads" })).toBeNull();
    await user.click(within(panel).getByRole("button", { name: "Open folder uploads" }));
    await within(panel).findByText("brief.pdf");
    expect(within(panel).queryByRole("button", { name: "Delete brief.pdf" })).toBeNull();
    expect(within(panel).queryByLabelText(/Upload a file/)).toBeNull();
    expect(within(panel).getByText(/read-only/i, { selector: "p" })).toBeTruthy();
    expect(within(panel).getByRole("button", { name: "Download brief.pdf" })).toBeTruthy();
  });

  it("uploads into the current folder", async () => {
    const { user, panel } = await open();
    await user.click(within(panel).getByRole("button", { name: "Open folder notes" }));
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
