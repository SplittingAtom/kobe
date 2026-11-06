import {
  BRANCH_SUMMARY_COMMAND,
  BRANCH_SUMMARY_REQUEST_UI_TITLE,
  BRANCH_SUMMARY_RESULT_UI_TITLE,
  branchSummaryFailure,
  parseBranchSummaryRequest,
  type BranchSummaryOutcome,
} from "./branch-summary-protocol.js";

/** The agent answers both dialogs from memory; never hold Pi on one that does not. */
const DIALOG_WAIT_MS = 5_000;

/** The slice of a session entry the command reads (Pi's `SessionEntry`). */
export interface TreeEntryLike {
  readonly type: string;
  readonly id: string;
  readonly parentId: string | null;
}

/** The slice of Pi's `ExtensionCommandContext` the command uses (structural, no Pi dependency). */
export interface BranchSummaryContextLike {
  readonly ui?: {
    readonly input?: (title: string, placeholder?: string) => Promise<string | undefined>;
  };
  readonly sessionManager: {
    readonly getLeafId: () => string | null;
    readonly getEntry: (id: string) => TreeEntryLike | undefined;
  };
  readonly navigateTree: (
    targetId: string,
    options?: { summarize?: boolean; customInstructions?: string },
  ) => Promise<{ cancelled: boolean }>;
}

/** `session_before_tree`'s preparation (Pi `TreePreparation`), the part the guard reads. */
export interface TreePreparationLike {
  readonly userWantsSummary?: boolean;
  readonly entriesToSummarize?: readonly { readonly type?: unknown }[];
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(undefined);
      },
    );
  });
}

/** Pi's thrown text as an outcome code (verified Pi 1.4.0 `navigateTree`). */
function thrownOutcome(error: unknown): BranchSummaryOutcome {
  const message = error instanceof Error ? error.message : String(error);
  if (/^Wait for the current/.test(message)) return branchSummaryFailure("thread_busy", message);
  if (/^No model available\b/.test(message)) {
    return branchSummaryFailure("model_not_configured", message);
  }
  return branchSummaryFailure("summary_failed", message);
}

/**
 * The `kobe-branch-summary` command (KOBE-548, CT11): Pi summarises the branch it leaves and appends
 * a `branch_summary` entry at the target (spike KOBE-541). One per arming: the request comes from
 * the agent, never from the prompt, so a member who types the command gets nothing.
 */
export class BranchSummaryCommand {
  /** Set by the before-tree guard when it cancelled a summary with nothing to summarise. */
  #nothing = false;
  #active = false;

  constructor(private readonly warn: (message: string) => void) {}

  get name(): string {
    return BRANCH_SUMMARY_COMMAND;
  }

  /**
   * `session_before_tree` while the command runs: a summary of a branch without a message is
   * cancelled (Pi would only move its leaf, spike note 5). Undefined lets Pi go on.
   */
  beforeTree(preparation: TreePreparationLike | undefined): { cancel: true } | undefined {
    if (!this.#active || preparation?.userWantsSummary !== true) return undefined;
    const entries = preparation.entriesToSummarize ?? [];
    if (entries.some((entry) => entry.type === "message")) return undefined;
    this.#nothing = true;
    return { cancel: true };
  }

  async handle(ctx: BranchSummaryContextLike): Promise<void> {
    const input = ctx.ui?.input;
    if (input === undefined || this.#active) {
      this.warn("kobe-branch-summary: refused (no agent channel or already running)");
      return;
    }
    const request = parseBranchSummaryRequest(
      await withTimeout(input(BRANCH_SUMMARY_REQUEST_UI_TITLE), DIALOG_WAIT_MS),
    );
    if (request === undefined) {
      // Not armed by the agent: a member typed the command. Nothing is written.
      this.warn("kobe-branch-summary: refused (not requested by the sandbox agent)");
      return;
    }
    this.#active = true;
    this.#nothing = false;
    let outcome: BranchSummaryOutcome;
    try {
      outcome = await this.#run(ctx, request.from, request.to, request.focus);
    } finally {
      this.#active = false;
    }
    await withTimeout(
      input(BRANCH_SUMMARY_RESULT_UI_TITLE, JSON.stringify(outcome)),
      DIALOG_WAIT_MS,
    );
  }

  async #run(
    ctx: BranchSummaryContextLike,
    from: string,
    to: string,
    focus: string | undefined,
  ): Promise<BranchSummaryOutcome> {
    const sessions = ctx.sessionManager;
    try {
      // Pi's leaf after a restart or restore is the file's last line (spike note 3): move it to
      // the thread's leaf first (writes nothing), then summarise from there.
      if (sessions.getLeafId() !== from) {
        if (sessions.getEntry(from) === undefined) {
          return branchSummaryFailure("summary_failed", "the old leaf is not in the session");
        }
        const moved = await ctx.navigateTree(from, {});
        if (moved.cancelled || sessions.getLeafId() !== from) {
          return branchSummaryFailure("summary_failed", "Pi did not move to the old leaf");
        }
      }
      if (sessions.getEntry(to) === undefined) {
        return branchSummaryFailure("summary_failed", "the target is not in the session");
      }
      const result = await ctx.navigateTree(to, {
        summarize: true,
        ...(focus === undefined ? {} : { customInstructions: focus }),
      });
      if (this.#nothing)
        return branchSummaryFailure("nothing_to_summarize", "no message to summarize");
      if (result.cancelled)
        return branchSummaryFailure("summary_failed", "the summary was cancelled");
      const leaf = sessions.getLeafId();
      const entry = leaf === null ? undefined : sessions.getEntry(leaf);
      if (entry === undefined || entry.type !== "branch_summary" || entry.id === from) {
        // Pi moved without a summary (the target was the leaf, or the summary came back empty).
        return branchSummaryFailure("nothing_to_summarize", "Pi appended no summary");
      }
      if (entry.parentId === null) {
        return branchSummaryFailure("summary_failed", "the summary has no parent");
      }
      return { ok: true, entry_id: entry.id, parent_id: entry.parentId };
    } catch (error) {
      return thrownOutcome(error);
    }
  }
}
