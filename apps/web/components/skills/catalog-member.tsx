"use client";

import { useState, type FormEvent } from "react";
import {
  addForMe,
  blockInTeam,
  removeMyAdd,
  requestForTeam,
  unblockInTeam,
  type CatalogDetail,
  type PinMode,
} from "../../lib/skills/catalog-api";
import { Button, Field, FormRow, Section, Select, eventTrigger, useConfirm } from "../ui/console";
import type { Mutation } from "../admin/use-resource";

export const PIN_LABELS: Readonly<Record<PinMode, string>> = {
  pinned: "Pinned",
  within_major: "Track within major",
  latest: "Track latest",
};
const pinLabel = (p: string) => PIN_LABELS[p as PinMode] ?? p;

interface Props {
  readonly detail: CatalogDetail;
  readonly teamId: string;
  readonly mutation: Mutation;
  readonly onDone: () => void;
}

/**
 * Add for me (KOBE-338, SK25): the skill loads only in this member's runs in this team, at the
 * version and pin they choose. Only approved versions (a deprecated one is a Team admin's
 * override); hidden while the team switch is off, and for a skill the team blocked or installed
 * Required or Hidden. The server checks every rule again.
 */
function AddForMe({ detail, teamId, mutation, onDone }: Props) {
  const approved = detail.versions.filter((v) => v.state === "approved");
  const mine = detail.state.myAdd ?? null;
  const [version, setVersion] = useState(mine?.semver ?? approved[0]?.semver ?? "");
  const [pinMode, setPinMode] = useState<PinMode>(
    (mine?.pinMode as PinMode | undefined) ?? "within_major",
  );
  const installedAs = detail.state.installed?.access;
  if (installedAs === "required" || installedAs === "hidden") return null;
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const done = await mutation.run(
      () => addForMe(teamId, detail.id, { version, pinMode }),
      (r) =>
        r.runs
          ? `Added ${detail.name} for you: your runs here load ${r.runs}.`
          : `Added ${detail.name} for you, but no version of it can run now.`,
    );
    if (done) onDone();
  };
  const remove = async () => {
    const done = await mutation.run(
      () => removeMyAdd(teamId, detail.id),
      () => `Removed ${detail.name} from your runs here.`,
    );
    if (done) onDone();
  };
  return (
    <Section
      title="Add for me"
      description="Loads only in your own runs in this team. A version change reaches your next run."
    >
      {mine && (
        <p>
          You added {mine.semver} ({pinLabel(mine.pinMode)}) for your own runs here.{" "}
          <Button size="sm" disabled={mutation.pending} onClick={() => void remove()}>
            Remove my add
          </Button>
        </p>
      )}
      {detail.membersMayAdd === false ? (
        <p>This team doesn&apos;t let members add catalog skills for themselves.</p>
      ) : approved.length > 0 ? (
        <form onSubmit={(e) => void submit(e)} aria-label="Add for me">
          <FormRow>
            <Field label="Version">
              <Select value={version} onChange={(e) => setVersion(e.target.value)}>
                {approved.map((v) => (
                  <option key={v.id} value={v.semver}>
                    {v.semver}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Pin">
              <Select value={pinMode} onChange={(e) => setPinMode(e.target.value as PinMode)}>
                {Object.entries(PIN_LABELS).map(([k, label]) => (
                  <option key={k} value={k}>
                    {label}
                  </option>
                ))}
              </Select>
            </Field>
            <Button type="submit" variant="primary" disabled={mutation.pending}>
              {mine ? "Save my add" : "Add for me"}
            </Button>
          </FormRow>
        </form>
      ) : null}
    </Section>
  );
}

/** A Team admin's Block or Unblock of the skill in this team (KOBE-338). */
function BlockButton({ detail, teamId, mutation, onDone }: Props) {
  const [confirm, confirmDialog] = useConfirm();
  if (detail.state.blocked)
    return (
      <Button
        disabled={mutation.pending}
        onClick={() =>
          void mutation
            .run(
              () => unblockInTeam(teamId, detail.id),
              () => `Unblocked ${detail.name} in this team.`,
            )
            .then((done) => done && onDone())
        }
      >
        Unblock in this team
      </Button>
    );
  if (detail.state.installed)
    return (
      <span className="text-console-muted">Uninstall it in the team console to block it.</span>
    );
  const block = async (trigger: HTMLElement | null) => {
    const yes = await confirm(
      {
        title: `Block ${detail.name} in this team?`,
        description:
          "Members' own adds of it are removed, and nobody here can add or install it until a Team admin unblocks it.",
        confirmLabel: "Block",
      },
      trigger,
    );
    if (!yes) return;
    const done = await mutation.run(
      () => blockInTeam(teamId, detail.id),
      (r) =>
        `Blocked ${detail.name} in this team; removed ${r.addsRemoved} member add${r.addsRemoved === 1 ? "" : "s"}.`,
    );
    if (done) onDone();
  };
  return (
    <>
      <Button
        variant="danger"
        disabled={mutation.pending}
        onClick={(e) => void block(eventTrigger(e))}
      >
        Block in this team
      </Button>
      {confirmDialog}
    </>
  );
}

/** The member's part of a catalog skill's detail: Add for me, Request for team, Block. */
export function CatalogMemberActions(props: Props) {
  const { detail, teamId, mutation } = props;
  if (detail.state.blocked)
    return (
      <Section title="Blocked in this team">
        <p>A Team admin blocked this skill in the team: nobody here can add or install it.</p>
        {detail.canBlock && <BlockButton {...props} />}
      </Section>
    );
  return (
    <>
      <AddForMe {...props} />
      {!detail.state.installed && (
        <p>
          <Button
            disabled={mutation.pending}
            onClick={() =>
              void mutation.run(
                () => requestForTeam(teamId, detail.id),
                (r) =>
                  r.alreadyRequested
                    ? `You already asked for ${detail.name} today.`
                    : `Asked your Team admins to install ${detail.name} for the team.`,
              )
            }
          >
            Request for team
          </Button>
        </p>
      )}
      {detail.canBlock && (
        <p>
          <BlockButton {...props} />
        </p>
      )}
    </>
  );
}
