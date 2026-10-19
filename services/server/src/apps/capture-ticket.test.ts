import { describe, expect, it } from "vitest";
import {
  CAPTURE_TICKET_TTL_MS,
  captureKey,
  signCaptureTicket,
  verifyCaptureTicket,
  type CaptureClaims,
} from "./capture-ticket.js";

/** KOBE-438: the server's signed promise that one allowed call's result may be stored. */
const key = captureKey("s".repeat(48));
const claims: CaptureClaims = {
  teamId: "11111111-1111-4111-8111-111111111111",
  userId: "22222222-2222-4222-8222-222222222222",
  sandboxId: "sb-1",
  threadId: "33333333-3333-4333-8333-333333333333",
  runId: "44444444-4444-4444-8444-444444444444",
  connectorId: "55555555-5555-4555-8555-555555555555",
  tool: "open_explorer",
  piName: "mcp__cat__open_explorer",
  inputSha256: "a".repeat(64),
  templateUri: "ui://cat/explorer",
  templateSha256: "b".repeat(64),
  appId: "c".repeat(64),
};
const now = new Date("2026-10-19T10:00:00Z");

describe("capture tickets", () => {
  it("round-trips the claims until they expire", () => {
    const ticket = signCaptureTicket(key, claims, now);
    expect(verifyCaptureTicket(key, ticket, now)).toEqual(claims);
    const late = new Date(now.getTime() + CAPTURE_TICKET_TTL_MS + 1);
    expect(verifyCaptureTicket(key, ticket, late)).toBeUndefined();
  });

  it("refuses another key, a changed payload or signature, and junk", () => {
    const ticket = signCaptureTicket(key, claims, now);
    expect(verifyCaptureTicket(captureKey("t".repeat(48)), ticket, now)).toBeUndefined();
    const [body, mac] = ticket.split(".") as [string, string];
    const forged = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(body, "base64url").toString()),
        runId: claims.threadId,
      }),
    ).toString("base64url");
    expect(verifyCaptureTicket(key, `${forged}.${mac}`, now)).toBeUndefined();
    expect(verifyCaptureTicket(key, `${body}.${"A".repeat(mac.length)}`, now)).toBeUndefined();
    for (const junk of ["", ".", "a.b.c", "x".repeat(5000)]) {
      expect(verifyCaptureTicket(key, junk, now)).toBeUndefined();
    }
  });
});
