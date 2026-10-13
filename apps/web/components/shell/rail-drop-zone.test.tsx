// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
import type { UploadRequest, UploadTransport } from "../../lib/chat/uploads";
import { ChatApp } from "../chat/chat-app";
import { chatRequests, composer } from "../chat/testing";
import { DROP_NOTICE_MS } from "./rail-drop-zone";

/** The rail drop zone (CE5, KOBE-199): overlay, upload into uploads/, errors, touch, composer. */

interface Upload {
  readonly path: string;
  readonly name: string;
}

let fake: FakeKobe;
let uploads: Upload[];
let wakes: number;
let listed: string[];
let answers: (() => Response)[];
/** While set, each upload waits for it (overlapping drops). */
let uploadGate: Promise<void>;
let touch: boolean;
let attachCalls: UploadRequest[];

const entry = (name: string, path: string, type: "file" | "dir", area = "workspace") => ({
  name,
  path,
  type,
  size_bytes: type === "dir" ? null : 3,
  mtime: "2026-10-01T10:00:00.000Z",
  source: "synced",
  owner: "server",
  area,
});

const refusal = (status: number, code: string, message: string) => () =>
  Response.json({ code, message }, { status });

const fetchFn: typeof fetch = async (input, init = {}) => {
  const url = String(input);
  if (!url.startsWith("/v1/workspace/")) return fake.fetch(input, init);
  const method = init.method ?? "GET";
  const route = `${method} ${url.split("?")[0]}`;
  if (route === "POST /v1/workspace/wake") {
    wakes += 1;
    return Response.json({ status: "waking" }, { status: 202 });
  }
  if (route === "GET /v1/workspace/files") {
    const path = new URL(url, "http://x").searchParams.get("path") ?? "";
    listed.push(path);
    const entries =
      path === "uploads"
        ? uploads.map((u) => entry(u.name, `uploads/${u.name}`, "file", "uploads"))
        : [entry("uploads", "uploads", "dir", "uploads")];
    return Response.json({ path, entries });
  }
  if (route === "POST /v1/workspace/files") {
    const form = init.body as FormData;
    const file = form.get("file") as File;
    await uploadGate;
    const answer = answers.shift();
    if (answer) return answer();
    // The server picks a free name on a clash (KOBE-199): "name (n).ext".
    let name = file.name;
    for (let n = 1; uploads.some((u) => u.name === name); n += 1) {
      name = file.name.replace(/(\.[^.]*)?$/, (ext) => ` (${n})${ext}`);
    }
    const up = { path: String(form.get("path")), name };
    uploads.push(up);
    return Response.json(entry(up.name, `uploads/${up.name}`, "file", "uploads"), { status: 201 });
  }
  return new Response(null, { status: 500 });
};

const attachTransport: UploadTransport = (request) => {
  attachCalls.push(request);
  return new Promise(() => {});
};

function matchMedia(query: string) {
  // A desktop window (the shell's min-width bands match), with or without touch.
  const matches = query.includes("pointer: coarse") ? touch : query.includes("min-width");
  return {
    matches,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  } as unknown as MediaQueryList;
}

beforeEach(() => {
  fake = new FakeKobe();
  uploads = [];
  wakes = 0;
  listed = [];
  answers = [];
  uploadGate = Promise.resolve();
  touch = false;
  attachCalls = [];
  sessionStorage.clear();
  vi.stubGlobal("fetch", fetchFn);
  vi.spyOn(window, "matchMedia").mockImplementation(matchMedia);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const fileOf = (name: string) => new File(["abc"], name, { type: "text/plain" });
const files = (...list: File[]) => ({ dataTransfer: { types: ["Files"], files: list } });
/** A drop carrying items, as browsers send them: folders show up as directory entries. */
const items = (list: readonly (File | string)[]) => ({
  dataTransfer: {
    types: ["Files"],
    files: list.filter((f): f is File => f instanceof File),
    items: list.map((f) => ({
      kind: "file",
      getAsFile: () => (f instanceof File ? f : null),
      webkitGetAsEntry: () =>
        f instanceof File ? { isDirectory: false, name: f.name } : { isDirectory: true, name: f },
    })),
  },
});

async function mount() {
  window.history.replaceState(null, "", "/");
  render(
    <ChatApp fetchFn={fetchFn} eventSource={fake.eventSource} uploadTransport={attachTransport} />,
  );
  const rail = await screen.findByRole("complementary", { name: "Workspace" });
  await screen.findByRole("heading", { name: "Finance" });
  return rail;
}

/** A dragleave with no element entered (happy-dom has no DragEvent; the fields are MouseEvent's). */
const leaveTo = (clientX: number, clientY: number) =>
  act(() => {
    document.body.dispatchEvent(new MouseEvent("dragleave", { bubbles: true, clientX, clientY }));
  });
const overlay = () => screen.queryByText("Drop to add to your workspace");
const filesRegion = () => screen.getByRole("region", { name: "Files" });

describe("rail drop zone: overlay (ac-1)", () => {
  it("shows over the whole rail while files are dragged, without flicker over its children", async () => {
    const rail = await mount();
    const threads = within(rail).getByRole("region", { name: "Threads" });
    fireEvent.dragEnter(rail, files(fileOf("a.txt")));
    expect(overlay()).toBeTruthy();
    fireEvent.dragEnter(threads, files(fileOf("a.txt")));
    fireEvent.dragLeave(rail, files(fileOf("a.txt")));
    expect(overlay()).toBeTruthy(); // moved onto a child: still over the rail
    fireEvent.dragLeave(threads, files(fileOf("a.txt")));
    expect(overlay()).toBeNull();
  });

  it("ignores drags that carry no files (text, links)", async () => {
    const rail = await mount();
    fireEvent.dragEnter(rail, { dataTransfer: { types: ["text/plain"], files: [] } });
    expect(overlay()).toBeNull();
  });

  it("clears on dragend, on a drop elsewhere and when the drag leaves the window", async () => {
    const rail = await mount();
    fireEvent.dragEnter(rail, files(fileOf("a.txt")));
    fireEvent.dragEnd(window);
    expect(overlay()).toBeNull();

    fireEvent.dragEnter(rail, files(fileOf("a.txt")));
    fireEvent.drop(window);
    expect(overlay()).toBeNull();

    fireEvent.dragEnter(rail, files(fileOf("a.txt")));
    leaveTo(200, 200); // still inside the window: no change
    expect(overlay()).toBeTruthy();
    leaveTo(0, 200);
    expect(overlay()).toBeNull();
  });

  it("covers the collapsed rail too", async () => {
    const rail = await mount();
    await userEvent.setup().click(screen.getByRole("button", { name: "Collapse the rail" }));
    fireEvent.dragOver(rail, files(fileOf("a.txt")));
    expect(overlay()).toBeTruthy();
  });
});

describe("rail drop zone: upload (ac-1)", () => {
  it("uploads into uploads/, wakes and lists Files as its first use, and sends no message", async () => {
    const rail = await mount();
    expect(wakes).toBe(0);
    fireEvent.dragEnter(rail, files(fileOf("brief.pdf")));
    fireEvent.drop(rail, files(fileOf("brief.pdf"), fileOf("data.csv")));
    expect(overlay()).toBeNull();
    const region = filesRegion();
    expect(await within(region).findByText("data.csv")).toBeTruthy();
    expect(within(region).getByText("brief.pdf")).toBeTruthy();
    expect(uploads).toEqual([
      { path: "uploads", name: "brief.pdf" },
      { path: "uploads", name: "data.csv" },
    ]);
    expect(
      within(region).getByText("Added brief.pdf, data.csv to uploads.").getAttribute("role"),
    ).toBe("status");
    expect(listed).toContain("uploads");
    await waitFor(() => expect(wakes).toBe(1));
    expect(chatRequests(fake, "POST")).toEqual([]);
    expect(attachCalls).toEqual([]);
    expect(screen.queryByRole("list", { name: "Attached files" })).toBeNull();
  });

  it("shows the name the server chose on a clash, sending each file once", async () => {
    const rail = await mount();
    uploads.push({ path: "uploads", name: "brief.pdf" });
    fireEvent.drop(rail, files(fileOf("brief.pdf")));
    expect(await screen.findByText("Added brief (1).pdf to uploads.")).toBeTruthy();
    expect(uploads.map((u) => u.name)).toEqual(["brief.pdf", "brief (1).pdf"]);
  });

  it("puts a drop made while another uploads into the same batch, with one status", async () => {
    const rail = await mount();
    let release = () => {};
    uploadGate = new Promise((resolve) => (release = resolve));
    fireEvent.drop(rail, files(fileOf("a.txt")));
    fireEvent.drop(rail, files(fileOf("b.txt")));
    expect(await screen.findByText("Adding 2 files to your workspace…")).toBeTruthy();
    release();
    expect(await screen.findByText("Added a.txt, b.txt to uploads.")).toBeTruthy();
    expect(uploads.map((u) => u.name)).toEqual(["a.txt", "b.txt"]);
    await waitFor(() => expect(wakes).toBe(1)); // Files revealed once for the batch
  });

  it("clears the success notice after a while, and errors on the next Files action", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setTimeout", "clearTimeout"] });
    try {
      const rail = await mount();
      fireEvent.drop(rail, files(fileOf("a.txt")));
      expect(await screen.findByText("Added a.txt to uploads.")).toBeTruthy();
      act(() => vi.advanceTimersByTime(DROP_NOTICE_MS));
      expect(screen.queryByText("Added a.txt to uploads.")).toBeNull();

      answers.push(refusal(413, "file_too_large", "Too big."));
      fireEvent.drop(rail, files(fileOf("huge.iso")));
      expect(await within(filesRegion()).findByRole("alert")).toBeTruthy();
      fireEvent.click(within(filesRegion()).getByRole("button", { name: "Refresh files" }));
      expect(within(filesRegion()).queryByRole("alert")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses folders by name and still uploads the files beside them", async () => {
    const rail = await mount();
    fireEvent.drop(rail, items([fileOf("a.txt"), "photos"]));
    const alert = await within(filesRegion()).findByRole("alert");
    expect(alert.textContent).toContain("Folders can't be added to your workspace (photos)");
    expect(await within(filesRegion()).findByText("a.txt")).toBeTruthy();
    expect(uploads.map((u) => u.name)).toEqual(["a.txt"]);
  });
});

describe("rail drop zone: errors and touch (ac-3)", () => {
  it("shows a full workspace in Files and stops the remaining files", async () => {
    const rail = await mount();
    answers.push(refusal(507, "quota_exceeded", "Your workspace has no room for this file."));
    fireEvent.drop(rail, files(fileOf("big.bin"), fileOf("next.bin")));
    const alert = await within(filesRegion()).findByRole("alert");
    expect(alert.textContent).toContain(
      "big.bin: Your workspace is full. Delete something and try again.",
    );
    expect(uploads).toEqual([]);
    expect(wakes).toBe(0); // nothing landed: no wake
  });

  it("reports a file over the size limit and adds the others; a collapsed rail opens to show it", async () => {
    const rail = await mount();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Collapse the rail" }));
    answers.push(refusal(413, "file_too_large", "Files over 1048576 bytes are not accepted."));
    fireEvent.drop(rail, files(fileOf("huge.iso"), fileOf("ok.txt")));
    const region = await screen.findByRole("region", { name: "Files" }); // the rail opened
    const alert = await within(region).findByRole("alert");
    expect(alert.textContent).toContain("huge.iso: That file is too large to upload.");
    expect(await within(region).findByText("ok.txt")).toBeTruthy();
    expect(rail.hasAttribute("data-collapsed")).toBe(false);
  });

  it("has no drop zone on touch devices", async () => {
    touch = true;
    const rail = await mount();
    fireEvent.dragEnter(rail, files(fileOf("a.txt")));
    expect(overlay()).toBeNull();
    const notHandled = fireEvent.drop(rail, files(fileOf("a.txt")));
    expect(notHandled).toBe(true); // default not prevented: the rail did not take it
    expect(uploads).toEqual([]);
  });
});

describe("composer drop (ac-2)", () => {
  it("still attaches to the message and never reaches the rail", async () => {
    await mount();
    const input = await composer();
    const root = input.closest("form")?.firstElementChild as HTMLElement;
    fireEvent.dragOver(root, files(fileOf("notes.txt")));
    expect(overlay()).toBeNull();
    fireEvent.drop(root, files(fileOf("notes.txt")));
    const list = await screen.findByRole("list", { name: "Attached files" });
    expect(within(list).getByText("notes.txt")).toBeTruthy();
    expect(attachCalls).toHaveLength(1);
    expect(uploads).toEqual([]);
    expect(overlay()).toBeNull();
  });
});
