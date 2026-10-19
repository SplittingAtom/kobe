import type {
  EvalPrepareFrame,
  EvalReadFrame,
  EvalReadResult,
  EvalSnapshotFrame,
  EvalWorkspaceSnapshot,
} from "@kobe/protocol";
import { createFixtureFetcher, prepareFixtures, type FixtureFetcher } from "./fixtures.js";
import { readOutputs } from "./read.js";
import { snapshotWorkspace } from "./snapshot.js";

/** What the agent does for a skill eval's commands (KOBE-325; `read` KOBE-326). */
export interface SkillEvalHooks {
  prepare(frame: EvalPrepareFrame): Promise<void>;
  snapshot(frame: EvalSnapshotFrame): Promise<EvalWorkspaceSnapshot>;
  read(frame: EvalReadFrame): Promise<EvalReadResult>;
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
    read: (frame) => readOutputs(options.workspaceDir, frame),
  };
}
