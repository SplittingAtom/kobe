/**
 * Site console › Settings › Memory (`/v1/memory/settings?level=site`; site.settings.manage;
 * KOBE-155, widened by KOBE-381): the Site memory switches and the Site memory settings.
 */
import { apiRequest, type ApiResult } from "../../../api/client";
import { snakeBody, type MemorySwitches } from "../team/memory";

export interface SiteMemorySettingsDoc {
  readonly learningModelAlias: string | null;
  /** Phase D: used only once vectors are earned. */
  readonly embeddingModelAlias: string | null;
  /** 4 to 16 KiB. */
  readonly contextBudgetKib: number;
  readonly scopeLimits: {
    readonly user: number;
    readonly portable: number;
    readonly team: number;
    readonly site: number;
  };
  readonly versionCap: number;
  readonly staleAfterDays: number;
  readonly rateLimits: { readonly learnPassesPerHour: number; readonly savesPerMinute: number };
  readonly retentionDays: number;
}

export interface SiteMemorySettings extends MemorySwitches {
  readonly memoriesEnabled: boolean;
  readonly portableEnabled: boolean;
  readonly learnEnabled: boolean;
  readonly siteProposalsEnabled: boolean;
  readonly settings: SiteMemorySettingsDoc;
  /**
   * Model settings whose stored alias is no longer in the catalog. The server sends setting
   * names (`learning_model_alias`); `camelizeKeys` leaves string values alone, so they are mapped
   * here by the form. Absent from an older server.
   */
  readonly removedModels?: readonly string[];
}

export type SiteMemoryChange = Partial<Omit<SiteMemorySettings, "settings" | "removedModels">> & {
  readonly settings?: Partial<SiteMemorySettingsDoc>;
};

const nested = (o: object): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(snakeBody(o)).map(([k, v]) => [
      k,
      v !== null && typeof v === "object" ? snakeBody(v) : v,
    ]),
  );

export const getSiteMemory = (): Promise<ApiResult<SiteMemorySettings>> =>
  apiRequest("/v1/memory/settings?level=site");

export const putSiteMemory = (change: SiteMemoryChange): Promise<ApiResult<SiteMemorySettings>> => {
  const { settings, ...switches } = change;
  return apiRequest("/v1/memory/settings?level=site", {
    method: "PUT",
    json: { ...snakeBody(switches), ...(settings ? { settings: nested(settings) } : {}) },
  });
};
