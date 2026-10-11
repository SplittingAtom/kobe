import { describe, expect, it } from "vitest";
import type { RunTransition, RunTransitionListener } from "@kobe/protocol";
import { onScheduledRunEnded } from "./run-hook.js";

const transition = (trigger: "user" | "schedule", to: string) =>
  ({
    run: { trigger },
    from: "running",
    to,
    cause: "settled",
    at: "x",
  }) as unknown as RunTransition;

describe("onScheduledRunEnded", () => {
  it("calls the listener for terminal transitions of scheduled runs only", () => {
    let emit: RunTransitionListener = () => undefined;
    const runs = {
      onTransition: (l: RunTransitionListener) => {
        emit = l;
        return () => undefined;
      },
    };
    const seen: string[] = [];
    onScheduledRunEnded(runs, (t) => seen.push(t.to));
    emit(transition("user", "completed"));
    emit(transition("schedule", "running"));
    emit(transition("schedule", "completed"));
    emit(transition("schedule", "failed"));
    expect(seen).toEqual(["completed", "failed"]);
  });
});
