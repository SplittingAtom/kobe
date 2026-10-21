// @vitest-environment happy-dom
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { EditDraftStore } from "../../lib/files/editor-state";
import { TooltipProvider } from "../ui/tooltip";
import PythonRunPane from "./python-run";
import { ev, execId, Kernel, runId, THREAD } from "./testing";

/** KOBE-465 ac-3: a `.py` file's Run button and output pane. */
afterEach(cleanup);

function setup(drafts = new EditDraftStore(), threadId: string | null = THREAD) {
  const kernel = new Kernel();
  render(
    <TooltipProvider>
      <PythonRunPane path="src/job.py" drafts={drafts} kernel={kernel.wiring(threadId)} />
    </TooltipProvider>,
  );
  return kernel;
}

describe("Run for .py files (ac-3)", () => {
  it("runs the saved file and shows its outputs and errors live", async () => {
    const kernel = setup();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(kernel.runs).toEqual([{ path: "src/job.py" }]));
    const pane = screen.getByRole("region", { name: "Run output" });
    expect(await within(pane).findByText("Running…")).toBeTruthy();
    act(() =>
      kernel.store.apply(THREAD, [
        ev(runId(1), "notebook.output", {
          exec_id: execId(1),
          index: 0,
          output: { output_type: "stream", name: "stdout", text: "hello\n" },
        }),
        ev(runId(1), "notebook.output", {
          exec_id: execId(1),
          index: 1,
          output: { output_type: "error", ename: "KeyError", evalue: "'k'", traceback: [] },
        }),
        ev(runId(1), "notebook.finished", {
          exec_id: execId(1),
          status: "error",
          execution_count: 3,
          outputs: 2,
          truncated: false,
          saved: null,
        }),
      ]),
    );
    expect(await within(pane).findByText("KeyError: 'k'")).toBeTruthy();
    expect(within(pane).getByText("hello")).toBeTruthy();
    expect(within(pane).queryByText("Running…")).toBeNull();
    // A .py run is never saved anywhere: no "not saved" note.
    expect(within(pane).queryByText(/not saved/u)).toBeNull();
  });

  it("does not run unsaved changes", () => {
    const drafts = new EditDraftStore();
    drafts.set("src/job.py", { text: "print(2)", baseSha256: "a".repeat(64) });
    setup(drafts);
    expect(screen.getByRole("button", { name: "Run" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("Save your changes first: Run uses the saved file.")).toBeTruthy();
  });

  it("shows the agent's runs of the file, and needs a conversation", async () => {
    const kernel = setup(undefined, null);
    expect(screen.getByRole("button", { name: "Run" }).hasAttribute("disabled")).toBe(true);
    cleanup();
    const k2 = setup();
    act(() =>
      k2.store.apply(THREAD, [
        ev(runId(5), "notebook.started", {
          exec_id: execId(5),
          origin: "agent",
          tool_call_id: "t1",
          path: "src/job.py",
        }),
      ]),
    );
    expect(await screen.findByText("Agent run: Running…")).toBeTruthy();
    expect(kernel.runs).toEqual([]);
  });
});
