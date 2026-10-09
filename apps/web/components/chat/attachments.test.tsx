// @vitest-environment happy-dom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
import type { UploadOutcome, UploadRequest, UploadTransport } from "../../lib/chat/uploads";
import { chatRequests, composer, openApp } from "./testing";

/** Composer attachments (KOBE-145): pick or drop, progress, remove, errors, file_ids on send. */
let fake: FakeKobe;
let calls: { request: UploadRequest; finish: (o: UploadOutcome) => void }[];
let n: number;

const transport: UploadTransport = (request) =>
  new Promise((resolve) => {
    calls.push({ request, finish: resolve });
  });

const okOutcome = (file: File): UploadOutcome => ({
  ok: true,
  file: {
    fileId: `00000000-0000-4000-8000-${String((n += 1)).padStart(12, "0")}`,
    name: file.name,
    mimeType: file.type,
    sizeBytes: file.size,
  },
});

beforeEach(() => {
  sessionStorage.clear();
  fake = new FakeKobe();
  calls = [];
  n = 0;
  vi.stubGlobal("fetch", fake.fetch);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const fileOf = (name: string, size = 3) => {
  const f = new File(["abc"], name, { type: "text/plain" });
  Object.defineProperty(f, "size", { value: size });
  return f;
};

async function pick(...files: File[]) {
  const user = userEvent.setup();
  openApp(fake, undefined, transport);
  await composer();
  await user.upload(await screen.findByLabelText("Choose files to attach"), files);
  return user;
}

describe("composer attachments", () => {
  it("uploads a picked file at once, shows progress, and lets you remove it", async () => {
    const user = await pick(fileOf("notes.txt", 2048));
    const list = await screen.findByRole("list", { name: "Attached files" });
    expect(within(list).getByText("notes.txt")).toBeTruthy();
    expect(calls).toHaveLength(1);
    calls[0]?.request.onProgress(0.4);
    const bar = await screen.findByRole("progressbar", { name: "Uploading notes.txt" });
    expect(bar.getAttribute("value")).toBe("40");
    calls[0]?.finish(okOutcome(fileOf("notes.txt")));
    await screen.findByText("Ready");

    await user.click(screen.getByRole("button", { name: "Remove notes.txt" }));
    expect(screen.queryByRole("list", { name: "Attached files" })).toBeNull();
  });

  it("cancels the upload when a file is removed while uploading", async () => {
    const user = await pick(fileOf("big.bin"));
    await user.click(await screen.findByRole("button", { name: "Remove big.bin" }));
    expect(calls[0]?.request.signal.aborted).toBe(true);
  });

  it("refuses a file over the limit without uploading it", async () => {
    await pick(fileOf("huge.iso", 101 * 1024 * 1024));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("larger than the 100 MB limit");
    expect(calls).toHaveLength(0);
  });

  it("accepts files dropped on the composer", async () => {
    openApp(fake, undefined, transport);
    const input = await composer();
    const root = input.closest("form")?.firstElementChild as HTMLElement;
    fireEvent.drop(root, { dataTransfer: { types: ["Files"], files: [fileOf("dropped.csv")] } });
    expect(await screen.findByText("dropped.csv")).toBeTruthy();
    expect(calls).toHaveLength(1);
  });

  it("shows the server's refusal for a file and blocks sending until it is removed", async () => {
    const user = await pick(fileOf("bad.exe"));
    await waitFor(() => expect(calls).toHaveLength(1));
    calls[0]?.finish({
      ok: false,
      error: {
        code: "scan_rejected",
        message: "The virus scan rejected this file.",
        retryable: false,
      },
    });
    expect((await screen.findByRole("alert")).textContent).toContain("virus scan rejected");
    await user.type(await composer(), "hello");
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole("button", { name: "Remove bad.exe" }));
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
  });

  it("offers a retry for a retryable failure", async () => {
    const user = await pick(fileOf("a.txt"));
    await waitFor(() => expect(calls).toHaveLength(1));
    calls[0]?.finish({
      ok: false,
      error: { code: "scan_unavailable", message: "Scanner unavailable.", retryable: true },
    });
    await user.click(await screen.findByRole("button", { name: "Retry a.txt" }));
    await waitFor(() => expect(calls).toHaveLength(2));
  });

  it("holds Send while uploading, then sends the file ids and shows chips on the message", async () => {
    const user = await pick(fileOf("data.csv", 1500));
    await user.type(await composer(), "Analyse this");
    const send = screen.getByRole("button", { name: "Send" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    expect(screen.getByText(/finish uploading/)).toBeTruthy();

    const call = calls[0];
    call?.finish(okOutcome(fileOf("data.csv", 1500)));
    await screen.findByText("Ready");
    await waitFor(() => expect(send.disabled).toBe(false));
    await user.click(send);

    await waitFor(() =>
      expect(chatRequests(fake, "POST").some((r) => r.path.endsWith("/messages"))).toBe(true),
    );
    const body = chatRequests(fake, "POST").find((r) => r.path.endsWith("/messages"))?.body as {
      content: string;
      file_ids: string[];
    };
    expect(body.content).toBe("Analyse this");
    expect(body.file_ids).toEqual(["00000000-0000-4000-8000-000000000001"]);
    // The draft is empty again and the sent message carries the chip with name and size.
    await waitFor(() =>
      expect(screen.getAllByRole("list", { name: "Attached files" })).toHaveLength(1),
    );
    const chips = screen.getByRole("list", { name: "Attached files" });
    expect(within(chips).getByText("data.csv")).toBeTruthy();
    expect(chips.textContent).toContain("1.5 KB");
    expect(chips.closest('[data-role="user"]')).toBeTruthy();
  });
});
