import { Hono, type Context } from "hono";
import { z } from "zod";
import { withTeam } from "@kobe/db";
import type { TeamVariables } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import {
  candidateIdsSchema,
  dismissCandidate,
  saveAllMine,
  saveCandidate,
  saveCandidateSchema,
  undoSaves,
} from "../memory/review/decide.js";
import { workspaceOf } from "../memory/review/ids.js";
import { listReview } from "../memory/review/list.js";
import { markReviewSeen } from "../memory/review/notify.js";
import {
  addToProjectNotes,
  notesAddSchema,
  notesPreviewSchema,
  previewProjectNotes,
  projectNotesStatus,
  type NotesDeps,
} from "../memory/review/project-notes.js";
import { MemoryStorageError } from "../memory/store.js";
import { suggestSchema, suggestToEditors } from "../memory/suggestions/suggest.js";
import { logger } from "../logger.js";
import { proposeCandidate, proposeSchema } from "../memory/proposals/propose.js";
import { uuidSchema } from "../threads/schemas.js";
import { issueText, memoryRouteKit, refuseAgentWrites } from "./memory-items.js";
import { invalidRequest } from "../http/request.js";

const threadQuery = z.object({ thread_id: uuidSchema });

/**
 * To review (`/v1/memory/review`, KOBE-396, SM16): a thread author's learning candidates and
 * their decisions. Runs in the active Workspace (`user` scope rules of the memory route kit);
 * every decision is re-checked on the server (memory/review/decide.ts). Agents never decide.
 *
 * - `GET  /?thread_id=` the open candidates of the caller's thread
 * - `POST /candidates/:id/save` `{statement?, kind?, scope?, confirm_portable?, overrides?}`
 * - `POST /candidates/:id/dismiss`
 * - `POST /candidates/:id/propose` `{statement?, kind?, rationale?}`: to the Workspace's curators
 *   (KOBE-397; members who don't curate)
 * - `POST /save-all` `{candidate_ids}`: Save all mine, one batch
 * - `POST /undo` `{candidate_ids}`: Undo of a save or a batch
 * - `POST /seen` `{thread_id}`: the panel showed the thread's candidates (bell notices read)
 * - `POST /candidates/:id/project-notes/preview` `{statement?}`: the exact Notes change, signed
 * - `POST /candidates/:id/project-notes` `{statement?, base_version, approval}`: Add to project
 *   notes (KOBE-398; the list's `project_notes` says whether the caller may)
 * - `POST /candidates/:id/suggest` `{statement?, kind?}`: Suggest to editors, a project reader's
 *   suggestion for the project's notes (KOBE-652; decided under `/v1/memory/suggestions`)
 */
export function memoryReviewRoutes(deps: ServerDeps): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  const db = deps.database.db;
  app.use("*", refuseAgentWrites);
  const { answer, readBody } = memoryRouteKit(deps);
  const candidateId = (raw: string | undefined) => uuidSchema.safeParse(raw);
  // Read per request: building the app must not touch blobs or keys (threads.db.test.ts ac-2).
  const notes = (): NotesDeps => ({ db, blobs: deps.blobs, keys: deps.approvalKeys });
  /** Notes storage failures are 503, as on the Notes routes. */
  const storage = async <T>(c: Context, fn: () => Promise<T>): Promise<T | Response> => {
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof MemoryStorageError)) throw err;
      logger.error({ err }, "project notes storage failed");
      return c.json(
        { code: "storage_unavailable", message: "Memory storage is unavailable." },
        503,
      );
    }
  };

  app.get("/", async (c) => {
    const q = threadQuery.safeParse(c.req.query());
    if (!q.success) return invalidRequest(c, "thread_id must be a conversation id.");
    return answer(c, "user", async (who) => {
      const list = await listReview(db, who, q.data.thread_id);
      const status = await storage(c, () => projectNotesStatus(notes(), who, q.data.thread_id));
      return { ...list, project_notes: status instanceof Response ? null : status };
    });
  });

  app.post("/candidates/:id/project-notes/preview", async (c) => {
    const id = candidateId(c.req.param("id"));
    if (!id.success) return invalidRequest(c, "id must be a candidate id.");
    const body = await readBody(c, notesPreviewSchema, true);
    if (!body.success) return invalidRequest(c, issueText(body.error));
    return answer(c, "user", (who) =>
      storage(c, () => previewProjectNotes(notes(), who, id.data, body.data)),
    );
  });

  app.post("/candidates/:id/project-notes", async (c) => {
    const id = candidateId(c.req.param("id"));
    if (!id.success) return invalidRequest(c, "id must be a candidate id.");
    const body = await readBody(c, notesAddSchema);
    if (!body.success) return invalidRequest(c, issueText(body.error));
    return answer(c, "user", (who) =>
      storage(c, () => addToProjectNotes(notes(), who, id.data, body.data)),
    );
  });

  app.post("/candidates/:id/suggest", async (c) => {
    const id = candidateId(c.req.param("id"));
    if (!id.success) return invalidRequest(c, "id must be a candidate id.");
    const body = await readBody(c, suggestSchema, true);
    if (!body.success) return invalidRequest(c, issueText(body.error));
    return answer(c, "user", (who) => suggestToEditors(db, who, id.data, body.data));
  });

  app.post("/candidates/:id/save", async (c) => {
    const id = candidateId(c.req.param("id"));
    if (!id.success) return invalidRequest(c, "id must be a candidate id.");
    const body = await readBody(c, saveCandidateSchema, true);
    if (!body.success) return invalidRequest(c, issueText(body.error));
    return answer(c, "user", (who) => saveCandidate(db, who, id.data, body.data));
  });

  app.post("/candidates/:id/dismiss", async (c) => {
    const id = candidateId(c.req.param("id"));
    if (!id.success) return invalidRequest(c, "id must be a candidate id.");
    return answer(c, "user", (who) => dismissCandidate(db, who, id.data));
  });

  app.post("/candidates/:id/propose", async (c) => {
    const id = candidateId(c.req.param("id"));
    if (!id.success) return invalidRequest(c, "id must be a candidate id.");
    const body = await readBody(c, proposeSchema, true);
    if (!body.success) return invalidRequest(c, issueText(body.error));
    return answer(c, "user", (who) => proposeCandidate(db, who, id.data, body.data), 201);
  });

  app.post("/save-all", async (c) => {
    const body = await readBody(c, candidateIdsSchema);
    if (!body.success) return invalidRequest(c, issueText(body.error));
    return answer(c, "user", (who) => saveAllMine(db, who, body.data.candidate_ids));
  });

  app.post("/undo", async (c) => {
    const body = await readBody(c, candidateIdsSchema);
    if (!body.success) return invalidRequest(c, issueText(body.error));
    return answer(c, "user", (who) => undoSaves(db, who, body.data.candidate_ids));
  });

  app.post("/seen", async (c) => {
    const body = await readBody(c, threadQuery.strict());
    if (!body.success) return invalidRequest(c, "thread_id must be a conversation id.");
    return answer(c, "user", async (who) => {
      const teamId = workspaceOf(who);
      const read = await withTeam(db, teamId, (tx) =>
        markReviewSeen(tx, { teamId, userId: who.userId, threadId: body.data.thread_id }),
      );
      return { read };
    });
  });

  return app;
}
