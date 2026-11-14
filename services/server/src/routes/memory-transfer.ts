import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Context } from "hono";
import {
  SEMANTIC_MEMORY_IMPORT_MAX_BYTES,
  semanticMemoryExportQuerySchema,
  semanticMemoryExportToCsv,
  semanticMemoryImportCommitRequestSchema,
  semanticMemoryImportPreviewRequestSchema,
  utf8ByteLength,
} from "@kobe/protocol";
import type { z } from "zod";
import type { TeamVariables } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import { exportItems } from "../memory/items/export-items.js";
import { commitImport, previewImport } from "../memory/items/import.js";
import { hitRateLimit } from "../rate-limit.js";
import { invalidRequest } from "../teams/http.js";
import { issueText, memoryRouteKit, refuseAgentWrites } from "./memory-items.js";

type Ctx = Context<{ Variables: TeamVariables }>;

/**
 * Largest import request (review-385 M-1): the 1 MiB `content` plus JSON escaping and the other
 * fields; bigger bodies are refused before they are read. Pathologically escaped content (each
 * character as `\uXXXX`) is refused with the same 413.
 */
export const MEMORY_IMPORT_BODY_MAX = 2 * SEMANTIC_MEMORY_IMPORT_MAX_BYTES + 64 * 1024;
/** Imports per person (review-385 M-2): each preview or commit checks up to 1,000 rows. */
export const MEMORY_IMPORT_PREVIEW_RATE = { windowMs: 60_000, max: 20 } as const;
export const MEMORY_IMPORT_COMMIT_RATE = { windowMs: 60_000, max: 10 } as const;
/** Exports per person: each reads a whole scope. */
export const MEMORY_EXPORT_RATE = { windowMs: 60_000, max: 20 } as const;

/**
 * Semantic memory import and export (`/v1/memory/semantic/import/*`, `/export`; KOBE-385,
 * contract KOBE-377 `transfer.ts`; export is `POST /export` with the query's fields as its body,
 * review-385 L-4). The Workspace and the caller resolve as for the item routes;
 * the store decides who may (`memory/items/import.ts`, `export-items.ts`).
 */
export function memoryTransferRoutes(deps: ServerDeps): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  const db = deps.database.db;
  // Agents never import (KOBE-650): refused before the body is read.
  app.use("*", refuseAgentWrites);
  const { answer } = memoryRouteKit(deps);

  /** The body, or a refusal: over 1 MiB is `memory_import_too_large` (413), as the contract says. */
  const importBody = async <T>(c: Ctx, schema: z.ZodType<T>): Promise<T | Response> => {
    const raw: unknown = await c.req.json().catch(() => undefined);
    const content = (raw as { content?: unknown } | undefined)?.content;
    if (typeof content === "string" && utf8ByteLength(content) > SEMANTIC_MEMORY_IMPORT_MAX_BYTES)
      return c.json(
        {
          code: "memory_import_too_large",
          message: `An import file holds at most ${SEMANTIC_MEMORY_IMPORT_MAX_BYTES} bytes.`,
        },
        413,
      );
    const body = schema.safeParse(raw);
    return body.success ? body.data : invalidRequest(c, issueText(body.error));
  };

  const tooLarge = (c: Ctx) =>
    c.json(
      {
        code: "memory_import_too_large",
        message: `An import file holds at most ${SEMANTIC_MEMORY_IMPORT_MAX_BYTES} bytes.`,
      },
      413,
    );
  app.use("/import/*", bodyLimit({ maxSize: MEMORY_IMPORT_BODY_MAX, onError: tooLarge }));

  /** Counts one request against the person's limit; a refusal is the response. */
  const limited = async (c: Ctx, name: string, rule: { windowMs: number; max: number }) =>
    (await hitRateLimit(db, `${name}:${c.get("user").id}`, rule))
      ? null
      : c.json(
          {
            code: "rate_limited",
            message: "Too many imports or exports. Wait a minute and try again.",
          },
          429,
        );

  app.post("/import/preview", async (c) => {
    const refused = await limited(c, "memory-import-preview", MEMORY_IMPORT_PREVIEW_RATE);
    if (refused) return refused;
    const body = await importBody(c, semanticMemoryImportPreviewRequestSchema);
    if (body instanceof Response) return body;
    return answer(c, body.scope, (who) => previewImport(db, who, body));
  });

  app.post("/import/commit", async (c) => {
    const refused = await limited(c, "memory-import-commit", MEMORY_IMPORT_COMMIT_RATE);
    if (refused) return refused;
    const body = await importBody(c, semanticMemoryImportCommitRequestSchema);
    if (body instanceof Response) return body;
    return answer(c, body.scope, (who) => commitImport(db, who, body));
  });

  // A POST (review-385 L-4): an export writes an audit row, so it goes through the API's Origin
  // check like every other write; a cross-site link can't make a curator's browser export.
  app.post("/export", async (c) => {
    const refused = await limited(c, "memory-export", MEMORY_EXPORT_RATE);
    if (refused) return refused;
    const raw: unknown = await c.req.json().catch(() => undefined);
    const q = semanticMemoryExportQuerySchema.safeParse(raw);
    if (!q.success) return invalidRequest(c, issueText(q.error));
    return answer(c, q.data.scope, async (who) => {
      const doc = await exportItems(db, who, q.data);
      const day = doc.exported_at.slice(0, 10);
      const name = `kobe-memories-${doc.scope}-${day}.${q.data.format}`;
      const headers = {
        "content-disposition": `attachment; filename="${name}"`,
        "cache-control": "no-store",
      };
      return q.data.format === "csv"
        ? c.body(semanticMemoryExportToCsv(doc), 200, {
            ...headers,
            "content-type": "text/csv; charset=utf-8",
          })
        : c.json(doc, 200, headers);
    });
  });

  return app;
}
