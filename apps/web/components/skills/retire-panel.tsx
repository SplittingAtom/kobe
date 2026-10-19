"use client";

import { useState } from "react";
import {
  actsFor,
  deprecateSkill,
  listRetirable,
  undeprecateSkill,
  retireVersion,
  type RetireAct,
  type Retired,
} from "../../lib/skills/retire-api";
import {
  Button,
  Field,
  FormRow,
  Select,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableRowHeader,
  TextInput,
  eventTrigger,
  useConfirm,
} from "../ui/console";
import { MutationStatus } from "../admin/error-notice";
import { ResourceView } from "../admin/parts";
import { useMutation, useResource } from "../admin/use-resource";

const LABEL: Readonly<Record<RetireAct, string>> = {
  deprecate: "Deprecate",
  undeprecate: "Undo deprecation",
  withdraw: "Withdraw",
  revoke: "Revoke",
  unrevoke: "Unrevoke",
};
const DONE: Readonly<Record<RetireAct, string>> = {
  deprecate: "deprecated",
  undeprecate: "approved again",
  withdraw: "withdrawn",
  revoke: "revoked",
  unrevoke: "available again",
};
const EFFECT: Readonly<Record<RetireAct, string>> = {
  undeprecate: "It installs again without a warning; its banners go. Nobody is notified.",
  deprecate: "New installs need a Team admin's override; existing installs keep it with a banner.",
  withdraw:
    "No new installs or pins. Tracking installs move to the next version in their range; pinned installs keep it until a Team admin chooses a version.",
  revoke:
    "It stops at once in every team: its hash goes on the blocklist and the next fetch fails. Tracking installs move within their range only if a version is left there. Everyone with it is told, in-app and by email.",
  unrevoke: "It returns to the state it had before the revoke, and loads again where it is pinned.",
};

const told = (r: Retired) =>
  r.notified ? "; the teams and people with it were told." : "; the notices could not be sent.";

/**
 * Deprecate, Withdraw, Revoke and Unrevoke a catalog skill's versions, and deprecate the whole
 * skill (KOBE-340, SK31): Site admins see every act a version's state allows, maintainers
 * Deprecate only (the server decides). Each act is confirmed with what it does.
 */
export function RetirePanel({
  skillId,
  name,
  candidates,
}: {
  readonly skillId: string;
  readonly name: string;
  /** Other catalog skills that can be named as the replacement. */
  readonly candidates: readonly { readonly id: string; readonly name: string }[];
}) {
  const { state, reload } = useResource(() => listRetirable(skillId));
  const mutation = useMutation();
  const [confirm, confirmDialog] = useConfirm();
  const [note, setNote] = useState("");
  const [replacement, setReplacement] = useState("");

  async function run(semver: string, act: RetireAct, trigger: HTMLElement | null) {
    const yes = await confirm(
      {
        title: `${LABEL[act]} ${name} ${semver}?`,
        description: EFFECT[act],
        confirmLabel: LABEL[act],
      },
      trigger,
    );
    if (!yes) return;
    const done = await mutation.run(
      () => retireVersion(skillId, semver, act, note),
      (r) => `${name} ${semver} is ${DONE[act]}${told(r)}`,
    );
    if (done) {
      setNote("");
      reload();
    }
  }

  async function deprecateAll(trigger: HTMLElement | null) {
    const yes = await confirm(
      {
        title: `Deprecate ${name}?`,
        description:
          "Every version installs only with a Team admin's override; every installer is told.",
        confirmLabel: "Deprecate",
      },
      trigger,
    );
    if (!yes) return;
    const done = await mutation.run(
      () => deprecateSkill(skillId, replacement || null),
      (r) => `${name} is deprecated${told(r)}`,
    );
    if (done) reload();
  }

  return (
    <div className="mt-2" role="group" aria-label={`Retire ${name}`}>
      <MutationStatus error={mutation.error} notice={mutation.notice} />
      <ResourceView state={state} label="versions">
        {(data) => (
          <>
            <FormRow>
              <Field label="Note (optional)">
                <TextInput
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  maxLength={2000}
                />
              </Field>
            </FormRow>
            <Table caption={`Versions of ${name}`} hideCaption>
              <TableHead>
                <TableRow>
                  <TableHeader>Version</TableHeader>
                  <TableHeader>State</TableHeader>
                  <TableHeader>
                    <span className="sr-only">Actions</span>
                  </TableHeader>
                </TableRow>
              </TableHead>
              <TableBody>
                {data.versions.map((v) => (
                  <TableRow key={v.semver}>
                    <TableRowHeader>{v.semver}</TableRowHeader>
                    <TableCell>{v.suspended ? `${v.state}, suspended` : v.state}</TableCell>
                    <TableCell className="whitespace-nowrap">
                      {actsFor(v.state, data.mayRetire).map((a) => (
                        <Button
                          key={a}
                          variant={a === "revoke" ? "danger" : "ghost"}
                          disabled={mutation.pending}
                          onClick={(e) => void run(v.semver, a, eventTrigger(e))}
                        >
                          {LABEL[a]}
                        </Button>
                      ))}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {data.status === "deprecated" && (
              <p>
                <Button
                  disabled={mutation.pending}
                  aria-label={`Undo the deprecation of ${name}`}
                  onClick={() =>
                    void mutation
                      .run(
                        () => undeprecateSkill(skillId),
                        (r) => `${name} is ${r.state} again.`,
                      )
                      .then((done) => done && reload())
                  }
                >
                  Undo the skill's deprecation
                </Button>
              </p>
            )}
            {data.status !== "deprecated" && data.status !== "archived" && (
              <FormRow>
                <Field label="Replacement">
                  <Select value={replacement} onChange={(e) => setReplacement(e.target.value)}>
                    <option value="">None</option>
                    {candidates
                      .filter((c) => c.id !== skillId)
                      .map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                  </Select>
                </Field>
                <Button
                  disabled={mutation.pending}
                  aria-label={`Deprecate ${name}`}
                  onClick={(e) => void deprecateAll(eventTrigger(e))}
                >
                  Deprecate the skill
                </Button>
              </FormRow>
            )}
          </>
        )}
      </ResourceView>
      {confirmDialog}
    </div>
  );
}
