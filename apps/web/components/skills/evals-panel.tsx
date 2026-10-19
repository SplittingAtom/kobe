"use client";

import { useCallback, useEffect, useState } from "react";
import type { ApiError } from "../../lib/api/client";
import { appendCases, caseIdsOf, suggestTriggerCases } from "../../lib/skills/case-suggestions";
import { readDraftText } from "../../lib/skills/drafts-api";
import { listDraftEvals, subjectLabel, type SkillEvalRun } from "../../lib/skills/evals-api";
import { SKILL_MD, splitSkillMd } from "../../lib/skills/skill-md";
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
 * `evals/cases.yaml` (edited as YAML in the file pane), the estimate and Run, live progress, the
 * scorecard of the run picked, and the history of every eval of this draft by revision.
 */
export const CASES_PATH = "evals/cases.yaml";
/** How often an open eval's progress is read again. */
export const EVAL_POLL_MS = 2_000;

const OPEN = new Set(["queued", "running"]);
const pct = (x: number | null | undefined) =>
  x === null || x === undefined ? "—" : `${Math.round(x * 100)} %`;
const STATUS_TEXT: Readonly<Record<SkillEvalRun["status"], string>> = {
  queued: "Queued",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
  budget_stopped: "Stopped by a budget",
};

export function EvalsPanel({
  teamId,
  editor,
}: {
  readonly teamId: string;
  readonly editor: DraftEditor;
}) {
  const { draft } = editor;
  const [runs, setRuns] = useState<readonly SkillEvalRun[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const hasCases = editor.files.some((f) => f.path === CASES_PATH);

  const reload = useCallback(async () => {
    const res = await listDraftEvals(teamId, draft.id);
    if (res.ok) setRuns(res.data);
    else setError(res.error);
  }, [teamId, draft.id]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Live progress: read again while any eval of this draft is queued or running.
  const anyOpen = runs?.some((r) => OPEN.has(r.status)) ?? false;
  useEffect(() => {
    if (!anyOpen) return;
    const timer = setInterval(() => void reload(), EVAL_POLL_MS);
    return () => clearInterval(timer);
  }, [anyOpen, reload]);

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
    const cases = suggestTriggerCases({
      name: draft.name,
      description,
      taken: caseIdsOf(current),
    });
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

  const shown =
    runs?.find((r) => r.id === picked) ?? runs?.find((r) => r.status === "completed") ?? null;

  return (
    <section aria-label="Eval suite" className="mt-6">
      <h2 className="m-0 mb-2 text-base font-semibold">Evals</h2>
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
          onStarted={(id) => {
            setPicked(id);
            void reload();
          }}
        />
      ) : (
        <p className="text-sm">Add cases to {CASES_PATH} to run evals.</p>
      )}
      {error && <ErrorNotice error={error} />}
      {runs && runs.length > 0 && (
        <Table aria-label="Eval history">
          <TableHeader>
            <TableRow>
              <TableHead>Of</TableHead>
              <TableHead>Started</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Pass rate</TableHead>
              <TableHead>Lift</TableHead>
              <TableHead>
                <span className="sr-only">Show</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {runs.map((r) => (
              <TableRow key={r.id} aria-current={shown?.id === r.id ? "true" : undefined}>
                <TableCell>{subjectLabel(r)}</TableCell>
                <TableCell>{new Date(r.startedAt).toLocaleString()}</TableCell>
                <TableCell>
                  {STATUS_TEXT[r.status]}
                  {OPEN.has(r.status) && ` (${r.progress.done} of ${r.progress.total})`}
                </TableCell>
                <TableCell>{pct(r.scorecard?.passRate)}</TableCell>
                <TableCell>
                  {r.scorecard?.lift === null || r.scorecard?.lift === undefined
                    ? "—"
                    : `${r.scorecard.lift > 0 ? "+" : ""}${Math.round(r.scorecard.lift * 100)}`}
                </TableCell>
                <TableCell>
                  <Button type="button" variant="ghost" size="sm" onClick={() => setPicked(r.id)}>
                    Show
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {shown && <ShownRun run={shown} />}
    </section>
  );
}

function ShownRun({ run }: { readonly run: SkillEvalRun }) {
  return (
    <div className="mt-4" aria-label={`Eval of ${subjectLabel(run)}`}>
      <h3 className="m-0 mb-2 text-sm font-semibold">
        Eval of {subjectLabel(run)} ·{" "}
        {run.mode === "full" ? "with a baseline" : "with the skill only"}
      </h3>
      {run.scorecard ? (
        <EvalScorecard card={run.scorecard} />
      ) : OPEN.has(run.status) ? (
        <p role="status" className="text-sm">
          {run.progress.done} of {run.progress.total} runs done…
        </p>
      ) : (
        <Notice tone={run.status === "cancelled" ? "info" : "error"}>
          <p>{run.failure?.message ?? STATUS_TEXT[run.status]}</p>
        </Notice>
      )}
    </div>
  );
}
