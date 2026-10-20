"use client";

import Link from "next/link";
import {
  getCatalogSkill,
  listCatalog,
  requestEgress,
  type CatalogDetail,
} from "../../lib/skills/catalog-api";
import {
  Badge,
  Button,
  Notice,
  PageHeader,
  Section,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableRowHeader,
} from "../ui/console";
import { Markdown } from "../chat/markdown";
import { useTeamAccess } from "../admin/console-context";
import { MutationStatus } from "../admin/error-notice";
import { DateTime, ResourceView } from "../admin/parts";
import { useMutation, useResource, type Mutation } from "../admin/use-resource";
import { CatalogInstall } from "./catalog-install";
import { CatalogMemberActions } from "./catalog-member";
import { SkillUsagePanel } from "./skill-usage-panel";
import { RetirePanel } from "./retire-panel";
import { catalogHref } from "./catalog-tab";
import { shownCount, shownShare, windowLabel } from "../../lib/skills/catalog-api";
import { TeamStateBadges } from "./catalog-tab";
import { visibleText } from "../../lib/admin/visible-text";

const pct = (v: unknown) => (typeof v === "number" ? `${Math.round(v * 100)}%` : "—");

const SCORE_ROWS: readonly (readonly [string, string, (v: unknown) => string])[] = [
  ["cases", "Cases", (v) => (typeof v === "number" ? String(v) : "—")],
  ["passRateWith", "Pass rate with the skill", pct],
  ["passRateWithout", "Pass rate without it", pct],
  [
    "lift",
    "Lift",
    (v) => (typeof v === "number" ? `${v >= 0 ? "+" : ""}${Math.round(v * 100)} points` : "—"),
  ],
  ["triggerPrecision", "Trigger precision", pct],
  ["triggerRecall", "Trigger recall", pct],
];

/** "needs pypi.org, not enabled here → Request access" (SK25, D28). */
function EgressCheck({
  detail,
  teamId,
  mutation,
}: {
  readonly detail: CatalogDetail;
  readonly teamId: string;
  readonly mutation: Mutation;
}) {
  if (detail.egress.length === 0) return <p>Needs no internet hosts.</p>;
  return (
    <ul className="list-disc ps-6">
      {detail.egress.map((e) => (
        <li key={e.host} className="mt-1">
          Needs <code>{e.host}</code>
          {e.enabledHere ? (
            <Badge tone="done" className="ms-2">
              enabled here
            </Badge>
          ) : e.inCeiling && detail.canRequestEgress ? (
            <>
              {" "}
              — not enabled here{" "}
              <Button
                size="sm"
                disabled={mutation.pending}
                onClick={() =>
                  void mutation.run(
                    () => requestEgress(teamId, e.host),
                    () => `Asked your Team admins to enable ${e.host}.`,
                  )
                }
              >
                Request access to {e.host}
              </Button>
            </>
          ) : e.inCeiling ? (
            " — not enabled here: a Team admin can enable it."
          ) : (
            " — not allowed on this Site: only a Site admin can add it."
          )}
        </li>
      ))}
    </ul>
  );
}

/** The retire panel, with the catalog's other skills as possible replacements (KOBE-340). */
function RetireWithCandidates(props: {
  readonly teamId: string;
  readonly skillId: string;
  readonly name: string;
}) {
  const { state } = useResource(() =>
    listCatalog(props.teamId, { q: "", tag: null, sort: "name" }),
  );
  const candidates =
    state.status === "ready" ? state.data.skills.map((c) => ({ id: c.id, name: c.name })) : [];
  return <RetirePanel skillId={props.skillId} name={props.name} candidates={candidates} />;
}

/**
 * A catalog skill's detail (KOBE-336, SK25): its SKILL.md, files, versions and changelogs, the
 * authoritative scorecard, capabilities with this team's egress check, license, maintainers and
 * the team's agents that use it.
 */
export function CatalogDetailPage({ skillId }: { readonly skillId: string }) {
  const access = useTeamAccess();
  const teamId = access.team.id;
  const mayInstall = access.permissions.includes("team.skills.publish");
  const mayRequire = access.permissions.includes("team.skills.installs.manage");
  const { state, reload } = useResource(() => getCatalogSkill(teamId, skillId));
  const mutation = useMutation();
  return (
    <>
      <p>
        <Link href="/me/skills?tab=catalog" className="underline">
          Back to the catalog
        </Link>
      </p>
      <ResourceView state={state} label="the skill">
        {(d) => (
          <>
            <PageHeader
              title={`${visibleText(d.name)} ${d.latest.semver}`}
              description={visibleText(d.summary)}
            />
            <p className="flex flex-wrap gap-2">
              <TeamStateBadges card={d} />
              {d.topics.map((t) => (
                <Badge key={t}>{t}</Badge>
              ))}
            </p>
            {d.status === "deprecated" && (
              <Notice tone="warn" role="status">
                This skill is deprecated.{" "}
                {d.replacement ? (
                  <>
                    Use{" "}
                    <Link href={catalogHref(d.replacement.id)} className="underline">
                      {visibleText(d.replacement.name)}
                    </Link>{" "}
                    instead.
                  </>
                ) : (
                  "New installs need a Team admin."
                )}
              </Notice>
            )}
            <MutationStatus error={mutation.error} notice={mutation.notice} />
            <CatalogMemberActions detail={d} teamId={teamId} mutation={mutation} onDone={reload} />
            {mayInstall && (
              <CatalogInstall
                detail={d}
                teamId={teamId}
                mayRequire={mayRequire}
                mutation={mutation}
                onDone={reload}
              />
            )}
            <Section title="Usage">
              <p>
                {shownCount(d.teamsInstalled, "team")} installed it
                {d.usage
                  ? `; ${shownCount(d.usage.members, "member")} used it; ${shownShare(d.usage.thumbsUp)}`
                  : ""}
                .
              </p>
              {d.usageWindow && (
                <p className="text-sm text-console-muted">
                  {windowLabel(d.usageWindow)}: the last closed 30-day period; fewer than three
                  other teams or 20 ratings read Few.
                </p>
              )}
              <SkillUsagePanel skillId={d.id} />
            </Section>
            {d.canDeprecate && (
              <Section
                title="Retire versions"
                description="Maintainers deprecate; Site admins also withdraw, revoke and unrevoke."
              >
                <RetireWithCandidates teamId={teamId} skillId={d.id} name={d.name} />
              </Section>
            )}
            <Section title="Capabilities">
              <EgressCheck detail={d} teamId={teamId} mutation={mutation} />
            </Section>
            <Section title="Authoritative scorecard">
              {d.authoritativeScorecard ? (
                <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
                  {SCORE_ROWS.filter(([k]) => k in (d.authoritativeScorecard ?? {})).map(
                    ([k, label, show]) => (
                      <div key={k} className="contents">
                        <dt className="text-console-muted">{label}</dt>
                        <dd className="m-0">{show(d.authoritativeScorecard?.[k])}</dd>
                      </div>
                    ),
                  )}
                </dl>
              ) : (
                <p>No authoritative scorecard for this version.</p>
              )}
            </Section>
            <Section title="SKILL.md">
              {d.skillMd ? <Markdown text={d.skillMd} /> : <p>Not available.</p>}
            </Section>
            <Section title="Versions">
              <Table caption="Versions" hideCaption>
                <TableHead>
                  <TableRow>
                    <TableHeader>Version</TableHeader>
                    <TableHeader>State</TableHeader>
                    <TableHeader>Approved</TableHeader>
                    <TableHeader>Changelog</TableHeader>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {d.versions.map((v) => (
                    <TableRow key={v.id}>
                      <TableRowHeader>{v.semver}</TableRowHeader>
                      <TableCell>{v.state}</TableCell>
                      <TableCell>
                        <DateTime value={v.approvedAt} compact />
                      </TableCell>
                      <TableCell>{v.changelog ?? "—"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Section>
            <Section title="Files">
              <ul className="list-disc ps-6">
                {d.files.map((f) => (
                  <li key={f.path}>
                    <code>{f.path}</code> <span className="text-console-muted">{f.size} bytes</span>
                  </li>
                ))}
              </ul>
            </Section>
            <Section title="About">
              <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
                <dt className="text-console-muted">License</dt>
                <dd className="m-0">{d.license ?? "—"}</dd>
                <dt className="text-console-muted">Maintainers</dt>
                <dd className="m-0">{d.maintainers.join(", ") || "—"}</dd>
                <dt className="text-console-muted">This team&apos;s agents using it</dt>
                <dd className="m-0">{d.agents.map((a) => a.name).join(", ") || "None"}</dd>
              </dl>
            </Section>
          </>
        )}
      </ResourceView>
    </>
  );
}
