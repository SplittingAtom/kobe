"use client";

/**
 * Workspace settings → Storage and history (Workspaces GV2, GV3, MT3; KOBE-581 on KOBE-579's
 * `GET/PUT /v1/team/storage`): bytes and objects for the workspace, each project and each
 * member's files, the limits in force, and the team admin's settings: how long project history
 * is kept, how many projects one member may have mounted, and the object budget.
 */
import { useState, type FormEvent } from "react";
import { getTeamStorage, putTeamStorage } from "../../../lib/admin/api/team/storage";
import { listTeamMembers } from "../../../lib/admin/api/team/members";
import {
  bytesOrDash,
  countOrDash,
  historyKeepText,
  type HistoryKeep,
  type StorageFigures,
  type StorageSettingsChange,
  type TeamStorage,
} from "../../../lib/projects/storage";
import {
  Button,
  Field,
  FormRow,
  PageHeader,
  Section,
  Select,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableRowHeader,
  TextInput,
} from "../../ui/console";
import { useTeamAccess } from "../console-context";
import { MutationStatus } from "../error-notice";
import { ResourceView } from "../parts";
import { useMutation, useResource } from "../use-resource";

function FigureCells({ of }: { readonly of: StorageFigures }) {
  return (
    <>
      <TableCell numeric>{bytesOrDash(of.liveBytes)}</TableCell>
      <TableCell numeric>{bytesOrDash(of.historyBytes)}</TableCell>
      <TableCell numeric>{countOrDash(of.liveObjects)}</TableCell>
      <TableCell numeric>{countOrDash(of.historyObjects)}</TableCell>
    </>
  );
}

export function TeamStoragePage() {
  const teamId = useTeamAccess().team.id;
  const { state } = useResource(() => getTeamStorage(teamId));
  const [saved, setSaved] = useState<TeamStorage | null>(null);
  return (
    <>
      <PageHeader
        title="Storage and history"
        description="What the workspace stores, in bytes and in objects (every stored file is one object, so many small files cost more than their size suggests). Project files and their history count against the workspace, attributed to the project; working copies count in their member's files."
      />
      <ResourceView state={state} label="storage">
        {(loaded) => {
          const s = saved ?? loaded;
          return (
            <>
              <Usage storage={s} />
              <Settings key={JSON.stringify(settingsOf(loaded))} storage={s} onSaved={setSaved} />
            </>
          );
        }}
      </ResourceView>
    </>
  );
}

function Usage({ storage: s }: { readonly storage: TeamStorage }) {
  const teamId = useTeamAccess().team.id;
  const roster = useResource(() => listTeamMembers(teamId));
  const nameOf = (userId: string) =>
    (roster.state.status === "ready"
      ? roster.state.data.find((m) => m.userId === userId)?.name
      : undefined) ?? `User ${userId.slice(0, 8)}`;
  return (
    <Section
      title="Usage"
      description={`Used ${bytesOrDash(s.usedBytes)} of ${bytesOrDash(s.quotaBytes ?? s.defaultQuotaBytes)}, ${countOrDash(s.usedObjects)} of ${countOrDash(s.maxObjects ?? s.defaultMaxObjects)} objects.`}
    >
      <Table caption="Storage by workspace and project">
        <TableHead>
          <TableRow>
            <TableHeader>Where</TableHeader>
            <TableHeader numeric>Live bytes</TableHeader>
            <TableHeader numeric>History bytes</TableHeader>
            <TableHeader numeric>Live objects</TableHeader>
            <TableHeader numeric>History objects</TableHeader>
          </TableRow>
        </TableHead>
        <TableBody>
          <TableRow>
            <TableRowHeader>Projects together</TableRowHeader>
            <FigureCells of={s} />
          </TableRow>
          {s.projects.map((p) => (
            <TableRow key={p.projectId}>
              <TableRowHeader>
                {p.name}
                <div className="text-sm font-normal text-console-muted">
                  {p.commits === 1 ? "1 commit" : `${p.commits} commits`}
                </div>
              </TableRowHeader>
              <FigureCells of={p} />
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {s.scratchspaces.length > 0 && (
        <Table caption="Members' files">
          <TableHead>
            <TableRow>
              <TableHeader>Member</TableHeader>
              <TableHeader numeric>Bytes</TableHeader>
              <TableHeader numeric>Files</TableHeader>
              <TableHeader numeric>Objects</TableHeader>
            </TableRow>
          </TableHead>
          <TableBody>
            {s.scratchspaces.map((m) => (
              <TableRow key={m.userId}>
                <TableRowHeader>{nameOf(m.userId)}</TableRowHeader>
                <TableCell numeric>{bytesOrDash(m.liveBytes)}</TableCell>
                <TableCell numeric>{countOrDash(m.liveFiles)}</TableCell>
                <TableCell numeric>{countOrDash(m.objects)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Section>
  );
}

interface Draft {
  readonly keep: HistoryKeep["mode"];
  readonly n: string;
  readonly mounts: string;
  /** "" = the site default. */
  readonly maxObjects: string;
}

const settingsOf = (s: TeamStorage): Draft => ({
  keep: s.historyKeep.mode,
  n: s.historyKeep.mode === "all" ? "" : String(s.historyKeep.n),
  mounts: String(s.maxMountedPerMember),
  maxObjects: s.maxObjects === null ? "" : String(s.maxObjects),
});

const whole = (text: string): number | null => (/^\d+$/.test(text.trim()) ? Number(text) : null);

/** What changed, or a reason the draft cannot be sent. */
function changeOf(draft: Draft, s: TeamStorage): StorageSettingsChange | string {
  const before = settingsOf(s);
  const n = whole(draft.n);
  if (draft.keep !== "all" && (n === null || n < 1)) return "Enter how many commits or days.";
  if (draft.keep === "commits" && n !== null && n > s.historyMaxCommits) {
    return `Keep at most ${s.historyMaxCommits} commits.`;
  }
  const mounts = whole(draft.mounts);
  if (mounts === null || mounts < 1 || mounts > 1000) return "Mounted projects: 1 to 1000.";
  const objects = draft.maxObjects.trim() === "" ? null : whole(draft.maxObjects);
  if (draft.maxObjects.trim() !== "" && objects === null) return "Object budget: a whole number.";
  const keep: HistoryKeep =
    draft.keep === "all" ? { mode: "all" } : { mode: draft.keep, n: n ?? 1 };
  return {
    ...(draft.keep !== before.keep || draft.n !== before.n ? { historyKeep: keep } : {}),
    ...(draft.mounts !== before.mounts ? { maxMountedPerMember: mounts } : {}),
    ...(draft.maxObjects !== before.maxObjects ? { maxObjects: objects } : {}),
  };
}

function Settings({
  storage: s,
  onSaved,
}: {
  readonly storage: TeamStorage;
  onSaved(next: TeamStorage): void;
}) {
  const teamId = useTeamAccess().team.id;
  const mutation = useMutation();
  const [draft, setDraft] = useState<Draft>(() => settingsOf(s));
  const set = (change: Partial<Draft>) => setDraft((d) => ({ ...d, ...change }));
  const change = changeOf(draft, s);
  const problem = typeof change === "string" ? change : null;
  const empty = typeof change !== "string" && Object.keys(change).length === 0;

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (typeof change === "string" || empty) return;
    await mutation.run(
      () => putTeamStorage(teamId, change),
      (next) => {
        onSaved(next);
        return "Saved.";
      },
    );
  }

  return (
    <Section
      title="Limits and history"
      description={`Now: ${historyKeepText(s.historyKeep, s.historyMaxCommits)}; at most ${s.maxMountedPerMember} projects mounted per member. Pruning never removes a project's latest files, a working copy's base or anything under a legal hold.`}
    >
      <MutationStatus error={mutation.error} notice={mutation.notice} />
      <form aria-label="Storage settings" onSubmit={(e) => void submit(e)}>
        <FormRow className="mt-0">
          <Field label="Project history kept">
            <Select
              value={draft.keep}
              onChange={(e) => set({ keep: e.target.value as HistoryKeep["mode"] })}
            >
              <option value="all">Every commit</option>
              <option value="commits">The newest N commits</option>
              <option value="days">The last N days</option>
            </Select>
          </Field>
          {draft.keep !== "all" && (
            <Field label={draft.keep === "commits" ? "Commits to keep" : "Days to keep"}>
              <TextInput
                inputMode="numeric"
                value={draft.n}
                onChange={(e) => set({ n: e.target.value })}
              />
            </Field>
          )}
        </FormRow>
        <FormRow>
          <Field label="Projects mounted per member">
            <TextInput
              inputMode="numeric"
              value={draft.mounts}
              onChange={(e) => set({ mounts: e.target.value })}
            />
          </Field>
          <Field
            label="Object budget"
            hint={`Empty: the site default (${countOrDash(s.defaultMaxObjects)} objects).`}
          >
            <TextInput
              inputMode="numeric"
              value={draft.maxObjects}
              onChange={(e) => set({ maxObjects: e.target.value })}
            />
          </Field>
          <Button
            type="submit"
            variant="primary"
            disabled={mutation.pending || problem !== null || empty}
          >
            Save settings
          </Button>
        </FormRow>
        {problem && (
          <p role="alert" className="m-0 text-sm text-console-danger">
            {problem}
          </p>
        )}
      </form>
    </Section>
  );
}
