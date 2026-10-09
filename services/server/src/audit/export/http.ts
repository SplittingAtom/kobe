import type { Context } from "hono";
import { z } from "zod";
import { recordAuditAfter } from "../record.js";
import type { KobeDb } from "@kobe/db";
import { EXPORT_CONTENT_TYPE, type ExportFormat, type ExportScope } from "./format.js";
import { exportStream, type ExportPage } from "./stream.js";

const exportQuerySchema = z.strictObject({
  format: z.enum(["csv", "jsonl"]),
  since: z.iso.datetime({ offset: true }).optional(),
  until: z.iso.datetime({ offset: true }).optional(),
  teamId: z.uuid().optional(),
});

export type ExportQuery = z.output<typeof exportQuerySchema>;
type Parsed = { ok: true; value: ExportQuery } | { ok: false; response: Response };

/** Validates export parameters: a format and an optional date range (strict, unknown keys 400). */
export function parseExportQuery(c: Context, { allowTeamFilter = true } = {}): Parsed {
  const raw = c.req.query();
  const parsed = exportQuerySchema.safeParse(raw);
  const rangeOk =
    !parsed.success ||
    parsed.data.since === undefined ||
    parsed.data.until === undefined ||
    Date.parse(parsed.data.since) <= Date.parse(parsed.data.until);
  if (!parsed.success || !rangeOk || (!allowTeamFilter && raw.teamId !== undefined)) {
    return {
      ok: false,
      response: c.json(
        {
          code: "invalid_request",
          message:
            "Check the parameters: format csv or jsonl; since and until as ISO date-times " +
            "(since not after until)" +
            (allowTeamFilter ? "; teamId as an id." : "."),
        },
        400,
      ),
    };
  }
  return { ok: true, value: parsed.data };
}

export interface ExportResponseOptions {
  readonly db: KobeDb;
  readonly query: ExportQuery;
  readonly scope: ExportScope;
  readonly actorId: string;
  /** Set for a team export: the recorded `audit.exported` belongs to this team. */
  readonly teamId?: string;
  readonly fetchPage: (after: number) => Promise<ExportPage>;
  readonly now?: () => Date;
}

/** Streams the download and records `audit.exported` (rows sent, whether it finished) at the end. */
export function exportResponse(c: Context, o: ExportResponseOptions): Response {
  const format: ExportFormat = o.query.format;
  const stamp = (o.now?.() ?? new Date()).toISOString().slice(0, 10);
  const body = exportStream({
    format,
    scope: o.scope,
    fetchPage: o.fetchPage,
    onDone: ({ rows, complete }) =>
      recordAuditAfter(o.db, {
        action: "audit.exported",
        actor: { kind: "user", id: o.actorId },
        ...(o.teamId ? { teamId: o.teamId } : {}),
        target: {
          format,
          ...(o.query.since ? { from: new Date(o.query.since).toISOString() } : {}),
          ...(o.query.until ? { to: new Date(o.query.until).toISOString() } : {}),
          rows,
          complete,
        },
      }),
  });
  c.header("content-type", EXPORT_CONTENT_TYPE[format]);
  c.header("content-disposition", `attachment; filename="kobe-audit-${stamp}.${format}"`);
  c.header("cache-control", "no-store");
  c.header("x-content-type-options", "nosniff");
  return c.body(body);
}
