"use client";

/**
 * A Jupyter notebook in the artifact column (KOBE-465, docs/specs/notebooks.md), loaded lazily by
 * the file tab. Code and Markdown cells, Run cell (Shift+Enter), Run all, Interrupt, Restart,
 * kernel state, add/move/delete cells and execution counts. Edits are the file editor's drafts
 * (the notebook serialized), saved through its save path at the version read (conflicts as there).
 * A run reads the saved notebook (NB6), so unsaved edits and missing cell ids (NB1) are saved
 * first; its outputs show live and the server saves them (NB11), which this view then reads back,
 * keeping any edits made meanwhile. An agent proposal under review shows the file editor's diff;
 * the agent's `run_python` runs show live in their cell, or below the cells.
 */
import { ListPlusIcon, PlayIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { NOTEBOOK_FILE_MAX_BYTES } from "@kobe/protocol";
import type { FilesApi } from "../../lib/files/api";
import { useWorkspaceProjects } from "../projects/workspace-projects";
import { editBlockReason, sha256Hex } from "../../lib/files/editor";
import type { EditDraftStore, FileReviewStore } from "../../lib/files/editor-state";
import { decodePreviewText } from "../../lib/files/preview";
import { agentCodeRuns, latestRun, type Execution } from "../../lib/notebooks/executions";
import {
  addCell,
  cellId,
  cellType,
  deleteCell,
  executionCount,
  moveCell,
  parseNotebook,
  savedOutputs,
  serializeNotebook,
  setSource,
  withCellIds,
  withSavedResults,
  type Notebook,
} from "../../lib/notebooks/ipynb";
import { SaveNotices, useDraft, useReview, useSave } from "../files/editor-save";
import { EditorToolbar, type ToolbarAction } from "../files/editor-toolbar";
import { FileEditor, saveAction, saveAsAction } from "../files/file-editor";
import { SaveAsForm } from "../files/save-as";
import { ExecutionNote } from "./execution-status";
import { kernelActions, kernelBlocker, KernelNotices, KernelState } from "./kernel-bar";
import { NotebookCell } from "./notebook-cell";
import { NotebookOutputs } from "./output-view";
import { useKernel, whenFinished, type KernelWiring } from "./use-kernel";

export interface NotebookViewProps {
  readonly path: string;
  readonly text: string;
  readonly sha256: string | undefined;
  readonly truncated: boolean;
  readonly files: FilesApi;
  readonly drafts: EditDraftStore;
  readonly reviews: FileReviewStore;
  readonly kernel: KernelWiring | undefined;
  onSaved(text: string, sha256: string): void;
  onReload(): void;
  /** Save As saved a copy: open that path in this tab (KOBE-615). */
  readonly onOpenPath?: ((path: string) => void) | undefined;
}

const newCellId = () => crypto.randomUUID();
const lastCellId = (notebook: Notebook): string | null => {
  const last = notebook.cells.at(-1);
  return last === undefined ? null : cellId(last);
};
/** The agent's code runs shown below the cells. */
const AGENT_RUNS_SHOWN = 3;

export default function NotebookView(props: NotebookViewProps) {
  const { path, text, truncated, drafts, reviews } = props;
  const draft = useDraft(drafts, path);
  const review = useReview(reviews, path);
  const current = draft?.text ?? text;
  const loaded = useMemo(() => {
    const notebook = parseNotebook(current);
    return notebook && withCellIds(notebook, newCellId);
  }, [current]);
  const fileEditor = (
    <FileEditor
      path={path}
      text={text}
      sha256={props.sha256}
      truncated={truncated}
      api={props.files}
      drafts={drafts}
      reviews={reviews}
      onSaved={props.onSaved}
      onReload={props.onReload}
      onOpenPath={props.onOpenPath}
    />
  );
  if (review !== undefined) return fileEditor; // the proposal's diff (KOBE-463 review)
  if (loaded === undefined || truncated) {
    return (
      <>
        <p role="note" className="text-muted-foreground mb-2 text-xs">
          {truncated
            ? "This notebook is too large to open as a notebook, so it opens as text."
            : "This file is not a Jupyter (nbformat 4) notebook, so it opens as text."}
        </p>
        {fileEditor}
      </>
    );
  }
  return <NotebookBody {...props} notebook={loaded.notebook} idsAdded={loaded.added} />;
}

/** Reads the notebook the server saved a run's outputs into, keeping unsaved edits on top. */
function useSavedOutputSync(props: NotebookViewProps, execs: readonly Execution[]) {
  const { path, sha256, files, drafts, onSaved, onReload } = props;
  const threadId = props.kernel?.threadId ?? null;
  const [synced, setSynced] = useState<ReadonlySet<string>>(new Set());
  let latest: string | undefined;
  for (const e of execs) {
    if (e.threadId === threadId && e.finished?.saved?.path === path)
      latest = e.finished.saved.sha256;
  }
  useEffect(() => {
    if (latest === undefined || synced.has(latest)) return;
    const version = latest;
    let live = true;
    const done = () => live && setSynced((s) => new Set(s).add(version));
    if (version === sha256) {
      done();
      return;
    }
    void (async () => {
      const read = await files.read(path, NOTEBOOK_FILE_MAX_BYTES);
      const serverText = read.ok ? decodePreviewText(read.data.bytes, read.data.truncated) : null;
      if (!live) return;
      if (!read.ok || serverText === null || read.data.truncated) {
        onReload();
        done();
        return;
      }
      const serverSha = await sha256Hex(read.data.bytes);
      const local = drafts.get(path);
      const mine = local && parseNotebook(local.text);
      const theirs = parseNotebook(serverText);
      onSaved(serverText, serverSha);
      if (mine && theirs) {
        drafts.set(path, {
          text: serializeNotebook(withSavedResults(mine, theirs)),
          baseSha256: serverSha,
        });
      }
      done();
    })();
    return () => {
      live = false;
    };
  }, [latest, synced, sha256, files, path, drafts, onSaved, onReload]);
  return synced;
}

function NotebookBody(
  props: NotebookViewProps & { readonly notebook: Notebook; readonly idsAdded: boolean },
) {
  const { path, text, sha256, truncated, drafts, notebook, idsAdded } = props;
  const draft = useDraft(drafts, path);
  const k = useKernel(props.kernel);
  const [savingAs, setSavingAs] = useState(false);
  const synced = useSavedOutputSync(props, k.execs);
  const {
    state: saveState,
    save,
    reset,
  } = useSave(props.files, path, (saved, version) => {
    const latest = drafts.get(path);
    if (latest === undefined || latest.text === saved) drafts.clear(path);
    else drafts.set(path, { text: latest.text, baseSha256: version });
    props.onSaved(saved, version);
  });
  const base = draft?.baseSha256 ?? sha256;
  const projects = useWorkspaceProjects() ?? undefined;
  const blocked =
    editBlockReason(path, truncated, projects) ??
    (sha256 === undefined ? "This file's version is unknown, so it opens read-only." : undefined);
  const editable = blocked === undefined && base !== undefined;
  const threadId = k.threadId;
  const reader = props.kernel?.readOnly === true;
  const canRun = !reader && threadId !== null && (editable || (draft === undefined && !idsAdded));

  const edit = (next: Notebook) => {
    if (!editable || base === undefined) return;
    const serialized = serializeNotebook(next);
    if (serialized === text && base === sha256) drafts.clear(path);
    else drafts.set(path, { text: serialized, baseSha256: base });
    if (saveState.status === "saved") reset();
  };

  /** The notebook as the server will read it: unsaved edits and new cell ids saved first. */
  const ensureSaved = useCallback(async (): Promise<boolean> => {
    if (draft === undefined && !idsAdded) return true;
    if (base === undefined) return false;
    return (await save(base, serializeNotebook(notebook))) === "saved";
  }, [draft, idsAdded, base, save, notebook]);

  const runCell = async (id: string) => {
    if (await ensureSaved()) await k.run({ path, cell_id: id });
  };

  const runAll = async () => {
    if (!props.kernel || !(await ensureSaved())) return;
    for (const cell of notebook.cells) {
      if (cellType(cell) !== "code") continue;
      const execId = await k.run({ path, cell_id: cellId(cell) });
      if (execId === null) return;
      const done = await whenFinished(props.kernel.runs, execId);
      if (done?.finished?.status !== "ok") return;
    }
  };

  const showsLive = (live: Execution | undefined): live is Execution =>
    live !== undefined &&
    (live.finished === undefined ||
      live.finished.saved === null ||
      !synced.has(live.finished.saved.sha256));

  const agentRuns =
    threadId === null ? [] : agentCodeRuns(k.execs, threadId).slice(-AGENT_RUNS_SHOWN);
  const notebookActions = (): ToolbarAction[] => {
    const why = kernelBlocker(props.kernel);
    const runAllAction: ToolbarAction = {
      id: "run-all",
      label: "Run all",
      icon: PlayIcon,
      disabled: !canRun,
      reason: why ?? (canRun ? undefined : "This notebook cannot be run here."),
      onSelect: () => void runAll(),
    };
    return [
      ...(blocked === undefined
        ? [
            saveAction(
              saveState,
              draft !== undefined && base !== undefined,
              () => base !== undefined && void save(base, serializeNotebook(notebook)),
            ),
          ]
        : []),
      saveAsAction(() => setSavingAs(true)),
      ...(reader ? [] : [runAllAction]),
      ...kernelActions({
        wiring: props.kernel,
        busy: k.busy,
        live: k.live,
        phase: k.phase,
        onStart: () => void k.start(),
        onKernel: (op) => void k.kernel(op),
      }),
      {
        id: "add-code-cell",
        label: "Add code cell",
        icon: ListPlusIcon,
        overflow: true,
        disabled: !editable,
        reason: blocked,
        onSelect: () => edit(addCell(notebook, lastCellId(notebook), "code", newCellId())),
      },
    ];
  };
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2" data-kobe-notebook={path}>
      <EditorToolbar
        label="Notebook"
        actions={notebookActions()}
        status={<KernelState wiring={props.kernel} busy={k.busy} live={k.live} phase={k.phase} />}
      />
      {savingAs && (
        <SaveAsForm
          api={props.files}
          path={path}
          text={serializeNotebook(notebook)}
          truncated={false}
          checkedOut={projects?.checkedOut}
          onSaved={(to) => {
            setSavingAs(false);
            drafts.clear(path);
            props.onOpenPath?.(to);
          }}
          onCancel={() => setSavingAs(false)}
        />
      )}
      <p role="status" className="text-muted-foreground text-xs empty:hidden">
        {draft !== undefined ? "Unsaved changes." : saveState.status === "saved" ? "Saved." : ""}
      </p>
      {blocked !== undefined && (
        <p role="note" className="text-muted-foreground text-xs">
          {blocked}
        </p>
      )}
      <SaveNotices state={saveState} onReload={props.onReload} />
      <KernelNotices wiring={props.kernel} note={k.note} execs={k.execs} path={path} />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2 overflow-auto">
        {notebook.cells.map((cell, i) => {
          const id = cellId(cell);
          const live = threadId === null ? undefined : latestRun(k.execs, threadId, path, id);
          const fromRun = showsLive(live);
          const count = fromRun
            ? live.finished === undefined
              ? "[*]"
              : `[${live.finished.executionCount ?? " "}]`
            : `[${executionCount(cell) ?? " "}]`;
          return (
            <NotebookCell
              key={id}
              cell={cell}
              number={i + 1}
              first={i === 0}
              last={i === notebook.cells.length - 1}
              editable={editable}
              canRun={canRun}
              showRun={!reader}
              count={count}
              outputs={fromRun ? live.outputs : savedOutputs(cell)}
              live={fromRun ? live : undefined}
              teamId={props.kernel?.teamId ?? ""}
              onSource={(source) => edit(setSource(notebook, id, source))}
              onRun={() => void runCell(id)}
              onMove={(delta) => edit(moveCell(notebook, id, delta))}
              onDelete={() => edit(deleteCell(notebook, id))}
              onAdd={(type) => edit(addCell(notebook, id, type, newCellId()))}
            />
          );
        })}
        {agentRuns.length > 0 && (
          <section aria-label="The agent's code runs" className="flex flex-col gap-2 border-t pt-2">
            <h3 className="text-xs font-medium">The agent&apos;s code runs in this kernel</h3>
            {agentRuns.map((run) => (
              <div key={run.execId} className="flex flex-col gap-1">
                <ExecutionNote exec={run} notebook={false} />
                <NotebookOutputs outputs={run.outputs} teamId={props.kernel?.teamId ?? ""} />
              </div>
            ))}
          </section>
        )}
      </div>
    </div>
  );
}
