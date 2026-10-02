import { describe, expect, it } from "vitest";
import { LineSplitter, encodeJsonl } from "./jsonl.js";

function split(chunks: (string | Buffer)[], maxLineBytes = 1024) {
  const lines: string[] = [];
  const oversize: number[] = [];
  const splitter = new LineSplitter({
    maxLineBytes,
    onLine: (line) => lines.push(line),
    onOversize: (bytes) => oversize.push(bytes),
  });
  for (const chunk of chunks) splitter.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  splitter.end();
  return { lines, oversize };
}

describe("LineSplitter (Pi JSONL framing)", () => {
  it("splits on LF only and strips an optional CR", () => {
    expect(split(['{"a":1}\n{"b":2}\r\n', '{"c":3}']).lines).toEqual([
      '{"a":1}',
      '{"b":2}',
      '{"c":3}',
    ]);
  });

  it("does not split on U+2028 / U+2029 (unlike Node readline)", () => {
    const record = JSON.stringify({ text: "a b c" });
    expect(split([`${record}\n`]).lines).toEqual([record]);
  });

  it("reassembles records and multi-byte characters split across chunks", () => {
    const bytes = Buffer.from('{"t":"héllo 🎉"}\n');
    const parts = [bytes.subarray(0, 9), bytes.subarray(9, 14), bytes.subarray(14)];
    expect(split(parts).lines).toEqual(['{"t":"héllo 🎉"}']);
  });

  it("skips empty lines", () => {
    expect(split(["\n\n{}\n\r\n"]).lines).toEqual(["{}"]);
  });

  it("drops an oversize record up to its LF, then continues (bounded memory)", () => {
    const result = split(["x".repeat(600), "y".repeat(600), "\n", '{"ok":1}\n'], 1000);
    expect(result.lines).toEqual(['{"ok":1}']);
    expect(result.oversize).toEqual([1200]);
  });

  it("encodes one record per line", () => {
    expect(encodeJsonl({ a: "x\ny" })).toBe('{"a":"x\\ny"}\n');
  });
});
