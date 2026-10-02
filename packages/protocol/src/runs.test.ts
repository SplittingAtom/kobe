import { describe, expect, it } from "vitest";
import {
  ACTIVE_RUN_STATUSES,
  RUN_STATUSES,
  RUN_TRANSITIONS,
  RUN_TRANSITION_CAUSES,
  TERMINAL_RUN_STATUSES,
  canTransition,
  checkRetry,
  nextThreadStatus,
  queueMayAdvance,
  submitMessageBodySchema,
  type ActorContext,
  type RunStatus,
} from "./index.js";
import { EXAMPLE_IDS, createFakeRunOrchestrator } from "./testing/index.js";

describe("run states", () => {
  it("are exactly the spec §5.4 runs.status set", () => {
    expect(RUN_STATUSES).toEqual([
      "queued",
      "running",
      "waiting_approval",
      "completed",
      "failed",
      "interrupted",
      "cancelled",
      "budget_stopped",
    ]);
  });

  it("partition into active, queued and terminal", () => {
    const all = new Set<RunStatus>([...ACTIVE_RUN_STATUSES, ...TERMINAL_RUN_STATUSES, "queued"]);
    expect([...all].sort()).toEqual([...RUN_STATUSES].sort());
  });
});

describe("run transition table", () => {
  const allowed: [RunStatus, RunStatus][] = [
    ["queued", "running"],
    ["queued", "failed"],
    ["queued", "cancelled"],
    ["queued", "budget_stopped"],
    ["running", "waiting_approval"],
    ["running", "completed"],
    ["running", "failed"],
    ["running", "interrupted"],
    ["running", "cancelled"],
    ["running", "budget_stopped"],
    ["waiting_approval", "running"],
    ["waiting_approval", "failed"],
    ["waiting_approval", "interrupted"],
    ["waiting_approval", "cancelled"],
    ["waiting_approval", "budget_stopped"],
  ];
  const key = (from: RunStatus, to: RunStatus) => `${from}->${to}`;
  const allowedKeys = new Set(allowed.map(([f, t]) => key(f, t)));
  const everyPair = RUN_STATUSES.flatMap((from) => RUN_STATUSES.map((to) => [from, to] as const));

  it.each(allowed)("allows %s → %s", (from, to) => {
    expect(canTransition(from, to)).toBe(true);
  });

  it.each(everyPair.filter(([f, t]) => !allowedKeys.has(key(f, t))))(
    "forbids %s → %s",
    (from, to) => {
      expect(canTransition(from, to)).toBe(false);
    },
  );

  it("has no exits from terminal states (retry makes a new run)", () => {
    for (const status of TERMINAL_RUN_STATUSES) expect(RUN_TRANSITIONS[status]).toEqual({});
  });

  it("checks the cause when given", () => {
    expect(canTransition("waiting_approval", "failed", "approval_expired")).toBe(true);
    expect(canTransition("running", "failed", "approval_expired")).toBe(false);
    expect(canTransition("running", "completed", "settled")).toBe(true);
    expect(canTransition("running", "completed", "dequeued")).toBe(false);
  });

  it("uses every declared cause somewhere", () => {
    const used = new Set(
      Object.values(RUN_TRANSITIONS).flatMap((targets) => Object.values(targets).flat()),
    );
    expect([...used].sort()).toEqual([...RUN_TRANSITION_CAUSES].sort());
  });
});

describe("thread status and queue rule", () => {
  it.each([
    ["idle", { kind: "run_status", to: "running", was_active: false }, "running"],
    ["running", { kind: "run_status", to: "waiting_approval", was_active: true }, "running"],
    ["running", { kind: "run_status", to: "completed", was_active: true }, "idle"],
    ["running", { kind: "run_status", to: "cancelled", was_active: true }, "idle"],
    ["running", { kind: "run_status", to: "failed", was_active: true }, "idle"],
    ["running", { kind: "run_status", to: "interrupted", was_active: true }, "interrupted"],
    ["running", { kind: "run_status", to: "cancelled", was_active: false }, "running"],
    ["interrupted", { kind: "run_status", to: "cancelled", was_active: false }, "interrupted"],
    ["interrupted", { kind: "run_status", to: "queued", was_active: false }, "interrupted"],
    ["interrupted", { kind: "run_status", to: "running", was_active: false }, "running"],
    ["interrupted", { kind: "queue_resumed" }, "idle"],
    ["running", { kind: "queue_resumed" }, "running"],
  ] as const)("%s + %j → %s", (from, event, to) => {
    expect(nextThreadStatus(from, event)).toBe(to);
  });

  it("only an idle thread advances its queue", () => {
    expect([
      queueMayAdvance("idle"),
      queueMayAdvance("running"),
      queueMayAdvance("interrupted"),
    ]).toEqual([true, false, false]);
  });

  it("retries only the latest ended, interrupted, not-yet-retried run", () => {
    const runs = [
      { run_id: "a", status: "interrupted" },
      { run_id: "b", status: "interrupted" },
      { run_id: "c", status: "queued" },
    ] as const;
    expect(checkRetry(runs, "b")).toBe("ok");
    expect(checkRetry(runs, "a")).toBe("not_latest");
    expect(checkRetry(runs, "c")).toBe("not_interrupted");
    expect(
      checkRetry([...runs, { run_id: "d", status: "running", retry_of_run_id: "b" }], "b"),
    ).toBe("already_retried");
  });
});

describe("API bodies", () => {
  it("validates POST /v1/threads/{id}/messages", () => {
    expect(
      submitMessageBodySchema.safeParse({ content: "hi", file_ids: [EXAMPLE_IDS.file] }).success,
    ).toBe(true);
    expect(submitMessageBodySchema.safeParse({ content: "" }).success).toBe(false);
    expect(submitMessageBodySchema.safeParse({ content: "hi", parent_entry_id: "" }).success).toBe(
      false,
    );
  });
});

describe("fake run orchestrator", () => {
  const actor: ActorContext = {
    user_id: EXAMPLE_IDS.user,
    team_id: EXAMPLE_IDS.team,
    install_role: "user",
    team_role: "member",
  };
  const other: ActorContext = { ...actor, team_id: EXAMPLE_IDS.otherTeam };
  const thread = EXAMPLE_IDS.thread;
  const msg = { thread_id: thread, content: "hi", trigger: "user" as const };

  it("runs one message per thread and queues the rest in order", async () => {
    const orch = createFakeRunOrchestrator();
    const first = await orch.submitMessage(actor, msg);
    const second = await orch.submitMessage(actor, msg);
    const third = await orch.submitMessage(actor, msg);
    expect([first.queued, second.queued, third.queued]).toEqual([false, true, true]);
    expect((await orch.getRun(actor, third.run_id)).queue_pos).toBe(2);
    orch.advance(first.run_id, "completed", "settled");
    expect((await orch.getRun(actor, second.run_id)).status).toBe("running");
    expect((await orch.getRun(actor, third.run_id)).queue_pos).toBe(1);
  });

  it("enforces the transition table, steering and retry rules", async () => {
    const orch = createFakeRunOrchestrator();
    const { run_id } = await orch.submitMessage(actor, msg);
    await orch.steer(actor, run_id, { content: "faster" });
    orch.advance(run_id, "waiting_approval", "approval_requested");
    expect(() => orch.advance(run_id, "completed", "settled")).toThrow(/not allowed/);
    await expect(orch.retry(actor, run_id)).rejects.toThrow(/interrupted/);
    await orch.markSandboxLost(actor.team_id, EXAMPLE_IDS.sandbox);
    const retried = await orch.retry(actor, run_id);
    expect((await orch.getRun(actor, retried.run_id)).retry_of_run_id).toBe(run_id);
    await expect(orch.steer(actor, run_id, { content: "x" })).rejects.toThrow(/cannot steer/);
  });

  it("hides other teams' runs and runs schedules in auto mode", async () => {
    const orch = createFakeRunOrchestrator();
    const { run_id } = await orch.submitMessage(actor, {
      ...msg,
      trigger: "schedule",
      approval_mode: "ask-all",
    });
    expect((await orch.getRun(actor, run_id)).approval_mode).toBe("auto");
    await expect(orch.getRun(other, run_id)).rejects.toThrow(/not found/);
  });

  it("budget-stops active and queued runs and reports transitions", async () => {
    const orch = createFakeRunOrchestrator();
    const seen: string[] = [];
    orch.onTransition((t) => seen.push(`${t.from}->${t.to}`));
    await orch.submitMessage(actor, msg);
    await orch.submitMessage(actor, msg);
    const stopped = await orch.stopForBudget({ team_id: actor.team_id, scope: "team" });
    expect(stopped).toHaveLength(2);
    expect(seen).toEqual(["queued->running", "queued->budget_stopped", "running->budget_stopped"]);
  });

  it("blocks the queue after an interrupted run until retry or resume", async () => {
    const orch = createFakeRunOrchestrator();
    const first = await orch.submitMessage(actor, msg);
    const queued = await orch.submitMessage(actor, msg);
    await orch.markSandboxLost(actor.team_id, EXAMPLE_IDS.sandbox);
    expect(orch.threadStatus(actor.team_id, thread)).toBe("interrupted");
    expect((await orch.getRun(actor, queued.run_id)).status).toBe("queued");

    const retried = await orch.retry(actor, first.run_id);
    expect(retried.queued).toBe(false);
    expect(await orch.retry(actor, first.run_id)).toEqual(retried);
    expect((await orch.getRun(actor, queued.run_id)).status).toBe("queued");
    orch.advance(retried.run_id, "completed", "settled");
    expect((await orch.getRun(actor, queued.run_id)).status).toBe("running");
  });

  it("resumes the queue without retry, and rejects retrying an older run", async () => {
    const orch = createFakeRunOrchestrator();
    const first = await orch.submitMessage(actor, msg);
    await orch.markSandboxLost(actor.team_id, EXAMPLE_IDS.sandbox);
    const second = await orch.submitMessage(actor, msg);
    expect(second.queued).toBe(true);
    await orch.resumeQueue(actor, thread);
    expect((await orch.getRun(actor, second.run_id)).status).toBe("running");
    await orch.markSandboxLost(actor.team_id, EXAMPLE_IDS.sandbox);
    await expect(orch.retry(actor, first.run_id)).rejects.toThrow(/not_latest/);
    expect((await orch.retry(actor, second.run_id)).queued).toBe(false);
  });
});
