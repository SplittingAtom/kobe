/**
 * Schedules over the shared API client (`/v1/schedules`, KOBE-173; contract KOBE-171). Responses
 * arrive camelized; request bodies use the routes' snake_case. Every call sends `X-Kobe-Team`.
 */
import type { ScheduleRecurrence } from "@kobe/protocol";
import { apiRequest, type ApiResult } from "../api/client";

export interface Schedule {
  readonly scheduleId: string;
  readonly teamId: string;
  readonly userId: string;
  readonly agentId: string;
  readonly prompt: string;
  readonly recurrence: ScheduleRecurrence;
  readonly tz: string;
  readonly active: boolean;
  readonly notifyEmail: boolean;
  readonly nextDueAt: string | null;
  readonly lastRunId: string | null;
  /** `team_admin`: only a team admin resumes it. `deactivation`: the owner resumes. */
  readonly pausedBy: "team_admin" | "deactivation" | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ScheduleList {
  readonly schedules: readonly Schedule[];
  /** The caller's active schedules across all teams (what the cap counts). */
  readonly activeCount: number;
}

export interface ScheduleDraft {
  readonly agentId: string;
  readonly prompt: string;
  readonly recurrence: ScheduleRecurrence;
  readonly tz: string;
}

export interface ScheduleAgent {
  readonly id: string;
  readonly name: string;
}

export interface SchedulesApi {
  list(): Promise<ApiResult<ScheduleList>>;
  create(draft: ScheduleDraft): Promise<ApiResult<Schedule>>;
  update(id: string, draft: ScheduleDraft): Promise<ApiResult<Schedule>>;
  pause(id: string): Promise<ApiResult<Schedule>>;
  resume(id: string): Promise<ApiResult<Schedule>>;
  remove(id: string): Promise<ApiResult<void>>;
  agents(): Promise<ApiResult<readonly ScheduleAgent[]>>;
}

const enc = encodeURIComponent;

export function createSchedulesApi(teamId: string, fetchFn?: typeof fetch): SchedulesApi {
  const base = { teamId, fetchFn };
  const body = (d: ScheduleDraft) => ({
    agent_id: d.agentId,
    prompt: d.prompt,
    recurrence: d.recurrence,
    tz: d.tz,
  });
  return {
    list: () => apiRequest("/v1/schedules?scope=mine", base),
    create: (d) => apiRequest("/v1/schedules", { ...base, method: "POST", json: body(d) }),
    update: (id, d) =>
      apiRequest(`/v1/schedules/${enc(id)}`, { ...base, method: "PATCH", json: body(d) }),
    pause: (id) => apiRequest(`/v1/schedules/${enc(id)}/pause`, { ...base, method: "POST" }),
    resume: (id) => apiRequest(`/v1/schedules/${enc(id)}/resume`, { ...base, method: "POST" }),
    remove: (id) => apiRequest(`/v1/schedules/${enc(id)}`, { ...base, method: "DELETE" }),
    agents: async () => {
      const res = await apiRequest<{ agents: ScheduleAgent[] }>(
        "/v1/agents/runnable?limit=200",
        base,
      );
      return res.ok ? { ...res, data: res.data.agents } : res;
    },
  };
}
