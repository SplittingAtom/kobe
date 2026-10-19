"use client";

import {
  getSkillUsage,
  windowLabel,
  type Shown,
  type SiteSkillUsage,
} from "../../lib/skills/catalog-api";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableRowHeader,
} from "../ui/console";
import { useResource } from "../admin/use-resource";

const count = (v: Shown) => (v === "few" ? "Few" : String(v));
const share = (v: Shown) => (v === "few" ? "Few" : `${Math.round(v * 100)}%`);

const COLUMNS = [
  ["teamsRunning", "Teams running it", count],
  ["members", "Members", count],
  ["runs", "Runs", count],
  ["thumbsUp", "Thumbs up", share],
] as const;

function Panel({ usage }: { readonly usage: SiteSkillUsage }) {
  const t = usage.totals;
  return (
    <div className="mt-2">
      <p className="text-sm text-console-muted">
        {windowLabel(usage.window)}, refreshed nightly. Numbers from fewer than three teams (other
        than yours) or 20 ratings read Few; a column that would give one away is withheld.
      </p>
      <Table caption="Site-wide usage">
        <TableHead>
          <TableRow>
            <TableHeader>Teams installed</TableHeader>
            <TableHeader>Members</TableHeader>
            <TableHeader>Runs</TableHeader>
            <TableHeader>Thumbs up</TableHeader>
            <TableHeader>Default opt-outs</TableHeader>
          </TableRow>
        </TableHead>
        <TableBody>
          <TableRow>
            <TableCell>{count(t.teamsInstalled)}</TableCell>
            <TableCell>{count(t.members)}</TableCell>
            <TableCell>{count(t.runs)}</TableCell>
            <TableCell>{share(t.thumbsUp)}</TableCell>
            <TableCell>{count(t.optOuts)}</TableCell>
          </TableRow>
        </TableBody>
      </Table>
      {usage.versions.length > 0 && (
        <Table caption="Usage by version">
          <TableHead>
            <TableRow>
              <TableHeader>Version</TableHeader>
              {COLUMNS.map(([k, label]) => (
                <TableHeader key={k}>{label}</TableHeader>
              ))}
            </TableRow>
          </TableHead>
          <TableBody>
            {usage.versions.map((v, i) => (
              <TableRow key={v}>
                <TableRowHeader>{v || "Unknown"}</TableRowHeader>
                {COLUMNS.map(([k, , show]) => {
                  const col = usage.perVersion[k];
                  const cell = col?.[i];
                  return (
                    <TableCell key={k}>
                      {col === null || cell === undefined ? "Withheld" : show(cell)}
                    </TableCell>
                  );
                })}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

/**
 * Site-wide usage of a catalog skill per version, with Default opt-outs (KOBE-339, SK26), for its
 * maintainers and Site admins: shown only when the server answers (nothing at all otherwise).
 */
export function SkillUsagePanel({ skillId }: { readonly skillId: string }) {
  const { state } = useResource(() => getSkillUsage(skillId));
  if (state.status !== "ready") return null;
  return <Panel usage={state.data} />;
}
