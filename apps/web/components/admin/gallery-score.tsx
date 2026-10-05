"use client";

import type { GalleryScore } from "../../lib/admin/api/agents";
import { percent } from "../../lib/admin/orbit-score";
import { DateTime } from "./parts";
import type { ResourceState } from "./use-resource";
import styles from "./admin.module.css";

/** A gallery agent's published Orbit score and its date (KOBE-94); "Not evaluated" without one. */
export function GalleryScoreCell({
  agentId,
  state,
}: {
  readonly agentId: string;
  readonly state: ResourceState<readonly GalleryScore[]>;
}) {
  if (state.status === "loading") return <>…</>;
  if (state.status === "error") return <>—</>;
  const score = state.data.find((s) => s.agentId === agentId);
  if (!score) return <>Not evaluated</>;
  return (
    <>
      {`${percent(score.attackSuccessRate)} attacks succeeded (${score.status})`}
      <div className={styles.hint}>
        v{score.version}, <DateTime value={score.evaluatedAt} />
      </div>
    </>
  );
}
