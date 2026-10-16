import { SERVER_CALL_LIMITS, type ServerCallPurpose } from "@kobe/protocol";
import type { Logger } from "pino";
import { AppendError, type NewRunEvent } from "../event-stream/append.js";
import { ServerCallError } from "../models/gateway-client.js";

/**
 * The epilogue of a completed run (KOBE-234; contract in `@kobe/protocol` server-call.ts, design in
 * docs/design/server-model-calls.md). KOBE-219 (title) and KOBE-222 (follow-ups) supply the model
 * calls and the writes; this fixes the order and the failure rules:
 *
 * - the announced calls start **together**, each under its purpose's `timeout_ms` (the epilogue
 *   window is the longest call plus a margin, never their sum);
 * - a title is saved on the thread first (`saveTitle`: false when a rename locked it meanwhile),
 *   and its `thread.updated` event appended after; a refused event (the window closed) leaves the
 *   title saved, so the next thread read shows it;
 * - nothing is retried; a failure is logged (codes only, never content) and writes nothing.
 */
export interface EpilogueDeps {
  readonly threadId: string;
  /** The title call, its reply normalised (`generatedTitleSchema`); undefined: nothing usable. */
  readonly title?: (signal: AbortSignal) => Promise<string | undefined>;
  /** The follow-up call, parsed (`threadSuggestionsSchema`); empty or undefined: nothing usable. */
  readonly followups?: (signal: AbortSignal) => Promise<readonly string[] | undefined>;
  /** `UPDATE threads … WHERE title IS NULL AND NOT title_locked`; true when a row changed. */
  readonly saveTitle: (title: string) => Promise<boolean>;
  /** Appends one epilogue event to the completed run (the append guard checks the window). */
  readonly append: (event: NewRunEvent) => Promise<void>;
  readonly log: Logger;
}

export type TitleOutcome = "saved" | "saved_event_refused" | "locked" | "skipped" | "failed";
export type FollowupsOutcome = "sent" | "refused" | "skipped" | "failed";

export interface EpilogueResult {
  readonly title?: TitleOutcome;
  readonly followups?: FollowupsOutcome;
}

const errorCode = (err: unknown): string =>
  err instanceof AppendError || err instanceof ServerCallError
    ? err.code
    : err instanceof Error
      ? err.name
      : "unknown";

async function titleStep(d: EpilogueDeps, call: NonNullable<EpilogueDeps["title"]>) {
  let title: string | undefined;
  try {
    title = await call(signalFor("title"));
  } catch (err) {
    d.log.warn({ purpose: "title", code: errorCode(err) }, "server call failed");
    return "failed" as const;
  }
  if (!title) return "skipped" as const;
  try {
    if (!(await d.saveTitle(title))) return "locked" as const;
  } catch (err) {
    d.log.warn({ purpose: "title", code: errorCode(err) }, "saving the title failed");
    return "failed" as const;
  }
  try {
    await d.append({ type: "thread.updated", payload: { thread_id: d.threadId, title } });
    return "saved" as const;
  } catch (err) {
    // Saved either way: the next thread read shows it.
    d.log.info({ purpose: "title", code: errorCode(err) }, "title saved; its event was not");
    return "saved_event_refused" as const;
  }
}

async function followupsStep(d: EpilogueDeps, call: NonNullable<EpilogueDeps["followups"]>) {
  let suggestions: readonly string[] | undefined;
  try {
    suggestions = await call(signalFor("followups"));
  } catch (err) {
    d.log.warn({ purpose: "followups", code: errorCode(err) }, "server call failed");
    return "failed" as const;
  }
  if (!suggestions || suggestions.length === 0) return "skipped" as const;
  try {
    await d.append({
      type: "thread.suggestions",
      payload: { thread_id: d.threadId, suggestions },
    });
    return "sent" as const;
  } catch (err) {
    d.log.info({ purpose: "followups", code: errorCode(err) }, "follow-ups not written");
    return "refused" as const;
  }
}

function signalFor(purpose: ServerCallPurpose): AbortSignal {
  return AbortSignal.timeout(SERVER_CALL_LIMITS[purpose].timeout_ms);
}

/** Runs the announced calls concurrently; never throws for a call's failure. */
export async function runEpilogue(d: EpilogueDeps): Promise<EpilogueResult> {
  const [title, followups] = await Promise.all([
    d.title ? titleStep(d, d.title) : undefined,
    d.followups ? followupsStep(d, d.followups) : undefined,
  ]);
  return {
    ...(title === undefined ? {} : { title }),
    ...(followups === undefined ? {} : { followups }),
  };
}
