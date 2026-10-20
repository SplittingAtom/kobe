"use client";

import { useState } from "react";
import {
  getSkillInstallDiff,
  getSkillInstallUpdates,
  moveSkillInstallPin,
  rollbackSkillInstall,
  type CatalogInstall,
  type SkillInstallUpdate,
  type SkillInstallUpdates,
  type SkillInstallResult,
} from "../../../../lib/admin/api/team/skill-installs";
import type { VersionDiff } from "../../../../lib/admin/api/site/skill-review";
import type { ApiResult } from "../../../../lib/api/client";
import { Badge, Button, Notice } from "../../../ui/console";
import { ReviewDiff } from "../../site/skill-review-diff";
import { skillInstallNotice } from "./skill-install-change";

const points = (v: number | null) =>
  v === null ? "—" : `${v >= 0 ? "+" : ""}${Math.round(v * 100)} points`;

function Update({
  teamId,
  install,
  update,
  mayMove,
  pending,
  onMove,
}: {
  readonly teamId: string;
  readonly install: CatalogInstall;
  readonly update: SkillInstallUpdate;
  readonly mayMove: boolean;
  readonly pending: boolean;
  readonly onMove: (version: string) => void;
}) {
  const [diff, setDiff] = useState<VersionDiff | string | null>(null);
  const loadDiff = async () => {
    const r = await getSkillInstallDiff(teamId, install.skillId, update.semver);
    setDiff(r.ok ? r.data : r.error.message);
  };
  return (
    <li className="mt-2">
      <strong>{update.semver}</strong> {update.major && <Badge tone="attention">major</Badge>}{" "}
      {update.deprecated && <Badge tone="attention">deprecated</Badge>}{" "}
      <span className="text-console-muted">
        {update.automatic
          ? "the pin takes it by itself"
          : update.major && install.pinMode === "within_major"
            ? "Track within major never takes a new major: move the pin to use it"
            : "move the pin to use it"}
      </span>
      <div>{update.changelog ?? "No changelog."}</div>
      <div className="text-sm">
        Eval change: pass rate {points(update.evalDelta.passRate)}, lift{" "}
        {points(update.evalDelta.lift)}
      </div>
      <div className="mt-1 flex flex-wrap gap-2">
        <Button size="sm" onClick={() => void loadDiff()}>
          Show the diff to {update.semver}
        </Button>
        {mayMove && !update.automatic && (
          <Button size="sm" disabled={pending} onClick={() => onMove(update.semver)}>
            Move pin to {update.semver}
          </Button>
        )}
      </div>
      {typeof diff === "string" && <Notice tone="error">{diff}</Notice>}
      {diff && typeof diff !== "string" && <ReviewDiff diff={diff} />}
    </li>
  );
}

/**
 * Update available (KOBE-337, SK25): what the install runs, each newer version with its
 * changelog, eval delta and file diff, Move pin and Roll back (single audited acts).
 */
export function SkillInstallUpdatesPanel({
  teamId,
  install,
  mayMove,
  pending,
  run,
}: {
  readonly teamId: string;
  readonly install: CatalogInstall;
  readonly mayMove: boolean;
  readonly pending: boolean;
  readonly run: (
    action: () => Promise<ApiResult<SkillInstallResult>>,
    notice: (r: SkillInstallResult) => string,
  ) => Promise<boolean>;
}) {
  const [state, setState] = useState<SkillInstallUpdates | string | null>(null);
  const load = async () => {
    const r = await getSkillInstallUpdates(teamId, install.skillId);
    setState(r.ok ? r.data : r.error.message);
  };
  const act = async (fn: () => Promise<ApiResult<SkillInstallResult>>) => {
    const notice = (r: SkillInstallResult) =>
      r.pinMode === "pinned" && install.pinMode !== "pinned"
        ? `${skillInstallNotice(install.name, r)} It is Pinned there now: switch back to tracking to get updates again.`
        : skillInstallNotice(install.name, r);
    if (await run(fn, notice)) await load();
  };
  return (
    <details onToggle={(e) => (e.currentTarget.open && state === null ? void load() : undefined)}>
      <summary>Updates</summary>
      {state === null && <p role="status">Loading updates…</p>}
      {typeof state === "string" && <Notice tone="error">{state}</Notice>}
      {state && typeof state !== "string" && (
        <div>
          <p>
            Runs {state.running?.semver ?? "nothing (its version can't run)"}; pinned at{" "}
            {state.pinned.semver}.
          </p>
          {state.updates.length === 0 ? (
            <p>No newer version.</p>
          ) : (
            <ul className="list-none ps-0">
              {state.updates.map((u) => (
                <Update
                  key={u.versionId}
                  teamId={teamId}
                  install={install}
                  update={u}
                  mayMove={mayMove}
                  pending={pending}
                  onMove={(v) => void act(() => moveSkillInstallPin(teamId, install.skillId, v))}
                />
              ))}
            </ul>
          )}
          {mayMove && state.rollbackTo && (
            <Button
              size="sm"
              className="mt-2"
              disabled={pending}
              onClick={() => void act(() => rollbackSkillInstall(teamId, install.skillId))}
            >
              Roll back to {state.rollbackTo}
            </Button>
          )}
        </div>
      )}
    </details>
  );
}
