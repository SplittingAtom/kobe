"use client";

/**
 * Run for a `.py` file (KOBE-465, NB6/NB13): runs the saved file in the conversation's kernel and
 * shows its outputs (the notebook's renderer) live, the agent's `run_python {path}` runs of the
 * same file too. Unsaved changes are not run: the server reads the saved file.
 */
import type { EditDraftStore } from "../../lib/files/editor-state";
import { latestRun } from "../../lib/notebooks/executions";
import { BUTTON, useDraft } from "../files/file-editor";
import { ExecutionNote } from "./execution-status";
import { KernelControls, KernelNotices } from "./kernel-bar";
import { NotebookOutputs } from "./output-view";
import { useKernel, type KernelWiring } from "./use-kernel";

export default function PythonRunPane({
  path,
  drafts,
  kernel,
}: {
  readonly path: string;
  readonly drafts: EditDraftStore;
  readonly kernel: KernelWiring | undefined;
}) {
  const k = useKernel(kernel);
  const dirty = useDraft(drafts, path) !== undefined;
  const threadId = k.threadId;
  const last = threadId === null ? undefined : latestRun(k.execs, threadId, path);
  return (
    <section aria-label="Run output" className="flex flex-col gap-2 border-t pt-2">
      <div role="toolbar" aria-label="Run" className="flex flex-wrap items-center gap-1">
        <button
          type="button"
          className={BUTTON}
          disabled={threadId === null || dirty}
          title={dirty ? "Save your changes first: Run uses the saved file." : undefined}
          onClick={() => void k.run({ path })}
        >
          Run
        </button>
        <KernelControls wiring={kernel} busy={k.busy} onKernel={(op) => void k.kernel(op)} />
      </div>
      {dirty && (
        <p role="note" className="text-muted-foreground text-xs">
          Save your changes first: Run uses the saved file.
        </p>
      )}
      <KernelNotices wiring={kernel} note={k.note} execs={k.execs} path={path} />
      {last && (
        <div className="flex flex-col gap-1" data-kobe-run-output={path}>
          <ExecutionNote exec={last} notebook={false} />
          <NotebookOutputs outputs={last.outputs} teamId={kernel?.teamId ?? ""} />
        </div>
      )}
    </section>
  );
}
