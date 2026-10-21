// @vitest-environment happy-dom
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../../lib/files/editor";
import { EditDraftStore, FileReviewStore } from "../../lib/files/editor-state";
import { must } from "../../lib/testing/must";
import { TooltipProvider } from "../ui/tooltip";
import { NO_THREAD_NOTE, READ_ONLY_NOTE, RESTART_PROMPT } from "./kernel-bar";
import { OutputFrame } from "./output-frame";
import { ev, execId, Harness, Kernel, notebookJson, runId, THREAD, Workspace } from "./testing";

/**
 * KOBE-465: the notebook view (ac-1 editing and run controls, ac-2 the four output kinds with
 * HTML only in the sandboxed frame, ac-4 the agent's proposals and runs in the panel).
 */
const enc = (s: string) => new TextEncoder().encode(s);
const PNG = "iVBORw0KGgo=";
const DATAFRAME =
  '<table class="dataframe"><thead><tr><th></th><th>v</th></tr></thead>' +
  "<tbody><tr><th>0</th><td>42</td></tr></tbody></table>";

const CELLS = [
  { cell_type: "markdown", id: "m1", metadata: {}, source: ["# Analysis\n", "Some *notes*"] },
  {
    cell_type: "code",
    id: "c1",
    metadata: {},
    execution_count: 1,
    source: ["x = 1\n", "print(x)"],
    outputs: [
      { output_type: "stream", name: "stdout", text: ["1\n"] },
      {
        output_type: "display_data",
        metadata: {},
        data: { "image/png": PNG, "text/plain": ["<Figure>"] },
      },
      {
        output_type: "execute_result",
        execution_count: 1,
        metadata: {},
        data: { "text/html": [DATAFRAME], "text/plain": ["   v\n0 42"] },
      },
      {
        output_type: "display_data",
        metadata: {},
        data: { "text/html": ["<b id=kernel-html>bold</b><script>parent.x=1</script>"] },
      },
      {
        output_type: "error",
        ename: "ValueError",
        evalue: "bad",
        traceback: ["\u001b[31mTraceback\u001b[0m"],
      },
    ],
  },
  {
    cell_type: "code",
    id: "c2",
    metadata: {},
    execution_count: null,
    source: "y = x + 1",
    outputs: [],
  },
];

function answerConfirm(answer: boolean) {
  const confirm = vi.fn(() => answer);
  Object.defineProperty(window, "confirm", { value: confirm, configurable: true, writable: true });
  return confirm;
}

async function setup(
  text = notebookJson(CELLS),
  threadId: string | null = THREAD,
  readOnly = false,
) {
  const workspace = new Workspace("a.ipynb", text);
  const kernel = new Kernel();
  const drafts = new EditDraftStore();
  const reviews = new FileReviewStore();
  const sha = await sha256Hex(enc(text));
  render(
    <TooltipProvider>
      <Harness
        workspace={workspace}
        kernel={kernel.wiring(threadId, readOnly)}
        sha={sha}
        drafts={drafts}
        reviews={reviews}
      />
    </TooltipProvider>,
  );
  return { workspace, kernel, drafts, reviews, sha };
}

async function editorView(label: string): Promise<EditorView> {
  return must(EditorView.findFromDOM((await screen.findByLabelText(label)) as HTMLElement));
}

const cell = (n: number) => screen.getByRole("region", { name: new RegExp(`^Cell ${n} `) });

beforeEach(() => {
  answerConfirm(true);
  // Frames load nothing here; the test fires their load event itself.
  const settings = (window as unknown as { happyDOM?: { settings: Record<string, boolean> } })
    .happyDOM?.settings;
  if (settings) {
    settings.disableIframePageLoading = true;
    settings.handleDisabledFileLoadingAsSuccess = false;
  }
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("rendering cells and saved outputs (ac-1, ac-2)", () => {
  it("shows Markdown, code and every output kind, HTML only in the sandboxed frame", async () => {
    await setup();
    expect(await screen.findByRole("heading", { name: "Analysis" })).toBeTruthy();
    const view = await editorView("Code of cell 2");
    expect(view.state.doc.toString()).toBe("x = 1\nprint(x)");
    const code = cell(2);
    expect(within(code).getByText("[1]")).toBeTruthy();
    expect(code.querySelector('[data-kobe-output="stdout"]')?.textContent).toBe("1\n");
    const img = within(code).getByRole("img", { name: "<Figure>" });
    expect(img.getAttribute("src")).toBe(`data:image/png;base64,${PNG}`);
    // The DataFrame is a table of text.
    const table = within(code).getByRole("table");
    expect(within(table).getByRole("columnheader", { name: "v" })).toBeTruthy();
    expect(within(table).getByRole("cell", { name: "42" })).toBeTruthy();
    // Other HTML: only in the output frame, never in the page, never as srcdoc.
    const frame = within(code).getByTitle("HTML output");
    expect(frame.getAttribute("src")).toBe(
      "/v1/workspace/output-frame?team=00000000-0000-4000-8000-0000000000aa",
    );
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts allow-forms");
    expect(frame.hasAttribute("srcdoc")).toBe(false);
    expect(document.getElementById("kernel-html")).toBeNull();
    expect(document.body.innerHTML).not.toContain("parent.x=1");
    // The traceback as text, ANSI stripped.
    const error = within(code).getByRole("group", { name: "Error" });
    expect(error.textContent).toContain("ValueError: bad");
    expect(error.textContent).toContain("Traceback");
    expect(error.textContent).not.toContain("\u001b");
    expect(within(cell(3)).getByText("[ ]")).toBeTruthy();
  });

  it("posts the HTML to the frame once, when it loads", async () => {
    await setup();
    const frame = (await screen.findByTitle("HTML output")) as HTMLIFrameElement;
    const post = vi.fn();
    Object.defineProperty(frame, "contentWindow", { value: { postMessage: post } });
    act(() => frame.dispatchEvent(new Event("load")));
    act(() => frame.dispatchEvent(new Event("load"))); // navigated away: nothing more is sent
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith(
      {
        type: "kobe.notebook.html",
        html: "<b id=kernel-html>bold</b><script>parent.x=1</script>",
      },
      "*",
    );
  });

  it("remounts the frame when the HTML changes, and posts the new HTML", () => {
    const { rerender } = render(<OutputFrame html="<p>one</p>" teamId="t" />);
    const first = screen.getByTitle("HTML output") as HTMLIFrameElement;
    rerender(<OutputFrame html="<p>two</p>" teamId="t" />);
    const second = screen.getByTitle("HTML output") as HTMLIFrameElement;
    expect(second).not.toBe(first);
    const post = vi.fn();
    Object.defineProperty(second, "contentWindow", { value: { postMessage: post } });
    act(() => second.dispatchEvent(new Event("load")));
    expect(post).toHaveBeenCalledWith({ type: "kobe.notebook.html", html: "<p>two</p>" }, "*");
    rerender(<OutputFrame html="<p>two</p>" teamId="t" />);
    expect(screen.getByTitle("HTML output")).toBe(second); // same HTML: same frame
  });

  it("opens a file that is not nbformat 4 as text", async () => {
    await setup('{"cells": "no"}');
    expect(await screen.findByText(/not a Jupyter \(nbformat 4\) notebook/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Raw" })).toBeTruthy();
  });
});

describe("editing (ac-1)", () => {
  it("edits, adds, moves and deletes cells as a draft, and saves at the version read", async () => {
    const { workspace, drafts, sha } = await setup();
    const user = userEvent.setup();
    const view = await editorView("Code of cell 3");
    act(() => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "y = 2" } }));
    expect(await screen.findByText("Unsaved changes.")).toBeTruthy();
    expect(JSON.parse(must(drafts.get("a.ipynb")).text).cells[2].source).toEqual(["y = 2"]);

    await user.click(screen.getByRole("button", { name: "Add a Markdown cell below cell 1" }));
    expect(screen.getByRole("region", { name: "Cell 2 (Markdown)" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Move cell 2 down" }));
    expect(screen.getByRole("region", { name: "Cell 3 (Markdown)" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Delete cell 3" }));
    expect(screen.queryByRole("region", { name: /\(Markdown\)$/u, hidden: false })).toBeTruthy();
    expect(screen.getAllByRole("region", { name: /^Cell \d/u })).toHaveLength(3);

    await user.click(screen.getByRole("button", { name: "Edit cell 1" }));
    const md = await editorView("Markdown of cell 1");
    act(() => md.dispatch({ changes: { from: 0, to: md.state.doc.length, insert: "# New" } }));
    await user.click(screen.getByRole("button", { name: "Done editing cell 1" }));
    expect(await screen.findByRole("heading", { name: "New" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Saved.")).toBeTruthy();
    expect(workspace.saves).toHaveLength(1);
    expect(workspace.saves[0]?.base).toBe(sha);
    const saved = JSON.parse(workspace.text);
    expect(saved.cells.map((c: { id: string }) => c.id)).toEqual(["m1", "c1", "c2"]);
    expect(saved.cells[0].source).toEqual(["# New"]);
    expect(saved.cells[2].source).toEqual(["y = 2"]);
  });

  it("shows the conflict notice when the notebook changed meanwhile", async () => {
    const { workspace } = await setup();
    const user = userEvent.setup();
    const view = await editorView("Code of cell 3");
    act(() => view.dispatch({ changes: { from: 0, insert: "# " } }));
    workspace.text = notebookJson([]); // someone else saved
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/changed since it was opened here/)).toBeTruthy();
  });
});

describe("running (ac-1)", () => {
  it("saves missing cell ids first, runs the cell and shows its outputs live, then the saved file", async () => {
    const text = notebookJson(
      [{ cell_type: "code", metadata: {}, execution_count: null, source: "1 + 1", outputs: [] }],
      4,
    );
    const { workspace, kernel } = await setup(text);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Run cell 1" }));
    await waitFor(() => expect(kernel.runs).toHaveLength(1));
    const saved = JSON.parse(workspace.text);
    expect(saved.nbformat_minor).toBe(5);
    const id = saved.cells[0].id as string;
    expect(id).toMatch(/^[A-Za-z0-9_-]{1,64}$/u);
    expect(kernel.runs[0]).toEqual({ path: "a.ipynb", cell_id: id });

    const source = must(kernel.sources[0]);
    expect(source.url).toBe(`/v1/runs/${runId(1)}/events?starting_after=0`);
    act(() => {
      source.send(
        ev(runId(1), "notebook.started", {
          exec_id: execId(1),
          origin: "user",
          path: "a.ipynb",
          cell_id: id,
        }),
      );
      source.send(
        ev(runId(1), "notebook.output", {
          exec_id: execId(1),
          index: 0,
          output: {
            output_type: "execute_result",
            execution_count: 1,
            data: { "text/plain": "2" },
            metadata: {},
          },
        }),
      );
    });
    expect(await within(cell(1)).findByText("2")).toBeTruthy();
    expect(within(cell(1)).getByText("[*]")).toBeTruthy();
    expect(screen.getByText("Kernel busy")).toBeTruthy();

    // The server saved the outputs: the view reads that version back.
    workspace.text = notebookJson([
      {
        ...saved.cells[0],
        execution_count: 1,
        outputs: [
          {
            output_type: "execute_result",
            execution_count: 1,
            data: { "text/plain": ["2"] },
            metadata: {},
          },
        ],
      },
    ]);
    const newSha = await sha256Hex(enc(workspace.text));
    act(() => {
      source.send(
        ev(runId(1), "notebook.finished", {
          exec_id: execId(1),
          status: "ok",
          execution_count: 1,
          outputs: 1,
          truncated: false,
          saved: { path: "a.ipynb", sha256: newSha },
        }),
      );
    });
    expect(await within(cell(1)).findByText("[1]")).toBeTruthy();
    await waitFor(() => expect(workspace.api.read).toHaveBeenCalled());
    expect(screen.getByText("Kernel idle")).toBeTruthy();
    expect(within(cell(1)).getByText("2")).toBeTruthy();
  });

  it("keeps edits typed during a run on top of the saved outputs", async () => {
    const { workspace, kernel, drafts } = await setup();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Run cell 3" }));
    await waitFor(() => expect(kernel.runs).toHaveLength(1));
    const view = await editorView("Code of cell 2");
    act(() => view.dispatch({ changes: { from: 0, insert: "# edited\n" } }));
    const server = JSON.parse(workspace.text);
    server.cells[2] = { ...server.cells[2], execution_count: 5, outputs: [] };
    workspace.text = notebookJson(server.cells);
    const newSha = await sha256Hex(enc(workspace.text));
    act(() =>
      kernel.store.apply(THREAD, [
        ev(runId(1), "notebook.started", {
          exec_id: execId(1),
          origin: "user",
          path: "a.ipynb",
          cell_id: "c2",
        }),
        ev(runId(1), "notebook.finished", {
          exec_id: execId(1),
          status: "ok",
          execution_count: 5,
          outputs: 0,
          truncated: false,
          saved: { path: "a.ipynb", sha256: newSha },
        }),
      ]),
    );
    await waitFor(() => expect(must(drafts.get("a.ipynb")).baseSha256).toBe(newSha));
    const merged = JSON.parse(must(drafts.get("a.ipynb")).text);
    expect(merged.cells[1].source[0]).toBe("# edited\n");
    expect(merged.cells[2].execution_count).toBe(5);
  });

  it("Run all runs the code cells in order and stops at an error", async () => {
    const { kernel } = await setup();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Run all" }));
    await waitFor(() => expect(kernel.runs).toHaveLength(1));
    expect(kernel.runs[0]).toEqual({ path: "a.ipynb", cell_id: "c1" });
    act(() =>
      kernel.store.apply(THREAD, [
        ev(runId(1), "notebook.started", {
          exec_id: execId(1),
          origin: "user",
          path: "a.ipynb",
          cell_id: "c1",
        }),
        ev(runId(1), "notebook.finished", {
          exec_id: execId(1),
          status: "ok",
          execution_count: 2,
          outputs: 0,
          truncated: false,
          saved: null,
        }),
      ]),
    );
    await waitFor(() => expect(kernel.runs).toHaveLength(2));
    expect(kernel.runs[1]).toEqual({ path: "a.ipynb", cell_id: "c2" });
  });

  it("Run all stops when a cell fails", async () => {
    const { kernel } = await setup();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Run all" }));
    await waitFor(() => expect(kernel.runs).toHaveLength(1));
    act(() =>
      kernel.store.apply(THREAD, [
        ev(runId(1), "notebook.started", {
          exec_id: execId(1),
          origin: "user",
          path: "a.ipynb",
          cell_id: "c1",
        }),
        ev(runId(1), "notebook.finished", {
          exec_id: execId(1),
          status: "error",
          execution_count: 2,
          outputs: 0,
          truncated: false,
          saved: null,
        }),
      ]),
    );
    expect(await screen.findByText(/The outputs were not saved/u)).toBeTruthy();
    expect(kernel.runs).toHaveLength(1);
  });

  it("Interrupt and Restart (after asking) call the kernel", async () => {
    const { kernel } = await setup();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Interrupt" }));
    expect(await screen.findByText("Interrupted the running code.")).toBeTruthy();
    const confirm = answerConfirm(false);
    await user.click(screen.getByRole("button", { name: "Restart" }));
    expect(confirm).toHaveBeenCalledWith(RESTART_PROMPT);
    expect(kernel.ops).toEqual(["interrupt"]);
    answerConfirm(true);
    await user.click(screen.getByRole("button", { name: "Restart" }));
    expect(await screen.findByText(/Kernel restarted/u)).toBeTruthy();
    expect(kernel.ops).toEqual(["interrupt", "restart"]);
  });

  it("shows why a run was refused", async () => {
    const { kernel } = await setup();
    kernel.next.push({
      ok: false,
      error: { status: 403, code: "read_only", message: "Only the owner can run code." },
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Run cell 2" }));
    expect(await screen.findByText("Only the owner can run code.")).toBeTruthy();
  });

  it("shows a shared reader no run or kernel controls", async () => {
    const { kernel } = await setup(undefined, THREAD, true);
    expect(await screen.findByText(READ_ONLY_NOTE)).toBeTruthy();
    for (const name of ["Run all", "Interrupt", "Restart", "Run cell 2", "Run cell 3"]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
    expect(screen.getByText("Kernel idle")).toBeTruthy();
    // Outputs still show.
    expect(within(cell(2)).getByRole("table")).toBeTruthy();
    expect(kernel.runs).toEqual([]);
  });

  it("cannot run before the conversation exists", async () => {
    await setup(undefined, null);
    expect(await screen.findByText(NO_THREAD_NOTE)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Run cell 2" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Run all" }).hasAttribute("disabled")).toBe(true);
  });
});

describe("the agent (ac-4)", () => {
  it("shows the agent's runs live: a cell's in that cell, code runs below the cells", async () => {
    const { kernel } = await setup();
    await screen.findByRole("heading", { name: "Analysis" });
    act(() =>
      kernel.store.apply(THREAD, [
        ev(runId(9), "notebook.started", {
          exec_id: execId(9),
          origin: "agent",
          tool_call_id: "t1",
          path: "a.ipynb",
          cell_id: "c2",
        }),
        ev(runId(9), "notebook.output", {
          exec_id: execId(9),
          index: 0,
          output: { output_type: "stream", name: "stdout", text: "from the agent" },
        }),
        ev(runId(9), "notebook.started", {
          exec_id: execId(8),
          origin: "agent",
          tool_call_id: "t2",
        }),
        ev(runId(9), "notebook.output", {
          exec_id: execId(8),
          index: 0,
          output: { output_type: "stream", name: "stderr", text: "ad hoc" },
        }),
      ]),
    );
    expect(await within(cell(3)).findByText("from the agent")).toBeTruthy();
    expect(within(cell(3)).getByText("Agent run: Running…")).toBeTruthy();
    const below = screen.getByRole("region", { name: "The agent's code runs" });
    expect(within(below).getByText("ad hoc")).toBeTruthy();
  });

  it("shows a proposal under review as the file editor's diff", async () => {
    const text = notebookJson(CELLS);
    const { reviews, sha } = await setup(text);
    await screen.findByRole("heading", { name: "Analysis" });
    act(() =>
      reviews.start({
        toolCallId: "p1",
        path: "a.ipynb",
        baseSha256: sha,
        content: text.replace("y = x + 1", "y = x + 2"),
        summary: "Change y",
      }),
    );
    expect(await screen.findByRole("region", { name: "Proposed edit to a.ipynb" })).toBeTruthy();
    expect(screen.getByText("Change y")).toBeTruthy();
  });
});
