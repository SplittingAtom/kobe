import { describe, expect, it } from "vitest";
import { reprobeReply } from "./reprobe-reply.js";

const NO_TEMPLATES = { changed: 0, added: 0, removed: 0, invalid: 0 };
const done = (outcome: Parameters<typeof reprobeReply>[0] & { kind: "done" }) => outcome;

describe("reprobeReply (KOBE-430)", () => {
  it("words removed-only drift and pending app templates", () => {
    const removed = reprobeReply(
      done({
        kind: "done",
        outcome: { status: "drifted", changed: 0, added: 0, removed: 2, templates: NO_TEMPLATES },
      }),
      "member",
    );
    expect(removed.body.refresh).toMatchObject({
      message: "2 removed. Removed tools are no longer offered.",
    });
    const withTemplates = reprobeReply(
      done({
        kind: "done",
        outcome: {
          status: "drifted",
          changed: 1,
          added: 0,
          removed: 0,
          templates: { ...NO_TEMPLATES, added: 1 },
        },
      }),
      "member",
    );
    expect((withTemplates.body.refresh as { message: string }).message).toBe(
      "1 changed, 0 added, 0 removed. Review them to offer them again. 1 app template to review.",
    );
  });

  it("uses Kobe's own sentence per failure, never the remote's text", () => {
    const fail = (reason: string, source = "member") =>
      reprobeReply({ kind: "done", outcome: { status: "failed", reason } }, source);
    expect(fail("timeout")).toEqual({
      status: 502,
      body: {
        code: "reprobe_failed",
        failure: "timeout",
        message: "The server did not answer in time. Its tools stay as they were.",
      },
    });
    expect(fail("auth_required", "site").body.message).toMatch(/site-wide key/);
    expect(fail("auth_required").body.message).toMatch(/never a member's/);
    expect(fail("brand_new_code").body.message).toBe(
      "The server could not be checked (brand new code). Its tools stay as they were.",
    );
    expect(fail("changed").status).toBe(409);
  });

  it("refuses busy, rate-limited and disabled", () => {
    expect(reprobeReply({ kind: "busy" }, undefined).status).toBe(409);
    expect(reprobeReply({ kind: "rate_limited" }, undefined).status).toBe(429);
    expect(reprobeReply({ kind: "disabled" }, undefined).body.code).toBe("connector_disabled");
  });
});
