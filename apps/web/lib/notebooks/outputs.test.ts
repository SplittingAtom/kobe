// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import type { NotebookOutput } from "@kobe/protocol";
import { must } from "../testing/must";
import { outputView, stripAnsi, terminalText } from "./outputs";

const display = (data: Record<string, unknown>): NotebookOutput =>
  ({ output_type: "display_data", data, metadata: {} }) as NotebookOutput;

const parse = (html: string) => new DOMParser().parseFromString(html, "text/html");

const DATAFRAME = `<div><style scoped>.dataframe tbody tr th { color: red }</style>
<table border="1" class="dataframe"><thead><tr style="text-align: right;"><th></th><th>a</th><th>b</th></tr></thead>
<tbody><tr><th>0</th><td>1</td><td>&lt;img src=x onerror=alert(1)&gt;</td></tr><tr><th>1</th><td>2</td><td>y</td></tr></tbody></table></div>`;

describe("terminal text", () => {
  it("strips ANSI colours and cursor codes, never interpreting them", () => {
    expect(stripAnsi("\u001b[0;31mValueError\u001b[0m: bad\u001b[1A\u001b]0;title\u0007")).toBe(
      "ValueError: bad",
    );
  });

  it("keeps the last overwrite of a carriage-return line (progress bars)", () => {
    expect(terminalText("10%\r50%\r100%\ndone\r\n")).toBe("100%\ndone\n");
  });
});

describe("outputView", () => {
  it("shows stream text and tracebacks as plain text", () => {
    expect(
      outputView({ output_type: "stream", name: "stderr", text: "\u001b[31m<b>warn</b>\u001b[0m" }),
    ).toEqual({ kind: "stream", name: "stderr", text: "<b>warn</b>" });
    expect(
      outputView({
        output_type: "error",
        ename: "ZeroDivisionError",
        evalue: "division by zero",
        traceback: ["\u001b[0;31m----\u001b[0m", "Cell In[1], line 1"],
      }),
    ).toEqual({
      kind: "error",
      title: "ZeroDivisionError: division by zero",
      traceback: "----\nCell In[1], line 1",
    });
  });

  it("shows PNG and JPEG as data URLs, SVG as an image data URL (never markup)", () => {
    expect(outputView(display({ "image/png": "iVBO\nRw==\n", "text/plain": "<Figure>" }))).toEqual({
      kind: "image",
      src: "data:image/png;base64,iVBORw==",
      alt: "<Figure>",
    });
    expect(outputView(display({ "image/jpeg": "/9j/" }))).toMatchObject({
      src: "data:image/jpeg;base64,/9j/",
      alt: "Output image",
    });
    const svg = outputView(display({ "image/svg+xml": '<svg><script>alert("é")</script></svg>' }));
    expect(svg.kind).toBe("image");
    if (svg.kind !== "image") return;
    expect(svg.src.startsWith("data:image/svg+xml;base64,")).toBe(true);
    const decoded = new TextDecoder().decode(
      Uint8Array.from(atob(must(svg.src.split(",")[1])), (c) => c.charCodeAt(0)),
    );
    expect(decoded).toBe('<svg><script>alert("é")</script></svg>');
  });

  it("turns a DataFrame's HTML into a table of plain text, never markup", () => {
    const view = outputView(display({ "text/html": DATAFRAME, "text/plain": "   a  b" }), parse);
    expect(view).toEqual({
      kind: "table",
      header: [["", "a", "b"]],
      rows: [
        ["0", "1", "<img src=x onerror=alert(1)>"],
        ["1", "2", "y"],
      ],
      truncated: false,
    });
  });

  it("caps very large tables", () => {
    const rows = Array.from({ length: 600 }, (_, i) => `<tr><td>${i}</td></tr>`).join("");
    const html = `<table class="dataframe"><tbody>${rows}</tbody></table>`;
    const view = outputView(display({ "text/html": html }), parse);
    expect(view.kind === "table" && view.rows.length).toBe(500);
    expect(view.kind === "table" && view.truncated).toBe(true);
  });

  it("sends other HTML to the sandboxed frame only", () => {
    expect(
      outputView(display({ "text/html": "<div id=plot><script>1</script></div>" }), parse),
    ).toEqual({
      kind: "html",
      html: "<div id=plot><script>1</script></div>",
    });
    // Without a parser (no DOM), even a DataFrame stays in the frame.
    expect(outputView(display({ "text/html": DATAFRAME }))).toMatchObject({ kind: "html" });
  });

  it("reads a table schema from application/json", () => {
    const view = outputView(
      display({
        "application/json": {
          schema: { fields: [{ name: "index" }, { name: "v" }] },
          data: [
            { index: 0, v: "a" },
            { index: 1, v: null },
          ],
        },
      }),
    );
    expect(view).toEqual({
      kind: "table",
      header: [["index", "v"]],
      rows: [
        ["0", "a"],
        ["1", ""],
      ],
      truncated: false,
    });
  });

  it("falls back through markdown, JSON, LaTeX and plain text", () => {
    expect(outputView(display({ "text/markdown": "**b**", "text/plain": "b" }))).toEqual({
      kind: "markdown",
      text: "**b**",
    });
    expect(outputView(display({ "application/json": { a: 1 } }))).toEqual({
      kind: "text",
      text: '{\n  "a": 1\n}',
    });
    expect(outputView(display({ "text/latex": "$x$" }))).toEqual({ kind: "text", text: "$x$" });
    expect(
      outputView({
        output_type: "execute_result",
        execution_count: 1,
        data: { "text/plain": "\u001b[1m2\u001b[0m" },
        metadata: {},
      }),
    ).toEqual({ kind: "text", text: "2" });
    expect(outputView(null)).toEqual({ kind: "unsupported" });
  });
});
