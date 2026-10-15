import { beforeEach, describe, expect, it } from "vitest";
import { must } from "../testing/must";
import {
  REGENERATE_FIRST_WITH_OTHER_MODEL,
  SAME_MODEL_RESELECT,
  threadEntries,
} from "./testing/pi-sequences";
import { assistant, entry, modelChange, resetEntrySeq, text, user } from "./testing/entries";
import { messageMeta, projectThread, type Projection } from "./tree";

beforeEach(() => resetEntrySeq());

/**
 * KOBE-280: a model marker says what changed on its branch. The branch's first model reads
 * "Model: X" (`first`), a real switch "Model changed to Y", and a `model_change` to the model the
 * branch already records (a KOBE-259 limits re-select, a Pi started without a model) shows none.
 * Model changes with no message between them show their net result only (coordinator, KOBE-280).
 */
function modelMarkers(p: Projection) {
  return p.items.flatMap((item) => {
    const meta = messageMeta(item.message);
    return [...(meta?.before ?? []), ...(meta?.after ?? [])].flatMap((m) =>
      m.kind === "model" ? [[item.message.id, m.model, m.first]] : [],
    );
  });
}

describe("model markers on real Pi entry orders (KOBE-280)", () => {
  it("Regenerate with… on the first answer: the setup model reads as the thread's, one change", () => {
    // Both versions carry the setup model from above the fork; only version 2 switched.
    const entries = threadEntries(REGENERATE_FIRST_WITH_OTHER_MODEL);
    expect(modelMarkers(projectThread(entries, "a2"))).toEqual([
      ["u1", "openai/gpt-fake", true],
      ["u2", "openai/gpt-fake", true],
      ["u2", "anthropic/claude-fake", false],
    ]);
  });

  it("a same-model re-select shows no marker (ac-2)", () => {
    const p = projectThread(threadEntries(SAME_MODEL_RESELECT), "a2");
    expect(modelMarkers(p)).toEqual([["u1", "openai/gpt-fake", true]]);
    expect(
      messageMeta(must(p.items.find((i) => i.message.id === "a1")).message),
    ).not.toHaveProperty("after");
  });
});

describe("the branch's recorded model (KOBE-280)", () => {
  it("a switch and a switch back each show a change; a repeat shows none", () => {
    const entries = [
      modelChange("m0", null, "fast"),
      user("u1", "m0", "1"),
      assistant("a1", "u1", text("1")),
      modelChange("m1", "a1", "deep"),
      user("u2", "m1", "2"),
      assistant("a2", "u2", text("2")),
      modelChange("m2", "a2", "deep"),
      user("u3", "m2", "3"),
      assistant("a3", "u3", text("3")),
      modelChange("m3", "a3", "fast"),
      user("u4", "m3", "4"),
    ];
    expect(modelMarkers(projectThread(entries, "u4"))).toEqual([
      ["u1", "fast", true],
      ["a1", "deep", false],
      ["a3", "fast", false],
    ]);
  });

  it("an answer's model counts as recorded, as Pi resolves the branch's model", () => {
    // Before KOBE-279 a restart on a branch point could answer on another model without a
    // model_change: the answer's model is what the branch was on.
    const entries = [
      modelChange("m0", null, "fast"),
      user("u1", "m0", "1"),
      entry("a1", "u1", { role: "assistant", model: "deep", content: [text("1")] }),
      modelChange("m1", "a1", "deep"),
      user("u2", "m1", "2"),
      entry("a2", "u2", { role: "assistant", model: "deep", content: [text("2")] }),
      modelChange("m2", "a2", "fast"),
      user("u3", "m2", "3"),
    ];
    expect(modelMarkers(projectThread(entries, "u3"))).toEqual([
      ["u1", "fast", true],
      ["a2", "fast", false],
    ]);
  });

  it("what one branch records does not count on another", () => {
    const entries = [
      user("u1", null, "q"),
      assistant("a1", "u1", text("a")),
      modelChange("m1", "a1", "deep"),
      user("u2", "m1", "branch A"),
      modelChange("m2", "a1", "fast"),
      user("u3", "m2", "branch B"),
      assistant("a3", "u3", text("b")),
      modelChange("m3", "a3", "deep"),
      user("u4", "m3", "more"),
    ];
    expect(modelMarkers(projectThread(entries, "u4"))).toEqual([
      ["u2", "deep", true],
      ["u3", "fast", true],
      ["a3", "deep", false],
    ]);
  });
});

/** Root versions as Regenerate with… builds them: each next version branches below the last switch. */
function rootVersions(...models: string[]) {
  const entries = [modelChange("m0", null, "A"), user("u0", "m0", "one")];
  let point = "m0";
  models.forEach((model, i) => {
    entries.push(
      entry(`b${i}`, point, null, "custom"),
      modelChange(`m${i + 1}`, `b${i}`, model),
      user(`u${i + 1}`, `m${i + 1}`, "one"),
    );
    point = `m${i + 1}`;
  });
  return entries;
}

const markersOf = (p: Projection, id: string) => {
  const meta = messageMeta(must(p.items.find((i) => i.message.id === id)).message);
  return [...(meta?.before ?? []), ...(meta?.after ?? [])].flatMap((m) =>
    m.kind === "model" ? [`${m.first ? "Model:" : "Model changed to"} ${m.model}`] : [],
  );
};

describe("a chain of model changes shows its net result (KOBE-280)", () => {
  it("version 3 back on the thread's first model shows no change", () => {
    const p = projectThread(rootVersions("B", "A"), "u2");
    expect(markersOf(p, "u1")).toEqual(["Model: A", "Model changed to B"]);
    expect(markersOf(p, "u2")).toEqual(["Model: A"]);
  });

  it("version 3 on a third model shows one change", () => {
    const p = projectThread(rootVersions("B", "C"), "u2");
    expect(markersOf(p, "u2")).toEqual(["Model: A", "Model changed to C"]);
  });

  it("mid-thread, a chain is judged against the previous answer's model", () => {
    const entries = [
      modelChange("m0", null, "A"),
      user("u1", "m0", "1"),
      entry("a1", "u1", { role: "assistant", model: "A", content: [text("1")] }),
      modelChange("m1", "a1", "B"),
      modelChange("m2", "m1", "C"),
      modelChange("m3", "m2", "A"),
      user("u2", "m3", "2"),
      entry("a2", "u2", { role: "assistant", model: "A", content: [text("2")] }),
      modelChange("m4", "a2", "B"),
      modelChange("m5", "m4", "C"),
      user("u3", "m5", "3"),
    ];
    const p = projectThread(entries, "u3");
    expect(markersOf(p, "a1")).toEqual([]);
    expect(markersOf(p, "a2")).toEqual(["Model changed to C"]);
  });

  it("below a fork, the chain is judged against the model at the fork", () => {
    // A switch with no fork above it, then a regenerate below it back on the earlier model.
    const entries = [
      modelChange("m0", null, "A"),
      user("u1", "m0", "1"),
      entry("a1", "u1", { role: "assistant", model: "A", content: [text("1")] }),
      modelChange("m1", "a1", "B"),
      user("u2", "m1", "2"),
      entry("b2", "m1", null, "custom"),
      modelChange("m2", "b2", "A"),
      user("u3", "m2", "2"),
    ];
    const p = projectThread(entries, "u3");
    expect(markersOf(p, "a1")).toEqual(["Model changed to B"]);
    expect(markersOf(p, "u3")).toEqual(["Model changed to A"]);
    expect(markersOf(p, "u2")).toEqual([]);
  });
});
