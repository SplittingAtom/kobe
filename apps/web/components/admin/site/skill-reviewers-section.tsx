"use client";

import { useState, type FormEvent } from "react";
import type { ApiResult } from "../../../lib/api/client";
import {
  giveSkillReviewer,
  listSiteGrants,
  takeSkillReviewer,
  type SiteGrantHolder,
} from "../../../lib/admin/api/site/roles";
import { listUsers, type SiteUser } from "../../../lib/admin/api/site/users";
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
import { ResourceView } from "../parts";
import { useMutation, useResource } from "../use-resource";

interface Loaded {
  readonly grants: readonly SiteGrantHolder[];
  readonly users: readonly SiteUser[];
}

async function load(): Promise<ApiResult<Loaded>> {
  const [grants, users] = await Promise.all([listSiteGrants(), listUsers()]);
  if (!grants.ok) return grants;
  if (!users.ok) return users;
  return { ok: true, status: 200, data: { grants: grants.data, users: users.data } };
}

export const REVIEWER_HINT =
  "Skill reviewers see the Registry queue and may claim, comment, approve, request changes and reject. They can't block, withdraw, revoke, tag Default or change Registry settings. Kobe adds them to the Registry team.";

/**
 * Skill reviewers (KOBE-331, SK22): a grant beside the role ladder, given and taken by the Owner
 * or a Site admin. Site admins review anyway, so they are not offered.
 */
export function SkillReviewersSection() {
  const { state, reload } = useResource(load);
  const mutation = useMutation();
  const [confirm, confirmDialog] = useConfirm();
  const [giveTo, setGiveTo] = useState("");

  async function give(e: FormEvent<HTMLFormElement>, users: readonly SiteUser[]) {
    e.preventDefault();
    const user = users.find((u) => u.id === giveTo);
    if (!user) return;
    const done = await mutation.run(
      () => giveSkillReviewer(user.id),
      () => `${user.name} is now a Skill reviewer.`,
    );
    if (done) {
      setGiveTo("");
      reload();
    }
  }

  async function take(holder: SiteGrantHolder, trigger: HTMLElement | null) {
    const yes = await confirm(
      {
        title: `Take Skill reviewer from ${holder.name}?`,
        description: "They lose the Registry queue at once. They stay in the Registry team.",
        confirmLabel: "Take Skill reviewer",
      },
      trigger,
    );
    if (!yes) return;
    const done = await mutation.run(
      () => takeSkillReviewer(holder.userId),
      () => `${holder.name} is no longer a Skill reviewer.`,
    );
    if (done) reload();
  }

  return (
    <Section title="Skill reviewers" description={REVIEWER_HINT}>
      <MutationStatus error={mutation.error} notice={mutation.notice} />
      <ResourceView state={state} label="Skill reviewers">
        {({ grants, users }) => {
          const holders = new Set(grants.map((g) => g.userId));
          const candidates = users.filter(
            (u) => u.deactivatedAt === null && u.siteRole === "user" && !holders.has(u.id),
          );
          return (
            <>
              {grants.length > 0 && (
                <Table caption="Skill reviewers">
                  <TableHead>
                    <TableRow>
                      <TableHeader>Name</TableHeader>
                      <TableHeader>Email</TableHeader>
                      <TableHeader>
                        <span className="sr-only">Actions</span>
                      </TableHeader>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {grants.map((g) => (
                      <TableRow key={g.userId}>
                        <TableRowHeader>{g.name}</TableRowHeader>
                        <TableCell>{g.email}</TableCell>
                        <TableCell>
                          <Button
                            size="sm"
                            variant="danger"
                            disabled={mutation.pending}
                            onClick={(e) => void take(g, eventTrigger(e))}
                          >
                            Take Skill reviewer
                            <span className="sr-only"> from {g.name}</span>
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
              <form onSubmit={(e) => void give(e, users)} aria-label="Give Skill reviewer">
                <FormRow>
                  <Field label="Reviewer">
                    <Select required value={giveTo} onChange={(e) => setGiveTo(e.target.value)}>
                      <option value="">Choose a user…</option>
                      {candidates.map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.name} ({u.email})
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Button type="submit" variant="primary" disabled={mutation.pending}>
                    Make Skill reviewer
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
