// @vitest-environment happy-dom
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
import type { UploadOutcome, UploadRequest, UploadTransport } from "../../lib/chat/uploads";
import { chatRequests, composer, openApp } from "./testing";

/** Attachment follow-ups (KOBE-194): chips after a reload, and a failed send to a new thread. */
let fake: FakeKobe;
let created: string[];

beforeEach(() => {
  sessionStorage.clear();
  fake = new FakeKobe();
  created = [];
  vi.stubGlobal("fetch", fake.fetch);
  Object.assign(URL, {
    createObjectURL: (b: Blob) => {
      created.push(b.type);
      return `blob:chip-${created.length}`;
    },
    revokeObjectURL: () => {},
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function sentMessage(threadId: string) {
  const text =
    "Look\n\nAttached files:\n" +
    `- /workspace/uploads/${threadId}/pic.png (image/png) - shown to you as an image\n` +
    `- /workspace/uploads/${threadId}/data.csv (text/csv)\n` +
    `- /workspace/uploads/${threadId}/logo.svg (image/svg+xml)`;
  fake.addEntry(threadId, null, { role: "user", content: [{ type: "text", text }] });
}

describe("chips after a reload", () => {
  it("shows size and a thumbnail from one listing of the thread's uploads", async () => {
    const t = fake.addThread("Old");
    sentMessage(t);
    fake.workspaceFiles.set(`uploads/${t}/pic.png`, new Uint8Array(2048));
    fake.workspaceFiles.set(`uploads/${t}/data.csv`, new Uint8Array(1500));
    fake.workspaceFiles.set(`uploads/${t}/logo.svg`, new Uint8Array(10));
    openApp(fake, t);
    const chips = await screen.findByRole("list", { name: "Attached files" });
    await waitFor(() => expect(chips.textContent).toContain("2 KB"));
    expect(chips.textContent).toContain("1.5 KB");
    // One listing for the whole thread, not one request per file.
    expect(fake.workspaceListings).toEqual([`uploads/${t}`]);
    // Only a raster image gets a thumbnail, and it is a blob URL typed from the allowlist.
    await waitFor(() => expect(chips.querySelectorAll("img")).toHaveLength(1));
    expect(chips.querySelector("img")?.getAttribute("src")).toBe("blob:chip-1");
    expect(created).toEqual(["image/png"]);
    expect(within(chips).getByText("logo.svg")).toBeTruthy();
  });

  it("keeps the name when the file cannot be looked up", async () => {
    const t = fake.addThread("Old");
    sentMessage(t);
    openApp(fake, t);
    const chips = await screen.findByRole("list", { name: "Attached files" });
    expect(within(chips).getByText("pic.png")).toBeTruthy();
    expect(chips.querySelectorAll("img")).toHaveLength(0);
  });
});

describe("a failed send from a brand-new thread", () => {
  let upload: UploadTransport;
  beforeEach(() => {
    upload = async (request: UploadRequest): Promise<UploadOutcome> => ({
      ok: true,
      file: {
        fileId: "00000000-0000-4000-8000-000000000001",
        name: request.file.name,
        mimeType: "text/plain",
        sizeBytes: request.file.size,
      },
    });
  });

  async function attachAndType() {
    const user = userEvent.setup();
    openApp(fake, undefined, upload);
    await composer();
    await user.upload(
      await screen.findByLabelText("Choose files to attach"),
      new File(["abc"], "notes.txt", { type: "text/plain" }),
    );
    await screen.findByText("Ready");
    await user.type(await composer(), "Read this");
    return user;
  }

  it("keeps the files in the composer when the thread cannot be created", async () => {
    fake.failNext.set(
      "POST /v1/threads",
      new Response(JSON.stringify({ code: "boom", message: "Down." }), { status: 503 }),
    );
    const user = await attachAndType();
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(fake.failNext.size).toBe(0));
    expect(await screen.findByRole("list", { name: "Attached files" })).toBeTruthy();
    expect(((await composer()) as HTMLTextAreaElement).value).toBe("Read this");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(
        chatRequests(fake, "POST").find((r) => r.path.endsWith("/messages"))?.body,
      ).toMatchObject({ file_ids: ["00000000-0000-4000-8000-000000000001"] }),
    );
  });

  it("moves the files to the new thread when it was created but the message was refused", async () => {
    const user = await attachAndType();
    fake.failNext.set(
      "POST /v1/threads/00000000-0000-4000-8000-000200000001/messages",
      new Response(JSON.stringify({ code: "boom", message: "Refused." }), { status: 500 }),
    );
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(fake.failNext.size).toBe(0));
    // Not stuck under the abandoned "new" draft: still visible, removable and resendable.
    const list = await screen.findByRole("list", { name: "Attached files" });
    expect(within(list).getByText("notes.txt")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(
        chatRequests(fake, "POST")
          .filter((r) => r.path.endsWith("/messages"))
          .at(-1)?.body,
      ).toMatchObject({ file_ids: ["00000000-0000-4000-8000-000000000001"] }),
    );
  });
});
