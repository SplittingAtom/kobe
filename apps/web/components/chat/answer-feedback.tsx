"use client";

import { useAuiState } from "@assistant-ui/react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  FEEDBACK_COMMENT_MAX_CHARS,
  FEEDBACK_REASONS,
  REASON_LABELS,
  type AnswerFeedback,
  type FeedbackChange,
  type FeedbackReason,
  type ThreadFeedback,
} from "../../lib/chat/feedback";
import type { KobeMessageMeta } from "../../lib/chat/tree";
import { cn } from "../../lib/utils";
import { IconAction } from "../shell/icon-action";
import { Button } from "../ui/button";
import { useKobeExtras } from "./kobe-runtime";

/**
 * Thumbs up and down on answers (KOBE-275). Each member rates for themselves, readers of a shared
 * thread included; nobody sees another member's rating. The rating is saved on the click; a thumbs
 * down then offers optional reason chips and a short comment. Clicking the pressed thumb again
 * clears the rating.
 *
 * assistant-ui's `ActionBarPrimitive.FeedbackPositive/Negative` were the first choice but don't
 * fit: they submit through a runtime adapter and keep the state in the runtime's message metadata
 * (rebuilt here from the entry projection on every change), and they can't clear a rating or take
 * reasons. The buttons below keep their shape (`aria-pressed`) with Kobe's state.
 */

interface Answer {
  readonly runId: string;
  readonly feedback: AnswerFeedback | null;
}

interface FeedbackContextValue {
  /** The rateable answers by their prompt entry id; null while unread. */
  readonly answers: ReadonlyMap<string, Answer> | null;
  readonly save: (runId: string, change: FeedbackChange) => Promise<boolean>;
  readonly clear: (runId: string) => Promise<boolean>;
}

const FeedbackContext = createContext<FeedbackContextValue | null>(null);

function byPrompt(data: ThreadFeedback): Map<string, Answer> {
  return new Map(
    data.answers.flatMap((a) =>
      a.userEntryId === null ? [] : [[a.userEntryId, { runId: a.runId, feedback: a.feedback }]],
    ),
  );
}

function withFeedback(
  answers: ReadonlyMap<string, Answer>,
  runId: string,
  feedback: AnswerFeedback | null,
): Map<string, Answer> {
  return new Map([...answers].map(([k, a]) => [k, a.runId === runId ? { runId, feedback } : a]));
}

/**
 * The open thread's rateable answers and the member's ratings (`GET /v1/threads/{id}/feedback`),
 * read when the thread opens and again when a run ends (a new answer to rate).
 */
export function AnswerFeedbackProvider({ children }: { readonly children: ReactNode }) {
  const extras = useKobeExtras();
  const controller = extras?.controller;
  const threadId = extras?.state.threadId ?? null;
  const ended = extras?.state.live?.terminal ? extras.state.live.runId : null;
  const [read, setRead] = useState<{
    threadId: string;
    answers: ReadonlyMap<string, Answer>;
  } | null>(null);
  useEffect(() => {
    if (!controller || threadId === null) return;
    let current = true;
    void controller.threadFeedback()?.then((res) => {
      if (!current) return;
      if (res.ok) setRead({ threadId, answers: byPrompt(res.data) });
      // Ratings are a nicety: the conversation stays usable; the next run's end reads again.
      else console.warn("Answer ratings could not be read", res.error);
    });
    return () => {
      current = false;
    };
  }, [controller, threadId, ended]);
  const answers = read !== null && read.threadId === threadId ? read.answers : null;
  const save = useCallback(
    async (runId: string, change: FeedbackChange) => {
      if (!controller || threadId === null) return false;
      const res = await controller.rateAnswer(runId, change);
      if (!res.ok) return false;
      setRead((r) =>
        r && r.threadId === threadId
          ? { threadId, answers: withFeedback(r.answers, runId, res.data) }
          : r,
      );
      return true;
    },
    [controller, threadId],
  );
  const clear = useCallback(
    async (runId: string) => {
      if (!controller || threadId === null) return false;
      const res = await controller.clearRating(runId);
      if (!res.ok) return false;
      setRead((r) =>
        r && r.threadId === threadId
          ? { threadId, answers: withFeedback(r.answers, runId, null) }
          : r,
      );
      return true;
    },
    [controller, threadId],
  );
  const value = useMemo(() => ({ answers, save, clear }), [answers, save, clear]);
  return <FeedbackContext.Provider value={value}>{children}</FeedbackContext.Provider>;
}

interface ScopeValue {
  readonly detailsOpen: boolean;
  readonly setDetailsOpen: (open: boolean) => void;
  readonly error: string | null;
  readonly setError: (error: string | null) => void;
}

const ScopeContext = createContext<ScopeValue | null>(null);

/** One answer's feedback state shared by its buttons and its details form. */
export function AnswerFeedbackScope({ children }: { readonly children: ReactNode }) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const value = useMemo(
    () => ({ detailsOpen, setDetailsOpen, error, setError }),
    [detailsOpen, error],
  );
  return <ScopeContext.Provider value={value}>{children}</ScopeContext.Provider>;
}

const NOT_SAVED = "Your rating wasn't saved. Try again.";

/** This message's answer, its rating and the actions; null when it can't be rated. */
function useAnswerFeedback() {
  const meta = useAuiState((s) => s.message.metadata.custom as KobeMessageMeta | undefined);
  const context = useContext(FeedbackContext);
  const scope = useContext(ScopeContext);
  if (!context?.answers || !scope || meta?.kind !== "assistant" || meta.live) return null;
  const prompt = meta.promptEntryId;
  const answer = prompt === undefined ? undefined : context.answers.get(prompt);
  if (!answer) return null;
  return { answer, entryId: meta.entryIds.at(-1) ?? null, context, scope };
}

/** The thumbs, in the answer's action bar. */
export function AnswerFeedbackButtons() {
  const found = useAnswerFeedback();
  const busy = useRef(false);
  if (!found) return null;
  const { answer, entryId, context, scope } = found;
  const rating = answer.feedback?.rating ?? null;
  const act = async (run: () => Promise<boolean>) => {
    if (busy.current) return;
    busy.current = true;
    try {
      const ok = await run();
      scope.setError(ok ? null : NOT_SAVED);
    } finally {
      busy.current = false;
    }
  };
  const up = () =>
    act(async () => {
      scope.setDetailsOpen(false);
      return rating === "up"
        ? context.clear(answer.runId)
        : context.save(answer.runId, { rating: "up", entryId });
    });
  const down = () =>
    act(async () => {
      if (rating === "down") {
        scope.setDetailsOpen(false);
        return context.clear(answer.runId);
      }
      const ok = await context.save(answer.runId, { rating: "down", entryId });
      if (ok) scope.setDetailsOpen(true);
      return ok;
    });
  return (
    <>
      <IconAction
        command="rate-up"
        size="sm"
        aria-pressed={rating === "up"}
        description={rating === "up" ? "Click again to clear your rating." : undefined}
        className={cn(rating === "up" && "text-foreground")}
        onClick={() => void up()}
      />
      <IconAction
        command="rate-down"
        size="sm"
        aria-pressed={rating === "down"}
        description={rating === "down" ? "Click again to clear your rating." : undefined}
        className={cn(rating === "down" && "text-foreground")}
        onClick={() => void down()}
      />
    </>
  );
}

/** Below the action bar: why a thumbs down (optional chips and comment), and save errors. */
export function AnswerFeedbackDetails() {
  const found = useAnswerFeedback();
  const scope = useContext(ScopeContext);
  if (scope?.error) {
    return (
      <p role="alert" className="text-destructive mx-2 mt-1 text-xs">
        {scope.error}
      </p>
    );
  }
  if (!found || !found.scope.detailsOpen || found.answer.feedback?.rating !== "down") return null;
  return (
    <DetailsForm
      key={found.answer.runId}
      runId={found.answer.runId}
      feedback={found.answer.feedback}
      entryId={found.entryId}
      save={found.context.save}
      onDone={() => found.scope.setDetailsOpen(false)}
      onError={found.scope.setError}
    />
  );
}

function DetailsForm({
  runId,
  feedback,
  entryId,
  save,
  onDone,
  onError,
}: {
  readonly runId: string;
  readonly feedback: AnswerFeedback;
  readonly entryId: string | null;
  readonly save: FeedbackContextValue["save"];
  readonly onDone: () => void;
  readonly onError: (error: string | null) => void;
}) {
  const [reasons, setReasons] = useState<readonly FeedbackReason[]>(feedback.reasons);
  const [comment, setComment] = useState(feedback.comment ?? "");
  const [saving, setSaving] = useState(false);
  const commentId = useId();
  const counterId = useId();
  const toggle = (r: FeedbackReason) =>
    setReasons((rs) => (rs.includes(r) ? rs.filter((x) => x !== r) : [...rs, r]));
  const submit = async () => {
    setSaving(true);
    const ok = await save(runId, { rating: "down", reasons, comment, entryId });
    setSaving(false);
    onError(ok ? null : NOT_SAVED);
    if (ok) onDone();
  };
  return (
    <form
      aria-label="What went wrong?"
      className="border-foreground/10 bg-muted/30 mx-2 mt-2 flex max-w-xl flex-col gap-2 rounded-xl border p-3"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") onDone();
      }}
    >
      <p className="text-sm font-medium">What went wrong? (optional)</p>
      <div role="group" aria-label="Reasons" className="flex flex-wrap gap-1.5">
        {FEEDBACK_REASONS.map((r) => (
          <Button
            key={r}
            type="button"
            size="xs"
            variant={reasons.includes(r) ? "secondary" : "outline"}
            aria-pressed={reasons.includes(r)}
            onClick={() => toggle(r)}
          >
            {REASON_LABELS[r]}
          </Button>
        ))}
      </div>
      <label htmlFor={commentId} className="text-muted-foreground text-xs">
        Comment (only you see it)
      </label>
      <textarea
        id={commentId}
        aria-describedby={counterId}
        className="border-input bg-background focus-visible:ring-ring/50 min-h-16 w-full resize-y rounded-md border px-2 py-1.5 text-sm outline-none focus-visible:ring-[3px]"
        maxLength={FEEDBACK_COMMENT_MAX_CHARS}
        value={comment}
        onChange={(e) => setComment(e.target.value)}
      />
      <div className="flex items-center gap-2">
        <span id={counterId} className="text-muted-foreground me-auto text-xs tabular-nums">
          {comment.length}/{FEEDBACK_COMMENT_MAX_CHARS}
        </span>
        <Button type="button" variant="ghost" size="sm" onClick={onDone}>
          Close
        </Button>
        <Button type="submit" size="sm" disabled={saving}>
          Send
        </Button>
      </div>
    </form>
  );
}
