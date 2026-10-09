import type { AuditEntry, TeamAuditEntry } from "@kobe/db";
import { formatPage, csvHeader, type ExportFormat, type ExportScope } from "./format.js";

export const EXPORT_PAGE_SIZE = 200;

export interface ExportPage {
  readonly events: readonly (AuditEntry | TeamAuditEntry)[];
  readonly nextCursor: number | null;
}

export interface ExportOutcome {
  readonly rows: number;
  /** False when the client went away or a page could not be read. */
  readonly complete: boolean;
}

export interface ExportStreamOptions {
  readonly format: ExportFormat;
  readonly scope: ExportScope;
  /** Reads the page of events after `seq` (ascending keyset); called once per pull. */
  readonly fetchPage: (after: number) => Promise<ExportPage>;
  /** Called exactly once, when the stream ends, is cancelled or fails. */
  readonly onDone: (outcome: ExportOutcome) => void | Promise<void>;
}

/**
 * The export body: one page (<= 200 rows) is read and encoded per pull, so memory stays bounded
 * however long the range is, and a slow client slows the reads down. Pages are keyset-paged on
 * `seq`, so concurrent appends can't skip or repeat a row.
 */
export function exportStream(options: ExportStreamOptions): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let after = 0;
  let rows = 0;
  let started = false;
  let done = false;
  const finish = async (complete: boolean) => {
    if (done) return;
    done = true;
    await options.onDone({ rows, complete });
  };
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          if (!started) {
            started = true;
            if (options.format === "csv") {
              controller.enqueue(encoder.encode(csvHeader(options.scope)));
              return;
            }
          }
          const page = await options.fetchPage(after);
          if (page.events.length > 0) {
            rows += page.events.length;
            controller.enqueue(
              encoder.encode(formatPage(page.events, options.format, options.scope)),
            );
          }
          if (page.nextCursor === null) {
            // Record before the client sees the end, so a finished download is always in the log.
            await finish(true);
            controller.close();
          } else {
            after = page.nextCursor;
          }
        } catch (err) {
          await finish(false);
          controller.error(err);
        }
      },
      async cancel() {
        await finish(false);
      },
    },
    { highWaterMark: 0 },
  );
}
