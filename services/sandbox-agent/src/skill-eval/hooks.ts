import type { EvalPrepareFrame, EvalSnapshotFrame, EvalWorkspaceSnapshot } from "@kobe/protocol";
import { createFixtureFetcher, prepareFixtures, type FixtureFetcher } from "./fixtures.js";
import { snapshotWorkspace } from "./snapshot.js";

/** What the agent does for a skill eval's commands (KOBE-325). */
export interface SkillEvalHooks {
  prepare(frame: EvalPrepareFrame): Promise<void>;
  snapshot(frame: EvalSnapshotFrame): Promise<EvalWorkspaceSnapshot>;
}

export function createSkillEvalHooks(options: {
  readonly workspaceDir: string;
  readonly serverUrl: string;
  readonly readToken: () => Promise<string>;
  readonly fetchFixture?: FixtureFetcher;
}): SkillEvalHooks {
  const fetchFixture =
    options.fetchFixture ??
    createFixtureFetcher({ serverUrl: options.serverUrl, readToken: options.readToken });
  return {
    prepare: (frame) => prepareFixtures(options.workspaceDir, frame, fetchFixture),
    snapshot: (frame) => snapshotWorkspace(options.workspaceDir, frame.roots, frame.hash_paths),
  };
}
