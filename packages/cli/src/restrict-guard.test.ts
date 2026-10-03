import { describe, expect, it } from "vitest";
import { RestrictGuard } from "./restrict-guard.js";

const HEAD =
  "--\n-- PostgreSQL database dump\n--\n\n\\restrict abc123\n\n-- Dumped by pg_dump\n\nSET x = 1;\n";
const BODY = "COPY public.t (id) FROM stdin;\n1\n\\.\n\n";
const TAIL = "--\n-- PostgreSQL database dump complete\n--\n\n\\unrestrict abc123\n\n";

function run(chunks: string[]): string {
  const guard = new RestrictGuard();
  const out = chunks.flatMap((c) => guard.push(Buffer.from(c)));
  out.push(...guard.finish());
  return Buffer.concat(out).toString();
}

describe("RestrictGuard", () => {
  it("passes a script that starts with \\restrict and ends with the matching \\unrestrict", () => {
    const script = HEAD + BODY + TAIL;
    expect(run([script])).toBe(script);
    // Chunk boundaries anywhere, including inside the marker lines.
    expect(run(script.match(/.{1,7}/gs) ?? [])).toBe(script);
  });

  it("finds the head across byte-sized chunks, including split multi-byte characters", () => {
    const script = "-- Dump of café ☕\n" + HEAD + BODY + TAIL;
    const bytes = Buffer.from(script);
    const guard = new RestrictGuard();
    const out = [...bytes].flatMap((b) => guard.push(Buffer.from([b])));
    out.push(...guard.finish());
    expect(Buffer.concat(out).toString()).toBe(script);
  });

  it("holds output back until the head is verified", () => {
    const guard = new RestrictGuard();
    expect(guard.push(Buffer.from("--\n-- PostgreSQL database dump\n--\n\n\\restr"))).toEqual([]);
    expect(Buffer.concat(guard.push(Buffer.from("ict k\n"))).toString()).toContain("\\restrict k");
  });

  it("refuses a script whose first command is not \\restrict", () => {
    expect(() => run(["--\n\n\\! touch /tmp/pwned\n\\restrict abc\n" + TAIL])).toThrow(
      /does not start with \\restrict/,
    );
    expect(() => run(["SET x = 1;\n" + TAIL])).toThrow(/does not start with \\restrict/);
  });

  it("refuses a missing or mismatched \\unrestrict", () => {
    expect(() => run([HEAD + BODY])).toThrow(/does not end with/);
    expect(() => run([HEAD + BODY + "\\unrestrict other\n"])).toThrow(/does not end with/);
    expect(() => run([HEAD + BODY + TAIL + "SELECT 1;\n"])).toThrow(/does not end with/);
  });

  it("refuses an endless header", () => {
    const guard = new RestrictGuard();
    expect(() => {
      for (let i = 0; i < 10_000; i += 1) guard.push(Buffer.from("-- comment line\n"));
    }).toThrow(/does not start with \\restrict/);
  });
});
