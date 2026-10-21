import { describe, expect, it } from "vitest";
import { toolText } from "./summary.js";

describe("run_python text for the model (NB13)", () => {
  it("joins streams, results and errors, and notes what only the user sees", () => {
    const text = toolText([
      { output_type: "stream", name: "stdout", text: "hi\n" },
      {
        output_type: "execute_result",
        execution_count: 1,
        data: { "text/plain": "   a\n0  1", "text/html": "<table/>" },
        metadata: {},
      },
      {
        output_type: "display_data",
        data: { "image/png": "AA==", "text/plain": "<Figure>" },
        metadata: {},
      },
      {
        output_type: "error",
        ename: "ValueError",
        evalue: "bad",
        traceback: ["\u001b[0;31mValueError\u001b[0m Traceback", "  line 1"],
      },
    ]);
    expect(text).toBe(
      "hi\n   a\n0  1\n[text/html output shown to the user]\n[image/png output shown to the user]\n<Figure>\nValueError Traceback\n  line 1\nValueError: bad\n",
    );
  });

  it("keeps the head and the tail within the limit", () => {
    const text = toolText(
      [
        { output_type: "stream", name: "stdout", text: `start${"x".repeat(5000)}` },
        { output_type: "error", ename: "E", evalue: "the end", traceback: [] },
      ],
      1000,
    );
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(1000);
    expect(text.startsWith("start")).toBe(true);
    expect(text).toContain("bytes cut");
    expect(text.endsWith("E: the end\n")).toBe(true);
  });
});
