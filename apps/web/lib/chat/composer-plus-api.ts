import { apiRequest, type ApiResult } from "../api/client";

/**
 * The composer's + menu (KOBE-451): the member's connectors with this conversation's on/off and
 * the skills a run here loads, as the server decides them. A conversation not started yet has no
 * thread: its lists come from the team-level reads (connectors all on; skills of the picked agent).
 */
export interface ChatConnectorProblem {
  readonly code: string;
  readonly message: string;
  readonly fix: { readonly href: string; readonly label: string } | null;
}

export interface ChatConnector {
  readonly connectorId: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly problem: ChatConnectorProblem | null;
}

const enc = encodeURIComponent;

export function listChatConnectors(
  teamId: string,
  threadId: string | null,
): Promise<ApiResult<{ readonly connectors: readonly ChatConnector[] }>> {
  const path =
    threadId === null ? "/v1/threads/connectors" : `/v1/threads/${enc(threadId)}/connectors`;
  return apiRequest(path, { teamId });
}

export function setThreadConnector(
  teamId: string,
  threadId: string,
  connectorId: string,
  enabled: boolean,
): Promise<ApiResult<{ readonly connector: ChatConnector }>> {
  return apiRequest(`/v1/threads/${enc(threadId)}/connectors/${enc(connectorId)}`, {
    method: "PUT",
    json: { enabled },
    teamId,
  });
}

export function listChatSkills(
  teamId: string,
  at: { readonly threadId: string } | { readonly agentId: string | null },
): Promise<ApiResult<{ readonly skills: readonly { readonly name: string }[] }>> {
  const path =
    "threadId" in at
      ? `/v1/threads/${enc(at.threadId)}/skills`
      : `/v1/threads/skills${at.agentId === null ? "" : `?agent_id=${enc(at.agentId)}`}`;
  return apiRequest(path, { teamId });
}
