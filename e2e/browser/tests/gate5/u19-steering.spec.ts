import { execFileSync } from "node:child_process";
import { RUN_START_TIMEOUT_MS, RUN_TIMEOUT_MS } from "../support/constants.js";
import { expect, test } from "../support/chat.js";
import { allowApproval, bashTurn, FAKE_MODEL, longAnswer, shareTurn } from "../support/gate5.js";

/**
 * Gate 5, U19 (KOBE-227): "The steering panel walks idle → active → queued → waiting →
 * interrupted in one e2e; queued messages can be edited, deleted, reordered; Steer, Stop, Retry,
 * Continue work from the panel; the panel has zero height when idle." Delete, reorder and the
 * keyboard grip are steering-panel.spec.ts; the walk, Edit, Steer, Retry and Continue are here.
 *
 * The interrupted state needs the member's sandbox lost mid-run: KOBE_GATE5_KILL_SANDBOX is a shell
 * command that deletes its pod (e2e/gate5.sh sets it beside kubectl); without it that test skips.
 */
const LONG = longAnswer(
  "No tools. Write a detailed 2000-word short story about a lighthouse keeper and a storm.",
);
const KILL = process.env["KOBE_GATE5_KILL_SANDBOX"];

test("U19: idle → active → queued → waiting; a queued message is edited; Steer and Stop", async ({
  chat,
  page,
}) => {
  test.setTimeout(4 * RUN_TIMEOUT_MS);
  const panel = chat.steering;
  const button = (name: string) => panel.getByRole("button", { name, exact: true });
  const chips = page.locator("li[data-queued]");

  await chat.open();
  await expect(panel).toHaveAttribute("data-state", "idle");
  expect((await panel.boundingBox())?.height ?? 0).toBeLessThan(2);

  // active: a run streams.
  await chat.send(LONG);
  await chat.threadId();
  await expect(panel).toHaveAttribute("data-state", "active", { timeout: RUN_START_TIMEOUT_MS });

  // A message sent now queues; the queue is paused and the run stopped: queued.
  await chat.send("No tools. Reply with the single word QUEUEDONE.");
  await expect(chips).toHaveCount(1);
  await button("Pause the queue").click();
  await button("Stop").click();
  await expect(panel).toHaveAttribute("data-state", "queued", { timeout: RUN_TIMEOUT_MS });

  // Edit the queued message, then resume: the edited text is what runs.
  await panel.getByRole("button", { name: /^Edit queued message 1: / }).click();
  const editor = panel.getByRole("textbox", { name: "Edit queued message 1" });
  await editor.fill("No tools. Reply with the single word QUEUEDEDITED.");
  await panel.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    panel.getByRole("button", { name: /^Edit queued message 1: .*QUEUEDEDITED/ }),
  ).toBeVisible();
  await button("Resume queue").click();
  await chat.waitForIdle();
  await expect(chat.userMessages.last()).toContainText("QUEUEDEDITED");
  await expect(chat.answers.last()).toContainText("QUEUEDEDITED", { timeout: RUN_TIMEOUT_MS });

  // Steer now: the composer's text reaches the running agent in the same run.
  await chat.send(LONG);
  await expect(panel).toHaveAttribute("data-state", "active", { timeout: RUN_START_TIMEOUT_MS });
  await chat.composer.fill("No tools. Reply with the single word STEERED.");
  await button("Steer now").click();
  await expect(chat.composer).toHaveValue("");
  await chat.waitForIdle();
  await expect(page.locator('[data-role="assistant"]', { hasText: "STEERED" }).first()).toBeVisible(
    {
      timeout: RUN_TIMEOUT_MS,
    },
  );

  // waiting: a write tool asks for an approval.
  await chat.ask(bashTurn("echo w > /workspace/g5-waiting.txt"));
  await chat.send(shareTurn("g5-waiting.txt", "G5 waiting"));
  await expect(panel).toHaveAttribute("data-state", "waiting", { timeout: RUN_TIMEOUT_MS });
  await allowApproval(page);
  await chat.waitForIdle();
  await expect(panel).toHaveAttribute("data-state", "idle");
  expect((await panel.boundingBox())?.height ?? 0).toBeLessThan(2);
});

test("U19: interrupted (the sandbox lost mid-run): Retry, then Continue, from the panel", async ({
  chat,
}) => {
  test.skip(
    !KILL,
    "set KOBE_GATE5_KILL_SANDBOX to a command that deletes the member's sandbox pod",
  );
  test.setTimeout(4 * RUN_TIMEOUT_MS);
  const panel = chat.steering;
  const button = (name: string) => panel.getByRole("button", { name, exact: true });
  const interrupt = async () => {
    const answered = await chat.answers.count();
    await chat.send(LONG);
    await chat.threadId();
    await expect(panel).toHaveAttribute("data-state", "active", { timeout: RUN_START_TIMEOUT_MS });
    // Mid-run: the answer is streaming (the panel is active as soon as the server starts the run,
    // while the sandbox may still be starting Pi for it).
    await expect(chat.answers.nth(answered)).toContainText(
      FAKE_MODEL ? "fake line 2 " : /\w+ \w+/,
      {
        timeout: RUN_START_TIMEOUT_MS,
      },
    );
    execFileSync("sh", ["-c", KILL ?? "false"], { stdio: "inherit", timeout: 120_000 });
    await expect(panel).toHaveAttribute("data-state", "interrupted", { timeout: RUN_TIMEOUT_MS });
  };

  await chat.open();
  await interrupt();
  await button("Retry from last entry").click();
  await chat.waitForIdle();
  await expect(panel).toHaveAttribute("data-state", "idle");

  await interrupt();
  await button("Continue without retry").click();
  await expect(panel).not.toHaveAttribute("data-state", "interrupted", { timeout: RUN_TIMEOUT_MS });
  await chat.waitForIdle();
});
