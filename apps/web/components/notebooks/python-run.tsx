"use client";

/**
 * A `.py` file in the file editor with Run (KOBE-465, NB6/NB13; layout KOBE-615): the editor's
 * toolbar gains Run, Interrupt and Start or Restart with the kernel's state, and a run splits the
 * editor, code on top and the outputs (the notebook's renderer) live below; the split stays after
 * the run and closes back to the full height. The agent's `run_python {path}` runs of the same file
 * show there too. Unsaved changes are not run: the server reads the saved file. Loaded lazily by
 * the file tab with the kernel.
 */
import { PlayIcon } from "lucide-react";
import { useState } from "react";
import { latestRun } from "../../lib/notebooks/executions";
import { useDraft } from "../files/editor-save";
import type { ToolbarAction } from "../files/editor-toolbar";
import { FileEditor, type FileEditorProps } from "../files/file-editor";
import { ExecutionNote } from "./execution-status";
import { kernelActions, kernelBlocker, KernelNotices, KernelState } from "./kernel-bar";
import { NotebookOutputs } from "./output-view";
import { useKernel, type KernelWiring } from "./use-kernel";

export const SAVE_FIRST_NOTE = "Save your changes first: Run uses the saved file.";

export type PythonFileProps = FileEditorProps & {
  readonly kernel: KernelWiring | undefined;
};

export default function PythonFile({ kernel, ...editor }: PythonFileProps) {
  const { path, drafts } = editor;
  const k = useKernel(kernel);
  const dirty = useDraft(drafts, path) !== undefined;
  const threadId = k.threadId;
  const last = threadId === null ? undefined : latestRun(k.execs, threadId, path);
  // The output closed by the member stays closed until the next run.
  const [closed, setClosed] = useState<string | null>(null);
  const blocker = kernelBlocker(kernel);
  const run: ToolbarAction = {
    id: "run",
    label: "Run",
    icon: PlayIcon,
    disabled: blocker !== undefined || dirty,
    reason: blocker ?? (dirty ? SAVE_FIRST_NOTE : undefined),
    onSelect: () => {
      setClosed(null);
      void k.run({ path });
    },
  };
  const controls = { wiring: kernel, busy: k.busy, live: k.live, phase: k.phase };
  const actions =
    kernel?.readOnly === true
      ? []
      : [
          run,
          ...kernelActions({
            ...controls,
            onStart: () => void k.start(),
            onKernel: (op) => void k.kernel(op),
          }),
        ];
  const output =
    last !== undefined && closed !== last.execId
      ? {
          label: "Run output",
          onClose: () => setClosed(last.execId),
          node: (
            <div className="flex flex-col gap-1" data-kobe-run-output={path}>
              <ExecutionNote exec={last} notebook={false} />
              <NotebookOutputs outputs={last.outputs} teamId={kernel?.teamId ?? ""} />
            </div>
          ),
        }
      : null;
  return (
    <FileEditor
      {...editor}
      actions={actions}
      status={<KernelState {...controls} />}
      notices={
        <>
          {dirty && kernel?.readOnly !== true && (
            <p role="note" className="text-muted-foreground text-xs">
              {SAVE_FIRST_NOTE}
            </p>
          )}
          <KernelNotices wiring={kernel} note={k.note} execs={k.execs} path={path} />
        </>
      }
      output={output}
    />
  );
}
