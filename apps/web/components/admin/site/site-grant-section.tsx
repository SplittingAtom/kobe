"use client";

import { useState, type FormEvent } from "react";
import type { ApiResult } from "../../../lib/api/client";
import {
  giveSiteGrant,
  listSiteGrants,
  takeSiteGrant,
  type SiteGrantHolder,
} from "../../../lib/admin/api/site/roles";
import type { SiteGrant } from "../../../lib/admin/nav/types";
import { listUsers, type SiteUser } from "../../../lib/admin/api/site/users";
import {
  Badge,
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
import { useSiteAccess } from "../console-context";
import { MutationStatus } from "../error-notice";
import { ResourceView } from "../parts";
import { useMutation, useResource } from "../use-resource";

interface Loaded {
  readonly grants: readonly SiteGrantHolder[];
  readonly users: readonly SiteUser[];
}

async function load(grant: SiteGrant): Promise<ApiResult<Loaded>> {
  const [grants, users] = await Promise.all([listSiteGrants(), listUsers()]);
  if (!grants.ok) return grants;
  if (!users.ok) return users;
  const holders = grants.data.filter((g) => g.grant === grant);
  return { ok: true, status: 200, data: { grants: holders, users: users.data } };
}

/** The words of one grant's section. */
export interface SiteGrantCopy {
  readonly grant: SiteGrant;
  /** Section title and table caption, plural ("Skill reviewers"). */
  readonly title: string;
  readonly hint: string;
  /** The grant's name in sentences and buttons ("Skill reviewer"). */
  readonly name: string;
  /** The picker's label ("Reviewer"). */
  readonly pickerLabel: string;
  /** What taking it does, for the confirmation. */
  readonly takeDescription: string;
  /** Offer Site admins and the Owner too (the grant adds something they lack). */
  readonly offerAdmins: boolean;
}

/**
 * One site grant beside the role ladder (KOBE-331 Skill reviewer, KOBE-380 Site memory steward),
 * given and taken by the Owner or a Site admin. Admins may hold one too when it adds something
 * (`offerAdmins`), given by another admin; oneself only on a single-admin Site, shown
 * "self-granted".
 */
export function SiteGrantSection({ copy }: { readonly copy: SiteGrantCopy }) {
  const me = useSiteAccess().user.id;
  const { state, reload } = useResource(() => load(copy.grant));
  const mutation = useMutation();
  const [confirm, confirmDialog] = useConfirm();
  const [giveTo, setGiveTo] = useState("");

  async function give(e: FormEvent<HTMLFormElement>, users: readonly SiteUser[]) {
    e.preventDefault();
    const user = users.find((u) => u.id === giveTo);
    if (!user) return;
    const done = await mutation.run(
      () => giveSiteGrant(user.id, copy.grant),
      () => `${user.name} is now a ${copy.name}.`,
    );
    if (done) {
      setGiveTo("");
      reload();
    }
  }

  async function take(holder: SiteGrantHolder, trigger: HTMLElement | null) {
    const yes = await confirm(
      {
        title: `Take ${copy.name} from ${holder.name}?`,
        description: copy.takeDescription,
        confirmLabel: `Take ${copy.name}`,
      },
      trigger,
    );
    if (!yes) return;
    const done = await mutation.run(
      () => takeSiteGrant(holder.userId, copy.grant),
      () => `${holder.name} is no longer a ${copy.name}.`,
    );
    if (done) reload();
  }

  return (
    <Section title={copy.title} description={copy.hint}>
      <MutationStatus error={mutation.error} notice={mutation.notice} />
      <ResourceView state={state} label={copy.title}>
        {({ grants, users }) => {
          const holders = new Set(grants.map((g) => g.userId));
          const admins = users.filter((u) => u.deactivatedAt === null && u.siteRole !== "user");
          const soleAdmin = admins.length === 1 && admins[0]?.id === me;
          const candidates = users.filter(
            (u) =>
              u.deactivatedAt === null &&
              !holders.has(u.id) &&
              (copy.offerAdmins || u.siteRole === "user") &&
              (u.id !== me || soleAdmin),
          );
          return (
            <>
              {grants.length > 0 && (
                <Table caption={copy.title}>
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
                        <TableRowHeader>
                          {g.name}
                          {g.grantedBy === g.userId && (
                            <Badge tone="attention" className="ms-2">
                              self-granted
                            </Badge>
                          )}
                        </TableRowHeader>
                        <TableCell>{g.email}</TableCell>
                        <TableCell>
                          <Button
                            size="sm"
                            variant="danger"
                            disabled={mutation.pending}
                            onClick={(e) => void take(g, eventTrigger(e))}
                          >
                            Take {copy.name}
                            <span className="sr-only"> from {g.name}</span>
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
              <form onSubmit={(e) => void give(e, users)} aria-label={`Give ${copy.name}`}>
                <FormRow>
                  <Field label={copy.pickerLabel}>
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
                    Make {copy.name}
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
