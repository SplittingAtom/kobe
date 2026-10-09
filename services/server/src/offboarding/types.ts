import type { AuditActor, KobeDb } from "@kobe/db";
import type { Logger } from "pino";
import type { BlobStore } from "../retention/blobs.js";
import type { SandboxProvider } from "../sandbox/provider.js";

/** D12: a departed member's volume (and workspace copy) is kept this long, then deleted. */
export const RETAIN_DAYS = 30;

export type OffboardTrigger = "member_removed" | "deactivated" | "team_removed" | "reconciled";

export type OffboardProvider = Pick<SandboxProvider, "destroySandbox" | "deleteVolume">;

export interface OffboardingContext {
  readonly db: KobeDb;
  /** The sandbox provider, once it exists (index.ts builds it after the server deps). */
  readonly provider: () => OffboardProvider | undefined;
  /** Object storage of the workspace copy; undefined when `s3.*` is not configured. */
  readonly blobs: BlobStore | undefined;
  readonly log: Pick<Logger, "info" | "warn" | "error">;
  /** Who is recorded as the actor when no signed-in request is running (the sweep). */
  readonly actor?: () => AuditActor | undefined;
}

export interface TeamIdentity {
  readonly id: string;
  readonly slug: string;
}

/** The (team, user) whose sandbox and volume an operation concerns. */
export interface Departed {
  readonly teamId: string;
  readonly userId: string;
}
