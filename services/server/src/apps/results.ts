import { z } from "zod";
import { inputDigest } from "../mcp/decide.js";
import { logger } from "../logger.js";
import type { McpPrincipal } from "../mcp/decide.js";
import { verifyCaptureTicket } from "./capture-ticket.js";
import {
  storeCapturedResult,
  type AppResultStoreDeps,
  type StoreOutcome,
} from "./results-store.js";

/**
 * mcp-proxy's report of a UI tool's full upstream result (KOBE-438, spec MA10, T11):
 * `POST /internal/v1/mcp/connectors/{id}/results {ticket, result}` under the internal key and the
 * calling sandbox's own token. Stored only when the ticket is the server's own, unexpired, and
 * names exactly this sandbox, team, user and connector; a sandbox reaches none of this.
 */
export interface AppResultsDeps {
  readonly key: Buffer;
  readonly store: AppResultStoreDeps;
  readonly now?: () => Date;
}

/** Largest call input kept with a result (the MA-4 cap). */
export const APP_RESULT_INPUT_MAX_BYTES = 64 * 1024;

/**
 * The report body: the ticket, the call's input as the upstream ran it (its canonical digest must
 * be the ticket's), and an MCP `CallToolResult` (an object).
 */
export const resultReportSchema = z.strictObject({
  ticket: z.string().min(1).max(4096),
  input: z.record(z.string(), z.unknown()),
  result: z.record(z.string(), z.unknown()),
});

export type ReportOutcome = StoreOutcome | { readonly ok: false; readonly code: "ticket_invalid" };

export async function reportCapturedResult(
  deps: AppResultsDeps,
  principal: McpPrincipal,
  connectorId: string,
  report: z.infer<typeof resultReportSchema>,
): Promise<ReportOutcome> {
  const claims = verifyCaptureTicket(deps.key, report.ticket, deps.now?.() ?? new Date());
  if (
    !claims ||
    claims.sandboxId !== principal.sandboxId ||
    claims.teamId !== principal.teamId ||
    claims.userId !== principal.userId ||
    claims.connectorId !== connectorId
  ) {
    logger.warn({ sandboxId: principal.sandboxId, connectorId }, "app result: ticket refused");
    return { ok: false, code: "ticket_invalid" };
  }
  // An error result is not an app's data: the card shows Pi's text.
  if (report.result["isError"] === true) return { ok: false, code: "ticket_invalid" };
  // The input the app is shown is the one the upstream ran (review LOW-2), never Pi's entry.
  if (
    inputDigest(report.input as never) !== claims.inputSha256 ||
    Buffer.byteLength(JSON.stringify(report.input), "utf8") > APP_RESULT_INPUT_MAX_BYTES
  ) {
    return { ok: false, code: "ticket_invalid" };
  }
  return storeCapturedResult(deps.store, claims, report.input, report.result);
}
