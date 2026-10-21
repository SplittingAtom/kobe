import { describe, expect, it } from "vitest";
import { must } from "../testing/must";
import {
  addCell,
  cellText,
  deleteCell,
  moveCell,
  parseNotebook,
  savedOutputs,
  serializeNotebook,
  setSource,
  withCellIds,
  withSavedResults,
} from "./ipynb";

const NB = {
  nbformat: 4,
  nbformat_minor: 4,
  metadata: { kernelspec: { name: "python3" } },
  cells: [
    { cell_type: "markdown", metadata: {}, source: ["# Title\n", "text"] },
    {
      cell_type: "code",
      id: "c1",
      metadata: {},
      execution_count: 3,
      source: "x = 1",
      outputs: [{ output_type: "stream", name: "stdout", text: ["a\n", "b\n"] }],
    },
  ],
};
const TEXT = JSON.stringify(NB);
const nb0 = () => must(parseNotebook(TEXT));

describe("parseNotebook", () => {
  it("reads nbformat 4 and refuses anything else", () => {
    expect(parseNotebook(TEXT)?.cells).toHaveLength(2);
    expect(parseNotebook("not json")).toBeUndefined();
    expect(parseNotebook(JSON.stringify({ ...NB, nbformat: 3 }))).toBeUndefined();
    expect(parseNotebook(JSON.stringify({ nbformat: 4, cells: [1] }))).toBeUndefined();
    expect(parseNotebook("[]")).toBeUndefined();
  });
});

describe("cell ids (NB1)", () => {
  it("adds ids to cells without one and raises the minor version, never changing the input", () => {
    const nb = nb0();
    let n = 0;
    const { notebook, added } = withCellIds(nb, () => `new${++n}`);
    expect(added).toBe(true);
    expect(notebook.cells.map((c) => c.id)).toEqual(["new1", "c1"]);
    expect(notebook.nbformat_minor).toBe(5);
    expect(must(nb.cells[0]).id).toBeUndefined();
  });

  it("replaces invalid and duplicate ids", () => {
    const nb = must(
      parseNotebook(
        JSON.stringify({
          ...NB,
          nbformat_minor: 5,
          cells: [
            { ...NB.cells[1], id: "same" },
            { ...NB.cells[1], id: "same" },
            { ...NB.cells[1], id: "bad id!" },
          ],
        }),
      ),
    );
    let n = 0;
    const { notebook } = withCellIds(nb, () => `n${++n}`);
    expect(notebook.cells.map((c) => c.id)).toEqual(["same", "n1", "n2"]);
    expect(withCellIds(notebook, () => "x").added).toBe(false);
  });
});

describe("editing", () => {
  const nb = withCellIds(nb0(), () => "m1").notebook;

  it("reads sources given as strings or lines", () => {
    expect(cellText(must(nb.cells[0]).source)).toBe("# Title\ntext");
    expect(cellText(must(nb.cells[1]).source)).toBe("x = 1");
    expect(cellText(42)).toBe("");
  });

  it("sets a source, adds, moves and deletes cells, returning new notebooks", () => {
    const edited = setSource(nb, "c1", "x = 2\ny = 3");
    expect(cellText(must(edited.cells[1]).source)).toBe("x = 2\ny = 3");
    expect(cellText(must(nb.cells[1]).source)).toBe("x = 1");

    const added = addCell(nb, "m1", "code", "k9");
    expect(added.cells.map((c) => c.id)).toEqual(["m1", "k9", "c1"]);
    expect(added.cells[1]).toMatchObject({
      cell_type: "code",
      source: "",
      outputs: [],
      execution_count: null,
    });
    expect(addCell(nb, null, "markdown", "top").cells[0]).toMatchObject({
      id: "top",
      cell_type: "markdown",
    });
    expect(addCell(nb, null, "markdown", "top").cells[0]).not.toHaveProperty("outputs");

    expect(moveCell(nb, "c1", -1).cells.map((c) => c.id)).toEqual(["c1", "m1"]);
    expect(moveCell(nb, "c1", 1)).toBe(nb); // already last
    expect(deleteCell(nb, "m1").cells.map((c) => c.id)).toEqual(["c1"]);
  });

  it("serializes as Jupyter does, with sources as lines", () => {
    const text = serializeNotebook(setSource(nb, "c1", "a\nb"));
    expect(text.endsWith("}\n")).toBe(true);
    expect(text).toContain('\n "cells": [');
    expect(JSON.parse(text).cells[1].source).toEqual(["a\n", "b"]);
  });
});

describe("saved outputs", () => {
  it("reads a cell's outputs into the protocol shape, joining lines", () => {
    const outs = savedOutputs(must(nb0().cells[1]));
    expect(outs).toEqual([{ output_type: "stream", name: "stdout", text: "a\nb\n" }]);
  });

  it("keeps allowed MIME types, and marks outputs it cannot show", () => {
    const cell = {
      cell_type: "code",
      outputs: [
        {
          output_type: "display_data",
          metadata: {},
          data: {
            "text/plain": ["<Figure>"],
            "application/vnd.jupyter.widget-view+json": { model_id: "x" },
          },
        },
        { output_type: "display_data", metadata: {}, data: { "application/x-unknown": "x" } },
        { output_type: "weird" },
        "nonsense",
      ],
    };
    expect(savedOutputs(cell)).toEqual([
      { output_type: "display_data", metadata: {}, data: { "text/plain": "<Figure>" } },
      null,
      null,
      null,
    ]);
    expect(savedOutputs({ cell_type: "code" })).toEqual([]);
  });

  it("replaces outputs and counts with the server's saved version, keeping local sources", () => {
    const local = setSource(withCellIds(nb0(), () => "m1").notebook, "c1", "x = 9");
    const server = {
      ...local,
      cells: local.cells.map((c) =>
        c.id === "c1" ? { ...c, source: "x = 1", outputs: [], execution_count: 7 } : c,
      ),
    };
    const merged = withSavedResults(local, server);
    expect(cellText(must(merged.cells[1]).source)).toBe("x = 9");
    expect(merged.cells[1]).toMatchObject({ outputs: [], execution_count: 7 });
  });
});
