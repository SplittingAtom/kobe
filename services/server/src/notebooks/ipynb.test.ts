import { describe, expect, it } from "vitest";
import { cellSource, parseNotebook, serializeNotebook, withOutputs } from "./ipynb.js";

const NB = {
  nbformat: 4,
  nbformat_minor: 5,
  metadata: { kernelspec: { name: "python3" } },
  cells: [
    { id: "md", cell_type: "markdown", metadata: {}, source: ["# Title\n"] },
    {
      id: "c1",
      cell_type: "code",
      metadata: {},
      execution_count: null,
      outputs: [],
      source: ["x = 1\n", "x + 1"],
    },
  ],
};

describe("ipynb (NB1, NB11)", () => {
  it("parses nbformat 4 only", () => {
    expect(parseNotebook(JSON.stringify(NB))).toBeDefined();
    expect(parseNotebook("not json")).toBeUndefined();
    expect(parseNotebook(JSON.stringify({ ...NB, nbformat: 3 }))).toBeUndefined();
    expect(parseNotebook(JSON.stringify({ nbformat: 4 }))).toBeUndefined();
    expect(parseNotebook(JSON.stringify({ ...NB, cells: [1] }))).toBeUndefined();
  });

  it("reads a code cell's source by id", () => {
    const nb = parseNotebook(JSON.stringify(NB));
    if (!nb) throw new Error("parse");
    expect(cellSource(nb, "c1")).toEqual({ ok: true, source: "x = 1\nx + 1" });
    expect(cellSource(nb, "md")).toEqual({ ok: false, problem: "not_code_cell" });
    expect(cellSource(nb, "nope")).toEqual({ ok: false, problem: "cell_not_found" });
  });

  it("writes outputs as nbformat lines into a copy, leaving the original alone", () => {
    const nb = parseNotebook(JSON.stringify(NB));
    if (!nb) throw new Error("parse");
    const out = withOutputs(
      nb,
      "c1",
      [
        { output_type: "stream", name: "stdout", text: "a\nb\n" },
        {
          output_type: "execute_result",
          execution_count: 3,
          data: { "text/plain": "2", "image/png": "iVBORw0=" },
          metadata: {},
        },
      ],
      3,
    );
    expect(out?.cells[1]).toMatchObject({
      execution_count: 3,
      outputs: [
        { output_type: "stream", name: "stdout", text: ["a\n", "b\n"] },
        { output_type: "execute_result", data: { "text/plain": ["2"], "image/png": "iVBORw0=" } },
      ],
    });
    expect(nb.cells[1]).toMatchObject({ outputs: [], execution_count: null });
    expect(withOutputs(nb, "md", [], 1)).toBeUndefined();
    const text = serializeNotebook(out ?? nb);
    expect(text.endsWith("}\n")).toBe(true);
    expect(text).toContain('\n "cells": [');
    expect(parseNotebook(text)?.metadata).toEqual(NB.metadata);
  });
});
