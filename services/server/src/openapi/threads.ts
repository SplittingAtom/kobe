import {
  fileThreadRequestSchema,
  forkThreadRequestSchema,
  shareThreadRequestSchema,
  threadLineageResponseSchema,
} from "@kobe/protocol";
import { z } from "zod";
import {
  createThreadBodySchema,
  createdThreadSchema,
  entriesQuerySchema,
  toolOutputSchema,
  entryPageSchema,
  errorSchema,
  listThreadsQuerySchema,
  moveThreadBodySchema,
  pinnedQuerySchema,
  setLeafBodySchema,
  switchAgentVersionBodySchema,
  chooseThreadAgentBodySchema,
  threadCardSchema,
  threadDetailSchema,
  threadActivityListSchema,
  threadPageSchema,
  threadSearchPageSchema,
  threadSummarySchema,
  trashQuerySchema,
  clearTestThreadsQuerySchema,
  updateThreadBodySchema,
} from "../threads/schemas.js";

/**
 * OpenAPI 3.1 description of the Thread API (spec §6.1, KOBE-34), generated from the zod schemas
 * the routes validate with, so the document cannot drift from the code (`openapi.test.ts` also
 * checks that every mounted route is described).
 */

type JsonSchema = Record<string, unknown>;

const input = (schema: z.ZodType): JsonSchema =>
  z.toJSONSchema(schema, { io: "input", target: "draft-2020-12" }) as JsonSchema;
const output = (schema: z.ZodType): JsonSchema =>
  z.toJSONSchema(schema, { io: "output", target: "draft-2020-12" }) as JsonSchema;

const withoutDialect = ({ $schema: _ignored, ...rest }: JsonSchema): JsonSchema => rest;

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

const json = (schemaName: string, description: string) => ({
  description,
  content: { "application/json": { schema: ref(schemaName) } },
});

const ERROR_RESPONSES = {
  "400": json("Error", "`invalid_request`, `invalid_cursor` or `team_header_required`."),
  "401": json("Error", "`unauthenticated`: no session."),
  "403": json("Error", "`not_a_team_member`, `forbidden` (team role) or `read_only`."),
  "409": json("Error", "`no_active_team` or `team_mismatch` (stale tab), or a thread conflict."),
} as const;

const notFound = json("Error", "`thread_not_found`: unknown id, another team's or user's thread.");

/** Query parameters from a strict zod object (each optional, string-typed on the wire). */
function queryParameters(schema: z.ZodObject): readonly JsonSchema[] {
  const shape = (input(schema).properties ?? {}) as Record<string, JsonSchema>;
  return Object.entries(shape).map(([name, s]) => ({
    name,
    in: "query",
    required: false,
    schema: s,
  }));
}

const idParameter = {
  name: "id",
  in: "path",
  required: true,
  schema: { type: "string", format: "uuid" },
} as const;

const teamHeader = {
  name: "X-Kobe-Team",
  in: "header",
  required: false,
  description: "The team the client believes is active. Required on changes; must match.",
  schema: { type: "string", format: "uuid" },
} as const;

const change = (parameters: readonly object[] = []) => [
  ...parameters,
  { ...teamHeader, required: true },
];

const body = (schemaName: string) => ({
  required: true,
  content: { "application/json": { schema: ref(schemaName) } },
});

export function threadsOpenApiPaths(): Record<string, Record<string, unknown>> {
  return {
    "/v1/threads": {
      get: {
        operationId: "listThreads",
        summary: "List the viewer's threads (or a project's readable threads), newest first",
        description:
          "Keyset pagination on (last_activity_at, id). Never Trash. Without `project_id`, " +
          "pinned and archived threads are left out (`/v1/threads/pinned`, `/archived`, CE19). " +
          "With `folder` (KOBE-534; not with `q` or `project_id`): a folder's live, unarchived " +
          "threads the caller may read (own, or shared with them; the caller's pinned ones are " +
          "in `/pinned?folder=`), or with `none` the caller's own unfiled threads. " +
          "With `q`, full-text search " +
          '(KOBE-33): web-search syntax (`"phrase"`, `-exclude`, `or`) over user/assistant ' +
          "messages (all terms in one message) and titles (plus fuzzy title matching), ranked by " +
          "relevance with snippets; `cursor` is then a search cursor and `limit` is capped at 50. " +
          "Reads Postgres only (never wakes a sandbox).",
        parameters: [...queryParameters(listThreadsQuerySchema), teamHeader],
        responses: {
          "200": {
            description: "A page of threads (`ThreadSearchPage` when `q` is given).",
            content: {
              "application/json": {
                schema: { oneOf: [ref("ThreadPage"), ref("ThreadSearchPage")] },
              },
            },
          },
          ...ERROR_RESPONSES,
          "400": json(
            "Error",
            "`invalid_request`, `invalid_cursor`, `invalid_query` (only excluded terms) or " +
              "`team_header_required`.",
          ),
          "503": json("Error", "`search_timeout`: the search exceeded its time limit."),
        },
      },
      post: {
        operationId: "createThread",
        summary: "Create a thread in the active team, owned by the caller",
        parameters: change(),
        requestBody: body("CreateThreadBody"),
        description:
          "With `agent_id`, the thread pins the agent's current published version (D19). " +
          "Suspended, archived and never-published agents answer 409 `agent_unavailable`. " +
          "With `test: true` (needs `agent_id`, no project) it is a builder test thread " +
          "(KOBE-85): it runs the agent's unpublished draft, needs the right to edit the agent " +
          "(else 404 `agent_not_found`), and stays out of lists, search and Trash.",
        responses: {
          "201": json("Thread", "The new thread."),
          "404": json("Error", "`agent_not_found` or `project_not_found`."),
          ...ERROR_RESPONSES,
          "409": json(
            "Error",
            "`agent_unavailable`, `no_active_team` or `team_mismatch` (stale tab).",
          ),
        },
      },
    },
    "/v1/threads/test": {
      delete: {
        operationId: "clearTestThreads",
        summary: "Clear the caller's builder test threads (KOBE-85), all or one agent's",
        description:
          "Moves them to Trash (hidden from every list); threads with an active or queued run " +
          "are skipped. Their runs and usage stay for budgets.",
        parameters: [...queryParameters(clearTestThreadsQuerySchema), teamHeader],
        responses: {
          "200": {
            description: "How many test threads were cleared.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["cleared"],
                  properties: { cleared: { type: "integer", minimum: 0 } },
                },
              },
            },
          },
          ...ERROR_RESPONSES,
        },
      },
    },
    "/v1/threads/trash": {
      get: {
        operationId: "listTrash",
        summary: "The viewer's Trash, most recently deleted first (restorable for 30 days)",
        parameters: [...queryParameters(trashQuerySchema), teamHeader],
        responses: { "200": json("ThreadPage", "A page of trashed threads."), ...ERROR_RESPONSES },
      },
    },
    "/v1/threads/pinned": {
      get: {
        operationId: "listPinnedThreads",
        summary: "The viewer's pinned threads, most recently pinned first (CE19)",
        description:
          "With `folder` (KOBE-534): only those in that folder, or with `none` the unfiled ones.",
        parameters: [...queryParameters(pinnedQuerySchema), teamHeader],
        responses: { "200": json("ThreadPage", "A page of pinned threads."), ...ERROR_RESPONSES },
      },
    },
    "/v1/threads/archived": {
      get: {
        operationId: "listArchivedThreads",
        summary: "The viewer's archived threads, most recently archived first (CE19)",
        description: "Archived threads stay searchable and follow the same retention.",
        parameters: [...queryParameters(trashQuerySchema), teamHeader],
        responses: { "200": json("ThreadPage", "A page of archived threads."), ...ERROR_RESPONSES },
      },
    },
    "/v1/threads/activity": {
      get: {
        operationId: "listThreadActivity",
        summary: "The caller's own threads with a run going or an approval waiting (KOBE-301)",
        description:
          "Polled by the rail's dots and the tab title: live, non-test threads the caller owns " +
          "whose run is active; `approval` when an approval only they can decide waits there. " +
          "Threads not listed are idle. At most 200.",
        parameters: [teamHeader],
        responses: {
          "200": json("ThreadActivityList", "The caller's active threads."),
          ...ERROR_RESPONSES,
        },
      },
    },
    "/v1/threads/shared": {
      get: {
        operationId: "listSharedThreads",
        summary: "Threads others shared with the viewer, most recent activity first (CE20)",
        description:
          "Shared with the team, or to a project the viewer belongs to; read-only (`read_only`, " +
          "`owner_name`). Never Trash or test threads. Team admins see only what is shared with them.",
        parameters: [...queryParameters(trashQuerySchema), teamHeader],
        responses: { "200": json("ThreadPage", "A page of shared threads."), ...ERROR_RESPONSES },
      },
    },
    "/v1/threads/{id}": {
      get: {
        operationId: "getThread",
        summary: "A thread with its entry tree (append order), leaf, agent version and status",
        description:
          "Readable by its owner, or by project members when shared. Never wakes a sandbox.",
        parameters: [idParameter, ...queryParameters(entriesQuerySchema), teamHeader],
        responses: {
          "200": json("ThreadDetail", "The thread and the first page of entries."),
          "404": notFound,
          ...ERROR_RESPONSES,
        },
      },
      patch: {
        operationId: "updateThread",
        summary: "Rename, or share to / unshare from its project (owner only)",
        parameters: change([idParameter]),
        requestBody: body("UpdateThreadBody"),
        responses: {
          "200": json("Thread", "The updated thread."),
          "404": notFound,
          ...ERROR_RESPONSES,
        },
      },
      delete: {
        operationId: "trashThread",
        summary: "Move to Trash (30-day soft delete; owner only; idempotent)",
        parameters: change([idParameter]),
        responses: {
          "200": json("Thread", "The trashed thread."),
          "404": notFound,
          ...ERROR_RESPONSES,
        },
      },
    },
    "/v1/threads/{id}/card": {
      get: {
        operationId: "getThreadCard",
        summary: "The rail's hover card: first message, agent, last activity, message count",
        description:
          "CE18 (KOBE-219): read when the card opens. The first user message is cut to 280 " +
          "characters; the count holds the member's messages and the agent's answers on every " +
          "branch (turns that only called tools are not counted). Readable by whoever may read " +
          "the thread. Never wakes a sandbox.",
        parameters: [idParameter, teamHeader],
        responses: {
          "200": json("ThreadCard", "The thread's card."),
          "404": notFound,
          ...ERROR_RESPONSES,
        },
      },
    },
    "/v1/threads/{id}/lineage": {
      get: {
        operationId: "getThreadLineage",
        summary: "The thread's family: readable ancestors root first, siblings and forks",
        description:
          "TL1, TL2 (KOBE-533): walks `forked_from_thread_id` up at most 20 generations; each " +
          "sibling or fork list holds at most 50, newest activity first, with `siblings_more` / " +
          "`forks_more` when cut. Only threads the viewer may read are named: a chain reaching " +
          "one they cannot read stops with `root_hidden: true`; a purged ancestor is simply " +
          "absent. The viewer's own threads in Trash carry `deleted_at`. Never wakes a sandbox.",
        parameters: [idParameter, teamHeader],
        responses: {
          "200": json("ThreadLineage", "The thread's lineage."),
          "404": notFound,
          ...ERROR_RESPONSES,
        },
      },
    },
    "/v1/threads/{id}/entries": {
      get: {
        operationId: "listThreadEntries",
        summary: "More entries of a thread, by seq",
        parameters: [idParameter, ...queryParameters(entriesQuerySchema), teamHeader],
        responses: {
          "200": json("EntryPage", "A page of entries."),
          "404": notFound,
          ...ERROR_RESPONSES,
        },
      },
    },
    "/v1/threads/{id}/entries/{entryId}/output": {
      get: {
        operationId: "getToolOutput",
        summary: "A tool result's full output",
        description:
          "KOBE-208: the entry list cuts a tool output over 64 KB to a preview " +
          "(`payload_truncated`); the chat reads the full one here when its card opens. Readable " +
          "by whoever may read the thread. An offloaded body (D15) is read only from the " +
          "thread's own object tree, up to 8 MB; the text is capped at 1,000,000 characters.",
        parameters: [
          idParameter,
          {
            name: "entryId",
            in: "path",
            required: true,
            schema: { type: "string", minLength: 1, maxLength: 128 },
          },
          teamHeader,
        ],
        responses: {
          "200": json("ToolOutput", "The output's text and whether the tool failed."),
          "404": json("Error", "`thread_not_found` or `entry_not_found`."),
          ...ERROR_RESPONSES,
          "409": json(
            "Error",
            "`not_a_tool_output`, or `entry_unavailable`: the stored body can't be read back.",
          ),
          "503": json(
            "Error",
            "`output_busy`: too many stored outputs are being read, or the store did not answer " +
              "in time. Try again.",
          ),
        },
      },
    },
    "/v1/threads/{id}/leaf": {
      post: {
        operationId: "setThreadLeaf",
        summary: "Switch the active branch to an entry of the thread (owner only)",
        parameters: change([idParameter]),
        requestBody: body("SetLeafBody"),
        responses: {
          "200": json("Thread", "The thread with its new leaf."),
          "404": json("Error", "`thread_not_found` or `entry_not_found`."),
          ...ERROR_RESPONSES,
        },
      },
    },
    "/v1/threads/{id}/agent-version": {
      post: {
        operationId: "switchThreadAgentVersion",
        summary: "Pin another published version of the thread's agent (owner only)",
        description:
          'D19 one-click switch ("v3 available"): without `version`, the agent\'s current ' +
          "version. Refused while a run is active (`thread_busy`).",
        parameters: change([idParameter]),
        requestBody: body("SwitchAgentVersionBody"),
        responses: {
          "200": json("Thread", "The thread with its new pin."),
          "404": json("Error", "`thread_not_found`, `agent_not_found` or `version_not_found`."),
          ...ERROR_RESPONSES,
          "409": json(
            "Error",
            "`no_agent`, `agent_unavailable`, `thread_busy`, `thread_in_trash`, or a team conflict.",
          ),
        },
      },
    },
    "/v1/threads/{id}/agent": {
      post: {
        operationId: "chooseThreadAgent",
        summary: "Give an agentless thread an agent (owner only)",
        description:
          "KOBE-458: the agent's current published version, checked as at creation. Only a " +
          "plain thread with no agent (`agent_already_chosen` otherwise); refused while a run " +
          "is queued or active (`thread_busy`). Audited (`thread.agent_chosen`).",
        parameters: change([idParameter]),
        requestBody: body("ChooseThreadAgentBody"),
        responses: {
          "200": json("Thread", "The thread with its new pin."),
          "404": json("Error", "`thread_not_found` or `agent_not_found`."),
          ...ERROR_RESPONSES,
          "409": json(
            "Error",
            "`agent_already_chosen`, `agent_unavailable`, `thread_busy`, `thread_in_trash`, " +
              "`thread_archived`, `test_thread`, `scheduled_thread`, or a team conflict.",
          ),
        },
      },
    },
    "/v1/threads/{id}/share": {
      post: {
        operationId: "shareThread",
        summary: "Set who can read the thread: `private`, `project` or `team` (author only)",
        description:
          "Readers read and fork, nothing more. `private` revokes at once, open event streams " +
          "included. Both sharing and revoking are audited (`thread.sharing_changed`).",
        parameters: change([idParameter]),
        requestBody: body("ShareThreadBody"),
        responses: {
          "200": json("Thread", "The updated thread."),
          "404": notFound,
          ...ERROR_RESPONSES,
          "409": json(
            "Error",
            "`not_in_project`, `test_thread`, `thread_busy` or `thread_in_trash`.",
          ),
        },
      },
    },
    "/v1/threads/{id}/fork": {
      post: {
        operationId: "forkThread",
        summary:
          "Copy a readable thread (own, or shared to your project) into a new private thread",
        description:
          "Copies the entries from the root up to `entry_id` (default: the leaf). Workspace files are not copied.",
        parameters: change([idParameter]),
        requestBody: body("ForkThreadBody"),
        responses: {
          "201": json("CreatedThread", "The new thread."),
          "404": notFound,
          ...ERROR_RESPONSES,
          "409": json(
            "Error",
            "`thread_in_trash`, or `entry_offloaded` (an offloaded body that cannot be copied: no object storage, or not in the source thread's tree).",
          ),
        },
      },
    },
    ...organizeOperations(),
    "/v1/threads/{id}/move": {
      post: {
        operationId: "moveThread",
        summary: "Move the thread to a project, or out of one (owner only, CE19)",
        description:
          "Allowed where the caller may start a thread in the project. Refused while a run is queued or running. A thread shared to its old project becomes private. The project's context applies from the next run, which is marked (`GET /v1/threads/{id}/markers`).",
        parameters: change([idParameter]),
        requestBody: body("MoveThreadBody"),
        responses: {
          "200": json("Thread", "The moved thread."),
          "404": json("Error", "`thread_not_found`, or `project_not_found` (also: not allowed)."),
          ...ERROR_RESPONSES,
          "409": json("Error", "`thread_busy`, `thread_in_trash` or `test_thread`."),
        },
      },
    },
    "/v1/threads/{id}/file": {
      post: {
        operationId: "fileThread",
        summary: "File the thread in a team folder, or take it out of one (KOBE-534, TF3)",
        description:
          "The owner or a member who may read the thread (shared to their project or the team). " +
          "Idempotent; keeps pin, archive, project and shares; never activity. Audited " +
          "`thread.filed` on a change.",
        parameters: change([idParameter]),
        requestBody: body("FileThreadBody"),
        responses: {
          "200": json("Thread", "The thread."),
          "404": json("Error", "`thread_not_found`, or `folder_not_found` (not in this team)."),
          ...ERROR_RESPONSES,
          "409": json("Error", "`thread_in_trash`, `test_thread` or `thread_busy`."),
        },
      },
    },
    "/v1/threads/{id}/restore": {
      post: {
        operationId: "restoreThread",
        summary: "Restore from Trash within 30 days (owner only)",
        parameters: change([idParameter]),
        responses: {
          "200": json("Thread", "The restored thread."),
          "404": notFound,
          ...ERROR_RESPONSES,
        },
      },
    },
  };
}

const ORGANIZE = {
  pin: ["pinThread", "Pin the thread (the Pinned group, by pin time; owner only, CE19)"],
  unpin: ["unpinThread", "Unpin the thread (owner only, CE19)"],
  archive: ["archiveThread", "Archive the thread: out of the normal groups, unpinned (CE19)"],
  unarchive: ["unarchiveThread", "Unarchive the thread (owner only, CE19)"],
} as const;

/** Pin, unpin, archive, unarchive: idempotent, no body. */
function organizeOperations() {
  return Object.fromEntries(
    Object.entries(ORGANIZE).map(([action, [operationId, summary]]) => [
      `/v1/threads/{id}/${action}`,
      {
        post: {
          operationId,
          summary,
          parameters: change([idParameter]),
          responses: {
            "200": json("Thread", "The thread."),
            "404": notFound,
            ...ERROR_RESPONSES,
            "409": json("Error", "`thread_in_trash`, `thread_archived` (pin) or `test_thread`."),
          },
        },
      },
    ]),
  );
}

export function threadsOpenApiSchemas(): Record<string, JsonSchema> {
  return {
    Error: withoutDialect(output(errorSchema)),
    Thread: withoutDialect(output(threadSummarySchema)),
    ThreadPage: withoutDialect(output(threadPageSchema)),
    ThreadActivityList: withoutDialect(output(threadActivityListSchema)),
    ThreadSearchPage: withoutDialect(output(threadSearchPageSchema)),
    ThreadDetail: withoutDialect(output(threadDetailSchema)),
    ThreadCard: withoutDialect(output(threadCardSchema)),
    ThreadLineage: withoutDialect(output(threadLineageResponseSchema)),
    EntryPage: withoutDialect(output(entryPageSchema)),
    ToolOutput: withoutDialect(output(toolOutputSchema)),
    CreateThreadBody: withoutDialect(input(createThreadBodySchema)),
    UpdateThreadBody: withoutDialect(input(updateThreadBodySchema)),
    ShareThreadBody: withoutDialect(input(shareThreadRequestSchema)),
    ForkThreadBody: withoutDialect(input(forkThreadRequestSchema)),
    SetLeafBody: withoutDialect(input(setLeafBodySchema)),
    MoveThreadBody: withoutDialect(input(moveThreadBodySchema)),
    FileThreadBody: withoutDialect(input(fileThreadRequestSchema)),
    SwitchAgentVersionBody: withoutDialect(input(switchAgentVersionBodySchema)),
    ChooseThreadAgentBody: withoutDialect(input(chooseThreadAgentBodySchema)),
    CreatedThread: withoutDialect(output(createdThreadSchema)),
  };
}
