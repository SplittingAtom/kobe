import { Writable } from "node:stream";
import { pino } from "pino";
import { describe, expect, it } from "vitest";
import { serializeError } from "./log-safety.js";
import { LOGGER_OPTIONS } from "./logger.js";

/** A stand-in with drizzle's DrizzleQueryError shape (message embeds the query and params). */
class DrizzleQueryError extends Error {
  constructor(
    readonly query: string,
    readonly params: unknown[],
    cause: unknown,
  ) {
    super(`Failed query: ${query}\nparams: ${params.join(",")}`);
    this.name = "DrizzleQueryError";
    this.cause = cause;
  }
}

const SECRET = "the user's private message";

function pgError(): Error {
  return Object.assign(new Error("unsupported Unicode escape sequence"), {
    code: "22P05",
    detail: `\\u0000 in ${SECRET}`,
    where: `JSON data, line 1: ${SECRET}`,
    routine: "json_lex",
  });
}

describe("error serializer (no query params or content in logs)", () => {
  it("keeps the pg code and message, drops query, params, detail and the leaking stack line", () => {
    const err = new DrizzleQueryError("insert into run_events values ($1)", [SECRET], pgError());
    const out = JSON.stringify(serializeError(err));
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain("insert into");
    expect(serializeError(err)).toMatchObject({
      type: "DrizzleQueryError",
      message: "database query failed",
      cause: { code: "22P05", message: "unsupported Unicode escape sequence" },
    });
  });

  it("sanitises query errors nested in causes and keeps ordinary errors readable", () => {
    const wrapped = new Error("append failed", {
      cause: new DrizzleQueryError("select $1", [SECRET], pgError()),
    });
    const out = serializeError(wrapped);
    expect(JSON.stringify(out)).not.toContain(SECRET);
    expect(out).toMatchObject({ type: "Error", message: "append failed" });
    expect(serializeError("plain")).toEqual({ message: "plain" });
  });

  it("is the logger's err serializer", () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _enc, done) {
        lines.push(chunk.toString());
        done();
      },
    });
    const log = pino(LOGGER_OPTIONS, sink);
    log.child({ c: 1 }).error({ err: new DrizzleQueryError("q", [SECRET], pgError()) }, "boom");
    expect(lines.join("")).not.toContain(SECRET);
  });
});
