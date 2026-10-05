import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { ENVELOPE_KEY_ENV, ENVELOPE_KEY_PREVIOUS_ENV, loadEnvelope } from "./config.js";
import { Envelope, EnvelopeError, type EnvelopeContext } from "./envelope.js";

const KEY = "install-key-".padEnd(48, "k");
const OTHER = "another-key-".padEnd(48, "o");
const CTX: EnvelopeContext = { teamId: "team-1", kind: "connector_grant", recordId: "rec-1" };

describe("Envelope", () => {
  it("round-trips strings and bytes with a fresh data key per seal", () => {
    const e = new Envelope(KEY);
    const a = e.seal("sk-live-abc", CTX);
    expect(a).toMatch(/^e1\.[0-9a-f]{12}(\.[A-Za-z0-9_-]+){6}$/);
    expect(a).not.toContain("sk-live-abc");
    expect(e.openString(a, CTX)).toBe("sk-live-abc");
    expect(a).not.toBe(e.seal("sk-live-abc", CTX));
    expect(e.open(e.seal(new Uint8Array([1, 2, 3]), CTX), CTX)).toEqual(Buffer.from([1, 2, 3]));
    expect(e.openString(e.seal("", CTX), CTX)).toBe("");
  });

  it("refuses another key", () => {
    const sealed = new Envelope(KEY).seal("s", CTX);
    expect(() => new Envelope(OTHER).open(sealed, CTX)).toThrow(/does not hold/);
  });

  it("refuses another team, kind or record (AAD binding)", () => {
    const e = new Envelope(KEY);
    const sealed = e.seal("s", CTX);
    for (const other of [
      { ...CTX, teamId: "team-2" },
      { ...CTX, kind: "api_key" },
      { ...CTX, recordId: "rec-2" },
      { teamId: "team-", kind: CTX.kind, recordId: "1rec-1" },
    ]) {
      expect(() => e.open(sealed, other)).toThrow(EnvelopeError);
    }
  });

  it("refuses tampering in every segment and malformed input", () => {
    const e = new Envelope(KEY);
    const parts = e.seal("s", CTX).split(".");
    for (let i = 2; i < parts.length; i++) {
      const copy = [...parts];
      const seg = copy[i] as string;
      copy[i] = (seg[0] === "A" ? "B" : "A") + seg.slice(1);
      expect(() => e.open(copy.join("."), CTX), `segment ${i}`).toThrow(EnvelopeError);
    }
    for (const bad of [
      "",
      "e1.a.b",
      "plain",
      "e2.a.b.c.d.e.f.g",
      `${parts.slice(0, 7).join(".")}`,
    ]) {
      expect(() => e.open(bad, CTX)).toThrow(/not an envelope/);
    }
  });

  it("refuses a key id relabelled to another held key (kid is authenticated)", () => {
    const old = new Envelope(OTHER);
    const both = new Envelope([KEY, OTHER]);
    const sealed = old.seal("s", CTX).split(".");
    sealed[1] = both.currentKeyId;
    expect(() => both.open(sealed.join("."), CTX)).toThrow(EnvelopeError);
  });

  it("validates the context and the key length", () => {
    const e = new Envelope(KEY);
    expect(() => e.seal("s", { ...CTX, teamId: "" })).toThrow(/invalid envelope context/);
    expect(() => e.seal("s", { ...CTX, kind: "Bad Kind" })).toThrow(/invalid envelope context/);
    expect(() => new Envelope("short")).toThrow(EnvelopeError);
    expect(() => new Envelope([])).toThrow(EnvelopeError);
  });

  it("rotates: previous keys still open, rewrap moves to the current key", () => {
    const sealed = new Envelope(OTHER).seal("s", CTX);
    const rotated = new Envelope([KEY, OTHER]);
    expect(rotated.isCurrent(sealed)).toBe(false);
    expect(Envelope.keyIdOf(sealed)).toBe(new Envelope(OTHER).currentKeyId);
    expect(rotated.openString(sealed, CTX)).toBe("s");
    const re = rotated.rewrap(sealed, CTX);
    expect(rotated.isCurrent(re)).toBe(true);
    expect(re.split(".").slice(5)).toEqual(sealed.split(".").slice(5));
    expect(new Envelope(KEY).openString(re, CTX)).toBe("s");
    expect(() => rotated.rewrap(sealed, { ...CTX, recordId: "x" })).toThrow(EnvelopeError);
  });

  it("is unusable after destroy", () => {
    const e = new Envelope(KEY);
    e.destroy();
    expect(() => e.seal("s", CTX)).toThrow(/destroyed/);
  });

  it("never exposes the key in errors, string forms or logs", () => {
    const logs: string[] = [];
    const logger = { info: (o: object, m?: string) => logs.push(JSON.stringify([o, m])) };
    const e = loadEnvelope(
      { [ENVELOPE_KEY_ENV]: KEY, [ENVELOPE_KEY_PREVIOUS_ENV]: OTHER },
      logger,
    ) as Envelope;
    const seen: string[] = [
      JSON.stringify(e),
      String(e),
      inspect(e, { showHidden: true, depth: 5 }),
    ];
    const attempt = (fn: () => unknown) => {
      try {
        fn();
      } catch (err) {
        seen.push(String((err as Error).stack), (err as Error).message);
      }
    };
    const sealed = e.seal("s", CTX);
    attempt(() => e.open(sealed, { ...CTX, teamId: "t2" }));
    attempt(() => e.open("garbage", CTX));
    attempt(() => new Envelope("short-secret"));
    attempt(() => loadEnvelope({ [ENVELOPE_KEY_ENV]: "short" }));
    attempt(() => loadEnvelope({ [ENVELOPE_KEY_PREVIOUS_ENV]: KEY }));
    expect(logs).toHaveLength(1);
    const all = [...seen, ...logs].join("\n");
    for (const secret of [KEY, OTHER, "short"]) expect(all).not.toContain(secret);
    expect(all).not.toMatch(/install-key|another-key/);
  });
});

describe("loadEnvelope", () => {
  it("is undefined when unset and rejects a previous key alone or a short key", () => {
    expect(loadEnvelope({})).toBeUndefined();
    expect(() => loadEnvelope({ [ENVELOPE_KEY_PREVIOUS_ENV]: KEY })).toThrow(/needs/);
    expect(() => loadEnvelope({ [ENVELOPE_KEY_ENV]: "x" })).toThrow(/at least 32/);
    expect(() =>
      loadEnvelope({ [ENVELOPE_KEY_ENV]: KEY, [ENVELOPE_KEY_PREVIOUS_ENV]: "x" }),
    ).toThrow(/PREVIOUS/);
  });
});
