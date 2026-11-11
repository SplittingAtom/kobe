// @vitest-environment happy-dom
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tabsKey } from "../../lib/chat/artifact-tabs";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
import { sha256Hex } from "../../lib/files/editor";
import { must } from "../../lib/testing/must";
import { openApp } from "../chat/testing";
import { CHANGED_AGAIN_NOTE } from "./save-as";

/**
 * KOBE-615 ac-3: Save As saves the editor's text (unsaved changes included) to a new path, never
 * silently over a file that is there (Replace asks, at the version it finds), and opens the copy
 * in the tab. Read-only files offer Save As into My files but not Save.
 */
let fake: FakeKobe;
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array | undefined) =>
  b === undefined ? undefined : new TextDecoder().decode(b);

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  fake = new FakeKobe();
  vi.stubGlobal("fetch", fake.fetch);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function threadWithFile(path: string, content: string) {
  fake.workspaceFiles.set(path, enc(content));
  const thread = fake.addThread("Notes");
  const u = fake.addEntry(thread, null, { role: "user", content: "hi" });
  fake.addEntry(thread, u, { role: "assistant", content: [{ type: "text", text: "done" }] });
  const tab = `file:${path}`;
  localStorage.setItem(tabsKey(fake.teamId, thread), JSON.stringify({ open: [tab], active: tab }));
  return thread;
}

async function editorView(label: string): Promise<EditorView> {
  const content = await screen.findByLabelText(label);
  return must(EditorView.findFromDOM(content as HTMLElement));
}

async function openSaveAs(user: ReturnType<typeof userEvent.setup>, name: string) {
  const toolbar = await screen.findByRole("toolbar", { name: `${name} view` });
  await user.click(within(toolbar).getByRole("button", { name: "Save As" }));
  const dialog = screen.getByRole("dialog", { name: "Save as" });
  return { dialog, input: within(dialog).getByRole("textbox", { name: "Save as" }) };
}

describe("Save As (ac-3)", () => {
  it("saves the draft to a new path and opens the copy in the tab", async () => {
    const thread = threadWithFile("docs/notes.md", "# Plan\n");
    openApp(fake, thread);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("switch", { name: "Raw" }));
    const view = await editorView("Edit notes.md");
    act(() => view.dispatch({ changes: { from: view.state.doc.length, insert: "draft\n" } }));
    expect(await screen.findByText("Unsaved changes.")).toBeTruthy();

    const { dialog, input } = await openSaveAs(user, "notes.md");
    expect((input as HTMLInputElement).value).toBe("docs/notes-copy.md");
    await user.click(within(dialog).getByRole("button", { name: "Save copy" }));

    await waitFor(() =>
      expect(dec(fake.workspaceFiles.get("docs/notes-copy.md"))).toBe("# Plan\ndraft\n"),
    );
    // Created: no base version was named.
    expect(fake.workspaceSaves).toEqual([
      { path: "docs/notes-copy.md", base: "", text: "# Plan\ndraft\n" },
    ]);
    // The original is untouched and its unsaved changes went with the copy.
    expect(dec(fake.workspaceFiles.get("docs/notes.md"))).toBe("# Plan\n");
    expect(await screen.findByRole("tab", { name: "notes-copy.md", selected: true })).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "notes.md" })).toBeNull();
    expect(screen.queryByText("Unsaved changes.")).toBeNull();
  });

  it("never overwrites silently: an existing path asks, and Replace saves at its version", async () => {
    fake.workspaceFiles.set("docs/other.md", enc("theirs\n"));
    const thread = threadWithFile("docs/notes.md", "mine\n");
    openApp(fake, thread);
    const user = userEvent.setup();
    const { dialog, input } = await openSaveAs(user, "notes.md");
    await user.clear(input);
    await user.type(input, "docs/other.md");
    await user.click(within(dialog).getByRole("button", { name: "Save copy" }));
    const ask = await within(dialog).findByRole("alertdialog");
    expect(ask.textContent).toContain("docs/other.md already exists. Replace it with this text?");
    expect(dec(fake.workspaceFiles.get("docs/other.md"))).toBe("theirs\n");

    // Keep it goes back to the path; Replace saves over exactly the listed version.
    await user.click(within(ask).getByRole("button", { name: "Keep it" }));
    expect(within(dialog).queryByRole("alertdialog")).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: "Save copy" }));
    await user.click(await within(dialog).findByRole("button", { name: "Replace" }));
    await waitFor(() => expect(dec(fake.workspaceFiles.get("docs/other.md"))).toBe("mine\n"));
    expect(fake.workspaceSaves.at(-1)?.base).toBe(await sha256Hex(enc("theirs\n")));
    expect(await screen.findByRole("tab", { name: "other.md", selected: true })).toBeTruthy();
  });

  it("a file that changed again before Replace is refused again, never overwritten", async () => {
    fake.workspaceFiles.set("other.md", enc("v1\n"));
    const thread = threadWithFile("notes.md", "mine\n");
    openApp(fake, thread);
    const user = userEvent.setup();
    const { dialog, input } = await openSaveAs(user, "notes.md");
    await user.clear(input);
    await user.type(input, "other.md");
    await user.click(within(dialog).getByRole("button", { name: "Save copy" }));
    await within(dialog).findByRole("alertdialog");
    // Someone saves between the listing and the save: the save at the listed version is refused.
    fake.failNext.set(
      "PUT /v1/workspace/file",
      new Response(
        JSON.stringify({ code: "version_conflict", message: "changed", current: null }),
        {
          status: 409,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    await user.click(within(dialog).getByRole("button", { name: "Replace" }));
    expect(await within(dialog).findByText(CHANGED_AGAIN_NOTE)).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Replace" })).toBeTruthy();
    expect(dec(fake.workspaceFiles.get("other.md"))).toBe("v1\n");
  });

  it("checks the path before saving", async () => {
    const thread = threadWithFile("notes.md", "x\n");
    openApp(fake, thread);
    const user = userEvent.setup();
    const { dialog, input } = await openSaveAs(user, "notes.md");
    for (const [path, problem] of [
      ["notes.md", "That is this file."],
      ["projects/p1/a.md", "That folder is read-only"],
      ["a/../b.md", "Use a path inside My files"],
    ] as const) {
      await user.clear(input);
      await user.type(input, path);
      await user.click(within(dialog).getByRole("button", { name: "Save copy" }));
      expect(within(dialog).getByRole("alert").textContent).toContain(problem);
    }
    expect(fake.workspaceSaves).toEqual([]);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Save as" })).toBeNull();
  });

  it("a read-only project file offers Save As into My files, not Save", async () => {
    const thread = threadWithFile("projects/p1/readme.md", "# Readme\n");
    openApp(fake, thread);
    const user = userEvent.setup();
    const toolbar = await screen.findByRole("toolbar", { name: "readme.md view" });
    expect(within(toolbar).queryByRole("button", { name: "Save" })).toBeNull();
    const { dialog, input } = await openSaveAs(user, "readme.md");
    expect((input as HTMLInputElement).value).toBe("readme.md");
    await user.click(within(dialog).getByRole("button", { name: "Save copy" }));
    await waitFor(() => expect(dec(fake.workspaceFiles.get("readme.md"))).toBe("# Readme\n"));
    expect(await screen.findByRole("tab", { name: "readme.md", selected: true })).toBeTruthy();
    // The copy in My files is editable: Save is back.
    const copyBar = await screen.findByRole("toolbar", { name: "readme.md view" });
    await waitFor(() => expect(within(copyBar).getByRole("button", { name: "Save" })).toBeTruthy());
  });
});
