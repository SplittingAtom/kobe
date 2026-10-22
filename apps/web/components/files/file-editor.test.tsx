// @vitest-environment happy-dom
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EditorView } from "@codemirror/view";
import { getChunks } from "@codemirror/merge";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tabsKey } from "../../lib/chat/artifact-tabs";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
import { sha256Hex } from "../../lib/files/editor";
import { must } from "../../lib/testing/must";
import { composer, openApp } from "../chat/testing";
import { CONFLICT_NOTICE } from "./file-editor";
import { EXPIRED_NOTE } from "./file-edit-card";

/**
 * KOBE-463: workspace text files in the artifact column get Rendered and Raw modes with Save
 * (ac-1), the composer's Viewing chip (ac-2) and the inline review of a proposal (ac-3).
 */
let fake: FakeKobe;
const enc = (s: string) => new TextEncoder().encode(s);
const sha = (s: string) => sha256Hex(enc(s));

/** happy-dom has no `window.confirm`: the member's answer to "Discard your unsaved changes?". */
function answerConfirm(answer: boolean) {
  const confirm = vi.fn(() => answer);
  Object.defineProperty(window, "confirm", { value: confirm, configurable: true, writable: true });
  return confirm;
}

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

/** A thread whose artifact column has `path` open (the tabs this browser remembers). */
function threadWithFile(path: string, content: string, entries?: (thread: string) => void) {
  fake.workspaceFiles.set(path, enc(content));
  const thread = fake.addThread("Notes");
  if (entries) entries(thread);
  else {
    const u = fake.addEntry(thread, null, { role: "user", content: "hi" });
    fake.addEntry(thread, u, { role: "assistant", content: [{ type: "text", text: "done" }] });
  }
  const tab = `file:${path}`;
  localStorage.setItem(tabsKey(fake.teamId, thread), JSON.stringify({ open: [tab], active: tab }));
  return thread;
}

/** The CodeMirror view under the editable region named `label`. */
async function editorView(label: string): Promise<EditorView> {
  const content = await screen.findByLabelText(label);
  return must(EditorView.findFromDOM(content as HTMLElement));
}

function replaceText(view: EditorView, text: string) {
  act(() => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } }));
}

describe("Rendered and Raw (ac-1)", () => {
  it("renders, edits raw and saves at the version it read", async () => {
    const thread = threadWithFile("notes.md", "# Plan\n");
    openApp(fake, thread);
    const user = userEvent.setup();
    expect(await screen.findByRole("heading", { name: "Plan" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Raw" }));
    const view = await editorView("Edit notes.md");
    expect(view.state.doc.toString()).toBe("# Plan\n");
    const save = screen.getByRole("button", { name: "Save" });
    expect(save.hasAttribute("disabled")).toBe(true);

    replaceText(view, "# Plan\n\nShip it.\n");
    expect(await screen.findByText("Unsaved changes.")).toBeTruthy();
    // Rendered shows the draft too.
    await user.click(screen.getByRole("button", { name: "Rendered" }));
    expect(await screen.findByText("Ship it.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Saved.")).toBeTruthy();
    expect(fake.workspaceSaves).toEqual([
      { path: "notes.md", base: await sha("# Plan\n"), text: "# Plan\n\nShip it.\n" },
    ]);

    // The next save is based on the saved version.
    await user.click(screen.getByRole("button", { name: "Raw" }));
    replaceText(await editorView("Edit notes.md"), "# Plan v2\n");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(fake.workspaceSaves).toHaveLength(2));
    expect(fake.workspaceSaves[1]?.base).toBe(await sha("# Plan\n\nShip it.\n"));
  });

  it("keystrokes typed while a save is in flight stay unsaved, based on the saved version", async () => {
    const thread = threadWithFile("notes.md", "one\n");
    openApp(fake, thread);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Raw" }));
    const view = await editorView("Edit notes.md");
    replaceText(view, "two\n");
    let release = () => {};
    fake.saveGate = new Promise<void>((resolve) => (release = resolve));
    await user.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByRole("button", { name: "Saving…" });
    replaceText(view, "two\nthree\n"); // typed during the save
    act(() => release());
    await waitFor(() => expect(fake.workspaceSaves).toHaveLength(1));
    expect(fake.workspaceSaves[0]?.text).toBe("two\n");
    expect(await screen.findByText("Unsaved changes.")).toBeTruthy();
    expect(view.state.doc.toString()).toBe("two\nthree\n");
    fake.saveGate = undefined;
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(fake.workspaceSaves).toHaveLength(2));
    expect(fake.workspaceSaves[1]).toEqual({
      path: "notes.md",
      base: await sha("two\n"),
      text: "two\nthree\n",
    });
  });

  it("a file changed meanwhile is not overwritten: the conflict notice offers a reload", async () => {
    const thread = threadWithFile("data.json", '{"a":1}');
    openApp(fake, thread);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Raw" }));
    replaceText(await editorView("Edit data.json"), '{"a":2}');
    fake.workspaceFiles.set("data.json", enc('{"a":3}')); // the agent pushed meanwhile
    await user.click(screen.getByRole("button", { name: "Save" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(CONFLICT_NOTICE);
    expect(fake.workspaceSaves).toEqual([]);
    expect(new TextDecoder().decode(fake.workspaceFiles.get("data.json"))).toBe('{"a":3}');

    answerConfirm(true);
    await user.click(within(alert).getByRole("button", { name: "Reload the file" }));
    await waitFor(async () =>
      expect((await editorView("Edit data.json")).state.doc.toString()).toBe('{"a":3}'),
    );
    expect(screen.queryByText("Unsaved changes.")).toBeNull();
  });

  it("closing a tab with unsaved changes asks first", async () => {
    const thread = threadWithFile("todo.txt", "one\n");
    openApp(fake, thread);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Raw" }));
    replaceText(await editorView("Edit todo.txt"), "two\n");
    const confirm = answerConfirm(false);
    await user.click(screen.getByRole("button", { name: /^Close todo\.txt/ }));
    expect(confirm).toHaveBeenCalledWith("Discard your unsaved changes to todo.txt?");
    expect(screen.getByRole("tab", { name: "todo.txt" })).toBeTruthy();
    answerConfirm(true);
    await user.click(screen.getByRole("button", { name: /^Close todo\.txt/ }));
    await waitFor(() => expect(screen.queryByRole("tab", { name: "todo.txt" })).toBeNull());
  });

  it("project files open read-only, with the reason", async () => {
    const thread = threadWithFile("projects/p1/readme.md", "# Readme\n");
    openApp(fake, thread);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Raw" }));
    const view = await editorView("Edit readme.md");
    expect(view.state.readOnly).toBe(true);
    expect(screen.getByText("Project files and thread uploads are read-only.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });
});

describe("the Viewing chip (ac-2)", () => {
  it("names the open file, goes with the message as `viewing`, and × stops it", async () => {
    const thread = threadWithFile("notes.md", "# Plan\n");
    openApp(fake, thread);
    const user = userEvent.setup();
    const input = await composer();
    const chip = await screen.findByText("Viewing notes.md");
    expect(chip).toBeTruthy();
    await user.type(input, "Tidy this{Enter}");
    await waitFor(() => expect(fake.submittedBodies).toHaveLength(1));
    expect(fake.submittedBodies[0]?.viewing).toEqual({ path: "notes.md" });

    await user.click(screen.getByRole("button", { name: "Don't send notes.md with the message" }));
    expect(screen.queryByText("Viewing notes.md")).toBeNull();
    await waitFor(() => expect(input.value).toBe(""));
    await user.type(input, "And now?{Enter}");
    await waitFor(() => expect(fake.submittedBodies).toHaveLength(2));
    expect(fake.submittedBodies[1]?.viewing).toBeUndefined();
  });
});

describe("edit and regenerate carry the viewed file (KOBE-467)", () => {
  /** A root settings entry (like Pi 1.0), so the prompt can be edited and regenerated. */
  function branchable(path: string) {
    let prompt = "";
    const thread = threadWithFile(path, "# Plan\n", (t) => {
      const root = fake.addSystemEntry(t, null, "thinking_level_change", { thinkingLevel: "off" });
      prompt = fake.addEntry(t, root, { role: "user", content: "Tidy notes" });
      fake.addEntry(t, prompt, { role: "assistant", content: [{ type: "text", text: "done" }] });
    });
    return { thread, prompt: () => prompt };
  }

  it("an edit sends the file open now, like a new message", async () => {
    const { thread } = branchable("notes.md");
    openApp(fake, thread);
    const user = userEvent.setup();
    await screen.findByText("Viewing notes.md");
    await user.click(must(screen.getAllByRole("button", { name: "Edit" })[0]));
    const editor = await screen.findByLabelText("Edit your message");
    await user.clear(editor);
    await user.type(editor, "Tidy it more");
    await user.click(within(must(editor.closest("form"))).getByRole("button", { name: "Send" }));
    await waitFor(() => expect(fake.submittedBodies).toHaveLength(1));
    expect(fake.submittedBodies[0]?.viewing).toEqual({ path: "notes.md" });
    expect(fake.submittedBodies[0]?.viewing_from_entry).toBeUndefined();
  });

  it("an edit sends no file once its chip was removed", async () => {
    const { thread } = branchable("notes.md");
    openApp(fake, thread);
    const user = userEvent.setup();
    await screen.findByText("Viewing notes.md");
    await user.click(screen.getByRole("button", { name: "Don't send notes.md with the message" }));
    await user.click(must(screen.getAllByRole("button", { name: "Edit" })[0]));
    const editor = await screen.findByLabelText("Edit your message");
    await user.type(editor, "!");
    await user.click(within(must(editor.closest("form"))).getByRole("button", { name: "Send" }));
    await waitFor(() => expect(fake.submittedBodies).toHaveLength(1));
    expect(fake.submittedBodies[0]?.viewing).toBeUndefined();
  });

  it("a regenerate names the prompt, so the server reuses its run's file", async () => {
    const { thread, prompt } = branchable("other.md");
    openApp(fake, thread);
    await screen.findByText("Viewing other.md");
    await userEvent.setup().click(must(screen.getAllByRole("button", { name: "Regenerate" })[0]));
    await waitFor(() => expect(fake.submittedBodies).toHaveLength(1));
    expect(fake.submittedBodies[0]?.viewing_from_entry).toBe(prompt());
    expect(fake.submittedBodies[0]?.viewing).toBeUndefined();
  });
});

/** A recorded `propose_file_edit` call (tool call id `pe1`) for `path`. */
function proposalEntries(path: string) {
  return (thread: string) => {
    const u = fake.addEntry(thread, null, { role: "user", content: "Tidy notes" });
    const call = fake.addEntry(thread, u, {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "pe1",
          name: "propose_file_edit",
          arguments: { path, content: "forged", summary: "forged" },
        },
      ],
    });
    const res = fake.addEntry(thread, call, {
      role: "toolResult",
      toolCallId: "pe1",
      toolName: "propose_file_edit",
      content: [{ type: "text", text: '{"ok":true,"status":"awaiting_user"}' }],
      isError: false,
    });
    fake.addEntry(thread, res, {
      role: "assistant",
      content: [{ type: "text", text: "Proposed." }],
    });
  };
}

const BASE = "alpha\nbeta\ngamma\n";
const PROPOSED = "alpha\nBETA\ngamma\ndelta\n";

async function reviewProposal(path = "notes.txt") {
  const thread = threadWithFile(path, BASE, proposalEntries(path));
  fake.fileEditProposals.set(thread, [
    {
      tool_call_id: "pe1",
      path,
      base_sha256: await sha(BASE),
      content: PROPOSED,
      summary: "Capitalises beta and adds delta",
      run_id: "00000000-0000-4000-8000-000000000001",
      created_at: "2026-10-21T00:00:00.000Z",
    },
  ]);
  openApp(fake, thread);
  const user = userEvent.setup();
  expect(await screen.findByText("Capitalises beta and adds delta")).toBeTruthy();
  // The card is the server's record, never the call's (model-written) input.
  const card = must(document.querySelector(`[data-kobe-file-edit="${path}"]`));
  expect(card.textContent).not.toContain("forged");
  await user.click(screen.getByRole("button", { name: `Review the proposed edit to ${path}` }));
  const view = await editorView(`Proposed content of ${path}`);
  return { user, view, thread };
}

describe("reviewing a proposal (ac-3)", () => {
  it("shows the diff inline; accept one change, reject the other, commit at the base version", async () => {
    const { user, view } = await reviewProposal();
    const region = screen.getByRole("region", { name: "Proposed edit to notes.txt" });
    await waitFor(() => expect(getChunks(view.state)?.chunks).toHaveLength(2));
    expect(
      within(region).getByText("2 changes to accept or reject. Commit all saves what is shown."),
    ).toBeTruthy();
    // The deleted line shows struck (del) with its own Accept/Reject buttons.
    expect(region.querySelector(".cm-deletedChunk del")?.textContent).toBe("beta");
    const accepts = within(region).getAllByRole("button", { name: "Accept this change" });
    expect(accepts).toHaveLength(2);
    // Accept the first (beta -> BETA), reject the second (delta goes away).
    await user.click(must(accepts[0]));
    await waitFor(() => expect(getChunks(view.state)?.chunks).toHaveLength(1));
    await user.click(within(region).getByRole("button", { name: "Reject this change" }));
    await waitFor(() => expect(getChunks(view.state)?.chunks).toHaveLength(0));
    expect(view.state.doc.toString()).toBe("alpha\nBETA\ngamma\n");

    await user.click(within(region).getByRole("button", { name: "Commit all" }));
    await waitFor(() => expect(fake.workspaceSaves).toHaveLength(1));
    expect(fake.workspaceSaves[0]).toEqual({
      path: "notes.txt",
      base: await sha(BASE),
      text: "alpha\nBETA\ngamma\n",
    });
    // The review ends; the card says what happened.
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: /Proposed edit to/ })).toBeNull(),
    );
    expect(await screen.findByText("Committed")).toBeTruthy();
  });

  it("the toolbar accepts from the keyboard; Commit all keeps changes left open", async () => {
    const { user, view } = await reviewProposal();
    await waitFor(() => expect(getChunks(view.state)?.chunks).toHaveLength(2));
    await user.click(screen.getByRole("button", { name: "Next change" }));
    await user.click(screen.getByRole("button", { name: "Accept change" }));
    await waitFor(() => expect(getChunks(view.state)?.chunks).toHaveLength(1));
    await user.click(screen.getByRole("button", { name: "Commit all" }));
    await waitFor(() => expect(fake.workspaceSaves).toHaveLength(1));
    expect(fake.workspaceSaves[0]?.text).toBe(PROPOSED);
  });

  it("re-reading the file keeps the review's decisions; a file that moved on ends it with a notice", async () => {
    const { user, view } = await reviewProposal();
    await waitFor(() => expect(getChunks(view.state)?.chunks).toHaveLength(2));
    await user.click(must(screen.getAllByRole("button", { name: "Accept this change" })[0]));
    await waitFor(() => expect(getChunks(view.state)?.chunks).toHaveLength(1));
    const reviewButton = screen.getByRole("button", {
      name: "Review the proposed edit to notes.txt",
    });
    const reads = () =>
      fake.requests.filter((r) => r.method === "GET" && r.path.startsWith("/v1/workspace/file?"))
        .length;
    const before = reads();
    await user.click(reviewButton); // opens the file again: it is read again
    await waitFor(() => expect(reads()).toBe(before + 1));
    const same = await editorView("Proposed content of notes.txt");
    expect(same).toBe(view);
    expect(getChunks(view.state)?.chunks).toHaveLength(1);

    fake.workspaceFiles.set("notes.txt", enc("moved on\n"));
    await user.click(reviewButton);
    expect(await screen.findByText(/changed since the agent proposed this edit/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Commit all" })).toBeNull();
  });

  it("Discard all writes nothing; a file changed since the proposal cannot be committed", async () => {
    const { user } = await reviewProposal();
    await user.click(screen.getByRole("button", { name: "Discard all" }));
    expect(await screen.findByText("Discarded")).toBeTruthy();
    expect(fake.workspaceSaves).toEqual([]);

    // The file moves on; reviewing again says so instead of offering a commit.
    fake.workspaceFiles.set("notes.txt", enc("changed\n"));
    await user.click(screen.getByRole("button", { name: "Review the proposed edit to notes.txt" }));
    // Opening the open file again re-reads it.
    expect(await screen.findByText(/changed since the agent proposed this edit/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Commit all" })).toBeNull();
  });

  it("a proposal the server no longer has says it expired", async () => {
    const thread = threadWithFile("notes.txt", BASE, proposalEntries("notes.txt"));
    openApp(fake, thread);
    expect(await screen.findByText(EXPIRED_NOTE)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Review the proposed edit/ })).toBeNull();
  });
});

describe("the live stream (ac-3)", () => {
  it("a file.edit_proposed event gives its tool call the card while the run streams", async () => {
    const thread = threadWithFile("notes.txt", BASE);
    openApp(fake, thread);
    const user = userEvent.setup();
    const input = await composer();
    await user.type(input, "Tidy{Enter}");
    await waitFor(() => expect(fake.submittedBodies).toHaveLength(1));
    const run = must([...fake.runs.values()].at(-1)).run_id;
    act(() => {
      fake.agent.toolCall(run, "pe9", "propose_file_edit", { path: "notes.txt" });
      fake.emit(run, "file.edit_proposed", {
        tool_call_id: "pe9",
        path: "notes.txt",
        base_sha256: "a".repeat(64),
        content: PROPOSED,
        summary: "Live proposal",
      });
    });
    expect(await screen.findByText("Live proposal")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Review the proposed edit to notes.txt" }),
    ).toBeTruthy();
  });
});
