"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiError } from "../../lib/api/client";
import type { EventSourceFactory } from "../../lib/chat/stream";
import { appendCases, caseIdsOf, suggestTriggerCases } from "../../lib/skills/case-suggestions";
import { readDraftText } from "../../lib/skills/drafts-api";
import { evalHref } from "../../lib/skills/eval-href";
import { RUN_STATUS_TEXT, isOpen, liftText, pct } from "../../lib/skills/eval-format";
import { listDraftEvals, subjectLabel, type SkillEvalRun } from "../../lib/skills/evals-api";
import { DRAFT_SOURCE, mergeEvalHistory, type SavedSkillRuns } from "../../lib/skills/eval-history";
import { SKILL_MD, splitSkillMd } from "../../lib/skills/skill-md";
import { STALLED_MESSAGE, useLiveEval } from "../../lib/skills/use-live-eval";
import {
  Button,
  Notice,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../ui/console";
import { ErrorNotice } from "../admin/error-notice";
import { EvalRun } from "./eval-run";
import { EvalScorecard } from "./eval-scorecard";
import type { DraftEditor } from "./use-draft-editor";

/**
 * The Workbench evals panel (KOBE-328, SK15–SK18): suggest trigger cases into
 * `evals/cases.yaml` (edited as YAML in the file pane), the estimate and Run, live progress (the
 * eval stream, polling if it fails), the scorecard of the run picked, and the history of every
 * eval of this draft by revision. Since KOBE-459 the history also lists the runs of the skill the
 * draft was saved as (`saved`), each row labelled by its source, newest first.
 */
export const CASES_PATH = "evals/cases.yaml";
const NO_SAVED: readonly SavedSkillRuns[] = [];

export function EvalsPanel({
  teamId,
  editor,
  saved = NO_SAVED,
  eventSource,
}: {
  readonly teamId: string;
  readonly editor: DraftEditor;
  /** The saved skill's version runs (KOBE-459), merged into the history. */
  readonly saved?: readonly SavedSkillRuns[];
  /** Tests inject the event stream. */
  readonly eventSource?: EventSourceFactory;
}) {
  const { draft } = editor;
  const [runs, setRuns] = useState<readonly SkillEvalRun[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const hasCases = editor.files.some((f) => f.path === CASES_PATH);
  // Only the newest read counts, and none after the draft changed or the panel went (review M2).
  const seq = useRef(0);

  const reload = useCallback(async (): Promise<boolean> => {
    const mine = ++seq.current;
    const res = await listDraftEvals(teamId, draft.id);
    if (mine !== seq.current) return res.ok;
    if (res.ok) {
      setRuns(res.data);
      setError(null);
    } else setError(res.error);
    return res.ok;
  }, [teamId, draft.id]);

  useEffect(() => {
    void reload();
    return () => {
      seq.current += 1;
    };
  }, [reload]);

  const openIds = (runs ?? []).filter((r) => isOpen(r.status)).map((r) => r.id);
  const { stalled } = useLiveEval(openIds, reload, eventSource);

  async function suggest() {
    setNotice(null);
    const parts = splitSkillMd(editor.texts[SKILL_MD] ?? "");
    const description = parts.ok ? parts.value.description : "";
    let current = editor.texts[CASES_PATH];
    if (hasCases && current === undefined) {
      const read = await readDraftText(teamId, draft.id, CASES_PATH);
      if (!read.ok) return setError(read.error);
      current = read.data;
    }
    const cases = suggestTriggerCases({ name: draft.name, description, taken: caseIdsOf(current) });
    const next = appendCases(current, cases);
    if (next === null)
      return setNotice(`${CASES_PATH} isn't a list of cases yet: fix it, then suggest again.`);
    if (!hasCases) {
      const err = await editor.addFile(CASES_PATH);
      if (err) return setError(err);
    }
    editor.edit(CASES_PATH, next);
    const negatives = cases.filter((c) => !c.triggers).length;
    setNotice(
      `Added ${cases.length} suggested cases (${negatives} that should not trigger) to ${CASES_PATH}. Edit them before you run.`,
    );
  }

  const history = mergeEvalHistory(runs ?? [], saved);
  const shown =
    history.find((r) => r.run.id === picked)?.run ??
    runs?.find((r) => r.status === "completed") ??
    null;
  // A picked eval that is no longer listed: back to the default (review L6).
  const stale = picked !== null && runs !== null && !history.some((r) => r.run.id === picked);
  useEffect(() => {
    if (stale) setPicked(null);
  }, [stale]);

  return (
    <section aria-labelledby="evals-heading">
      <h2 id="evals-heading" className="m-0 mb-2 text-base font-semibold">
        Evals
      </h2>
      <Button type="button" variant="secondary" onClick={() => void suggest()}>
        Suggest trigger cases
      </Button>
      {notice && (
        <p role="status" className="mt-2 text-sm">
          {notice}
        </p>
      )}
      {hasCases ? (
        <EvalRun
          teamId={teamId}
          draftId={draft.id}
          rev={draft.rev}
          flush={editor.flush}
          running={openIds.length > 0}
          onStarted={(id) => {
            setPicked(id);
            void reload();
          }}
        />
      ) : (
        <p className="text-sm">Add cases to {CASES_PATH} to run evals.</p>
      )}
      {error && <ErrorNotice error={error} />}
      {stalled && (
        <Notice tone="warn">
          <p>{STALLED_MESSAGE}</p>
        </Notice>
      )}
      {history.length > 0 && (
        <Table caption="Eval history">
          <TableHead>
            <TableRow>
              <TableHeader>Source</TableHeader>
              <TableHeader>Of</TableHeader>
              <TableHeader>Started</TableHeader>
              <TableHeader>Status</TableHeader>
              <TableHeader>Pass rate</TableHeader>
              <TableHeader>Lift</TableHeader>
              <TableHeader>
                <span className="sr-only">Show</span>
              </TableHeader>
            </TableRow>
          </TableHead>
          <TableBody>
            {history.map(({ run: r, source, of }) => {
              const what = source === DRAFT_SOURCE ? of : `${source} ${of}`;
              const started = new Date(r.startedAt).toLocaleString();
              return (
                <TableRow key={r.id}>
                  <TableCell>{source}</TableCell>
                  <TableCell>{of}</TableCell>
                  <TableCell>
                    <Link href={evalHref(r.id)}>{started}</Link>
                  </TableCell>
                  <TableCell>
                    {RUN_STATUS_TEXT[r.status]}
                    {isOpen(r.status) && ` (${r.progress.done} of ${r.progress.total})`}
                  </TableCell>
                  <TableCell>{pct(r.scorecard?.passRate)}</TableCell>
                  <TableCell>{liftText(r.scorecard?.lift)}</TableCell>
                  <TableCell>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-pressed={shown?.id === r.id}
                      aria-label={`Show the eval of ${what} started ${started}`}
                      onClick={() => setPicked(r.id)}
                    >
                      Show
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
      {shown && <ShownRun run={shown} />}
    </section>
  );
}

/** One eval: its scorecard, its progress, or why it ended without one. */
export function ShownRun({ run }: { readonly run: SkillEvalRun }) {
  const title = `Eval of ${subjectLabel(run)}`;
  return (
    <section className="mt-4" aria-label={title}>
      <h3 className="m-0 mb-2 text-sm font-semibold">
        {title} · {run.mode === "full" ? "with a baseline" : "with the skill only"}
      </h3>
      {run.scorecard ? (
        <EvalScorecard card={run.scorecard} />
      ) : isOpen(run.status) ? (
        <p role="status" className="text-sm">
          {run.progress.done} of {run.progress.total} runs done…
        </p>
      ) : (
        <Notice tone={run.status === "cancelled" ? "info" : "error"}>
          <p>{run.failure?.message ?? RUN_STATUS_TEXT[run.status]}</p>
        </Notice>
      )}
    </section>
  );
}
