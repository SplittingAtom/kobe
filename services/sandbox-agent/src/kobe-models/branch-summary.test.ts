import { describe, expect, it } from "vitest";
import {
  BranchSummaryCommand,
  type BranchSummaryContextLike,
  type TreeEntryLike,
} from "./branch-summary.js";
import {
  BRANCH_SUMMARY_REQUEST_UI_TITLE,
  BRANCH_SUMMARY_RESULT_UI_TITLE,
  parseBranchSummaryOutcome,
  parseBranchSummaryRequest,
} from "./branch-summary-protocol.js";

/** KOBE-548: the kobe-branch-summary command, gated by the agent's armed request. */
function fakeCtx(options: {
  answer?: string | undefined;
  leaf?: string;
  onNavigate?: (target: string, summarize: boolean) => { cancelled: boolean } | Error;
}) {
  const entries = new Map<string, TreeEntryLike>([
    ["a", { type: "message", id: "a", parentId: null }],
    ["b", { type: "message", id: "b", parentId: "a" }],
    ["c", { type: "message", id: "c", parentId: "a" }],
  ]);
  let leaf: string | null = options.leaf ?? "c";
  const dialogs: { title: string; placeholder?: string }[] = [];
  const navigations: { target: string; summarize: boolean; focus?: string }[] = [];
  const ctx: BranchSummaryContextLike = {
    ui: {
      input: async (title, placeholder) => {
        dialogs.push({ title, ...(placeholder === undefined ? {} : { placeholder }) });
        return title === BRANCH_SUMMARY_REQUEST_UI_TITLE ? options.answer : undefined;
      },
    },
    sessionManager: { getLeafId: () => leaf, getEntry: (id) => entries.get(id) },
    navigateTree: async (target, opts) => {
      const summarize = opts?.summarize === true;
      navigations.push({
        target,
        summarize,
        ...(opts?.customInstructions === undefined ? {} : { focus: opts.customInstructions }),
      });
      const outcome = options.onNavigate?.(target, summarize);
      if (outcome instanceof Error) throw outcome;
      if (outcome !== undefined) return outcome;
      if (summarize) {
        entries.set("s1", { type: "branch_summary", id: "s1", parentId: target });
        leaf = "s1";
      } else {
        leaf = target;
      }
      return { cancelled: false };
    },
  };
  const outcome = () => {
    const reported = dialogs.find((d) => d.title === BRANCH_SUMMARY_RESULT_UI_TITLE);
    return reported === undefined ? undefined : parseBranchSummaryOutcome(reported.placeholder);
  };
  return { ctx, dialogs, navigations, outcome };
}

const armed = (request: object) => JSON.stringify(request);

describe("kobe-branch-summary command", () => {
  it("refuses when the agent did not arm it (a member typed the command)", async () => {
    const warnings: string[] = [];
    const f = fakeCtx({ answer: undefined });
    await new BranchSummaryCommand((w) => warnings.push(w)).handle(f.ctx);
    expect(f.navigations).toEqual([]);
    expect(f.dialogs.map((d) => d.title)).toEqual([BRANCH_SUMMARY_REQUEST_UI_TITLE]);
    expect(warnings.join()).toContain("refused");
  });

  it("summarises from the leaf to the target and reports the entry", async () => {
    const f = fakeCtx({ answer: armed({ from: "c", to: "b", focus: "keep it" }) });
    await new BranchSummaryCommand(() => undefined).handle(f.ctx);
    expect(f.navigations).toEqual([{ target: "b", summarize: true, focus: "keep it" }]);
    expect(f.outcome()).toEqual({ ok: true, entry_id: "s1", parent_id: "b" });
  });

  it("moves to the thread's leaf first when Pi's leaf is elsewhere", async () => {
    const f = fakeCtx({ leaf: "b", answer: armed({ from: "c", to: "b" }) });
    await new BranchSummaryCommand(() => undefined).handle(f.ctx);
    expect(f.navigations).toEqual([
      { target: "c", summarize: false },
      { target: "b", summarize: true },
    ]);
    expect(f.outcome()).toMatchObject({ ok: true, parent_id: "b" });
  });

  it("cancels a branch without a message as nothing_to_summarize", async () => {
    const command = new BranchSummaryCommand(() => undefined);
    const f = fakeCtx({
      answer: armed({ from: "c", to: "b" }),
      onNavigate: (_t, summarize) => {
        if (!summarize) return { cancelled: false };
        const cancel = command.beforeTree({
          userWantsSummary: true,
          entriesToSummarize: [{ type: "custom" }],
        });
        return { cancelled: cancel?.cancel === true };
      },
    });
    await command.handle(f.ctx);
    expect(f.outcome()).toMatchObject({ ok: false, code: "nothing_to_summarize" });
  });

  it("lets other tree navigations and real branches through the guard", () => {
    const command = new BranchSummaryCommand(() => undefined);
    expect(command.beforeTree({ userWantsSummary: true, entriesToSummarize: [] })).toBeUndefined();
  });

  it("maps Pi's errors to codes", async () => {
    for (const [error, code] of [
      [
        "Wait for the current response to finish before navigating the session tree.",
        "thread_busy",
      ],
      ["No model available for summarization", "model_not_configured"],
      ["kobe.model_error:model_budget_exhausted: no budget", "summary_failed"],
    ] as const) {
      const f = fakeCtx({
        answer: armed({ from: "c", to: "b" }),
        onNavigate: () => new Error(error),
      });
      await new BranchSummaryCommand(() => undefined).handle(f.ctx);
      expect(f.outcome()).toMatchObject({ ok: false, code });
    }
  });

  it("reports nothing_to_summarize when Pi moved without a summary", async () => {
    const f = fakeCtx({
      answer: armed({ from: "c", to: "c" }),
      onNavigate: () => ({ cancelled: false }),
    });
    await new BranchSummaryCommand(() => undefined).handle(f.ctx);
    expect(f.outcome()).toMatchObject({ ok: false, code: "nothing_to_summarize" });
  });

  it("moves Pi back to the old leaf after a failure that left it elsewhere (review L1)", async () => {
    let leaf = "c";
    const f = fakeCtx({ answer: armed({ from: "c", to: "b" }) });
    const ctx = {
      ...f.ctx,
      sessionManager: { ...f.ctx.sessionManager, getLeafId: () => leaf },
      navigateTree: async (target: string, opts?: { summarize?: boolean }) => {
        f.navigations.push({ target, summarize: opts?.summarize === true });
        // Pi moved to the target without writing a summary.
        leaf = target;
        return { cancelled: false };
      },
    };
    await new BranchSummaryCommand(() => undefined).handle(ctx);
    expect(f.outcome()).toMatchObject({ ok: false, code: "nothing_to_summarize" });
    expect(f.navigations).toEqual([
      { target: "b", summarize: true },
      { target: "c", summarize: false },
    ]);
    expect(leaf).toBe("c");
  });
});

describe("branch summary channel parsers", () => {
  it("takes only the exact request shape", () => {
    expect(parseBranchSummaryRequest(armed({ from: "a", to: "b" }))).toEqual({
      from: "a",
      to: "b",
    });
    for (const bad of [
      undefined,
      "not json",
      armed({ from: "a" }),
      armed({ from: "a", to: "b", extra: 1 }),
      armed({ from: "a b", to: "b" }),
      armed({ from: "a", to: "b", focus: "" }),
    ]) {
      expect(parseBranchSummaryRequest(bad)).toBeUndefined();
    }
  });

  it("takes only known outcomes", () => {
    expect(parseBranchSummaryOutcome(armed({ ok: false, code: "nope" }))).toBeUndefined();
    expect(parseBranchSummaryOutcome(armed({ ok: true, entry_id: "x" }))).toBeUndefined();
    expect(
      parseBranchSummaryOutcome(armed({ ok: false, code: "summary_failed", detail: 3 })),
    ).toEqual({ ok: false, code: "summary_failed", detail: "" });
  });
});
