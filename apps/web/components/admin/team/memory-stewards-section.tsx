"use client";

import { useState, type FormEvent } from "react";
import {
  grantMemorySteward,
  listMemoryStewards,
  revokeMemorySteward,
  type MemorySteward,
} from "../../../lib/admin/api/team/memory-stewards";
import type { TeamMember } from "../../../lib/admin/api/team/members";
import { roleLabel } from "../../../lib/teams";
import {
  Button,
  Field,
  FormRow,
  Section,
  Select,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableRowHeader,
  eventTrigger,
  useConfirm,
} from "../../ui/console";
import { MutationStatus } from "../error-notice";
import { DateTime, ResourceView } from "../parts";
import { useMutation, useResource } from "../use-resource";

export const WORKSPACE_STEWARD_HINT =
  "Memory stewards curate this workspace's shared memory with the team admins: they add, edit, archive and pin Workspace memories. Any member can be one, whatever their role; contributors and members get no memory rights from their role. Stewards can't send memories to the Site, change memory switches or do anything else a team admin does.";

/**
 * Workspace memory stewards (KOBE-380, SM19) on the Members page: Team admins give and take the
 * grant; it goes with the membership.
 */
export function MemoryStewardsSection({
  teamId,
  members,
}: {
  readonly teamId: string;
  readonly members: readonly TeamMember[];
}) {
  const { state, reload } = useResource(() => listMemoryStewards(teamId));
  const mutation = useMutation();
  const [confirm, confirmDialog] = useConfirm();
  const [giveTo, setGiveTo] = useState("");

  async function give(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const member = members.find((m) => m.userId === giveTo);
    if (!member) return;
    const done = await mutation.run(
      () => grantMemorySteward(teamId, member.userId),
      () => `${member.name} is now a memory steward.`,
    );
    if (done) {
      setGiveTo("");
      reload();
    }
  }

  async function take(steward: MemorySteward, trigger: HTMLElement | null) {
    const yes = await confirm(
      {
        title: `Take memory steward from ${steward.name}?`,
        description: "They can no longer change Workspace memory. What they saved stays.",
        confirmLabel: "Take memory steward",
      },
      trigger,
    );
    if (!yes) return;
    const done = await mutation.run(
      () => revokeMemorySteward(teamId, steward.userId),
      () => `${steward.name} is no longer a memory steward.`,
    );
    if (done) reload();
  }

  return (
    <Section title="Memory stewards" description={WORKSPACE_STEWARD_HINT}>
      <MutationStatus error={mutation.error} notice={mutation.notice} />
      <ResourceView state={state} label="memory stewards">
        {(stewards) => {
          const holders = new Set(stewards.map((s) => s.userId));
          const roles = new Map(members.map((m) => [m.userId, m.role]));
          const candidates = members.filter((m) => !m.deactivated && !holders.has(m.userId));
          return (
            <>
              {stewards.length === 0 ? (
                <p className="text-sm">No memory stewards yet.</p>
              ) : (
                <Table caption="Memory stewards">
                  <TableHead>
                    <TableRow>
                      <TableHeader>Name</TableHeader>
                      <TableHeader>Role</TableHeader>
                      <TableHeader>Since</TableHeader>
                      <TableHeader>
                        <span className="sr-only">Actions</span>
                      </TableHeader>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {stewards.map((s) => {
                      const role = roles.get(s.userId);
                      return (
                        <TableRow key={s.userId}>
                          <TableRowHeader>{s.name}</TableRowHeader>
                          <TableCell>{role ? roleLabel(role) : ""}</TableCell>
                          <TableCell>
                            <DateTime value={s.grantedAt} />
                          </TableCell>
                          <TableCell>
                            <Button
                              size="sm"
                              variant="danger"
                              disabled={mutation.pending}
                              onClick={(e) => void take(s, eventTrigger(e))}
                            >
                              Take memory steward
                              <span className="sr-only"> from {s.name}</span>
                            </Button>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}
              <form onSubmit={(e) => void give(e)} aria-label="Make a memory steward">
                <FormRow>
                  <Field label="Member">
                    <Select required value={giveTo} onChange={(e) => setGiveTo(e.target.value)}>
                      <option value="">Choose a member…</option>
                      {candidates.map((m) => (
                        <option key={m.userId} value={m.userId}>
                          {m.name} ({roleLabel(m.role)})
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Button type="submit" variant="primary" disabled={mutation.pending}>
                    Make memory steward
                  </Button>
                </FormRow>
              </form>
            </>
          );
        }}
      </ResourceView>
      {confirmDialog}
    </Section>
  );
}
