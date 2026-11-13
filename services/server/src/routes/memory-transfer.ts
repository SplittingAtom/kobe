import { Hono } from "hono";
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
import { invalidRequest } from "../teams/http.js";
import { issueText, memoryRouteKit, refuseAgentWrites } from "./memory-items.js";

type Ctx = Context<{ Variables: TeamVariables }>;

/**
 * Semantic memory import and export (`/v1/memory/semantic/import/*`, `/export`; KOBE-385,
 * contract KOBE-377 `transfer.ts`). The Workspace and the caller resolve as for the item routes;
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

  app.post("/import/preview", async (c) => {
    const body = await importBody(c, semanticMemoryImportPreviewRequestSchema);
    if (body instanceof Response) return body;
    return answer(c, body.scope, (who) => previewImport(db, who, body));
  });

  app.post("/import/commit", async (c) => {
    const body = await importBody(c, semanticMemoryImportCommitRequestSchema);
    if (body instanceof Response) return body;
    return answer(c, body.scope, (who) => commitImport(db, who, body));
  });

  app.get("/export", async (c) => {
    const q = semanticMemoryExportQuerySchema.safeParse(c.req.query());
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
